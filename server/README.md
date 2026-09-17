# Smart Lock Backend Server

Self-hosted API + MQTT ingest with lowdb persistence and SSE dashboard.

## Requirements
- Node.js 18+ (developed on 24)
- MQTT broker reachable by server and ESP32 (e.g., Mosquitto)

## Setup
```bash
cd server
cp .env.example .env   # then fill in the required secrets
npm install
npm start
```

The server starts **fail-closed**: if `DASH_TOKEN` or `CAM_UPLOAD_TOKEN` is
missing, empty, or whitespace-only, startup is refused with a non-zero exit
code and no listener is opened. Generate tokens with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Defaults:
- API: http://localhost:8080
- MQTT broker: mqtt://localhost:1883
- Database: ./data.db (lowdb JSON store)

## Authentication

Every route under `/api/` requires a credential. The only exception is
`GET /api/health`, which is reachable anonymously so it can serve as a liveness
probe.

| Route | Credential | Header |
| --- | --- | --- |
| All `/api/*` except health and cam/upload | `DASH_TOKEN` | `Authorization: Bearer <token>` (`X-Access-Token` accepted as a legacy alias) |
| `POST /api/cam/upload` | `CAM_UPLOAD_TOKEN` | `Authorization: Bearer <token>` or `x-cam-token: <token>` |

Notes:
- An absent or incorrect credential returns **401**, never 403. The dashboard
  treats a 401 as "session invalid" and returns the user to the login state.
- `DASH_TOKEN` cannot upload camera frames, and `CAM_UPLOAD_TOKEN` cannot read
  `/api/state`. The two roles are deliberately separate.
- Tokens are compared in constant time.
- `/cam/latest.jpg` is a public static asset (it is rendered as an `<img> src`
  by the dashboard) and is not authenticated.

## API
- `GET /api/health` - service and MQTT status (public)
- `GET /api/state` - latest device state
- `GET /api/events?limit=50` - recent events
- `POST /api/command` - JSON `{ "command": "LOCK|UNLOCK|SILENCE" }`
- `POST /api/pin` - JSON `{ "pin": "1069" }`
- `GET /api/cam/status` - last camera snapshot metadata
- `GET /api/stream` - SSE feed for live updates
- Static dashboard at `/` (served from public/)

## Camera
- `POST /api/cam/upload` with `image/jpeg` body, authenticated with
  `CAM_UPLOAD_TOKEN`
- `POST /api/cam/capture` to pull a snapshot from ESP32-CAM
- `GET /api/cam/stream` proxies the MJPEG stream
- Latest snapshot served from `/cam/latest.jpg`

## Streaming
The dashboard does not use the browser `EventSource` API, because that API
cannot send an `Authorization` header. It reads `/api/stream` with `fetch()`
and parses the SSE frames itself, sending `Authorization: Bearer`. On a dropped
connection it reconnects with bounded exponential backoff capped at 30s; on a
401 it clears the stored token and shows the login view.

## Rate limiting
`express-rate-limit` guards the API. `DISABLE_RATE_LIMIT=1` is an emergency
escape hatch that is honoured only when `NODE_ENV` is `development` or `test`;
in every other environment the limiter always runs and the flag is ignored
(with a startup warning).

## Topics
- Ingest: `smartlock/state`, `smartlock/alert`, `smartlock/metric`, `smartlock/command_ack`
- Camera ingest (MQTT chunks): `smartlock/cam/meta`, `smartlock/cam/chunk`
- Commands (outbound): `smartlock/command`

## Tests
```bash
npm test
```
The suite imports the Express app directly. An inert MQTT stub is used in that
mode, so **no broker connection is ever opened** and no real credential is read
from disk: placeholder tokens are generated per run with `crypto.randomBytes`.
The same applies to the ad-hoc scripts in `test/`, which additionally point
`MQTT_BROKER` at an unreachable loopback port.

## Telegram
Set these in `.env` (do not hardcode in firmware):
- `TG_BOT_TOKEN`
- `TG_CHAT_ID`

## Notes
- Broker credentials can be set via environment variables
- `CAM_SNAPSHOT_URL` and `CAM_STREAM_URL` must use `https://` when set
