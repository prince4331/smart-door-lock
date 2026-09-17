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

**Configuration is loaded once, then validated.** The local `.env` is read by
`dotenv` exactly once at startup — values already present in the process
environment win, so the file only fills gaps — and only then is the resulting
effective configuration checked. This order is what makes the workflow above
work: the tokens come from the copied file, not from the parent shell. If
`DASH_TOKEN` or `CAM_UPLOAD_TOKEN` is missing, empty, whitespace-only, or
shorter than 16 characters, startup is refused with a non-zero exit code and
no listener, MQTT client, camera, or Telegram connection is created. Generate
tokens with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

An alternate environment file may be selected with `DOTENV_CONFIG_PATH`
(absolute or relative to the server directory).

Defaults:
- API: http://localhost:8080
- MQTT broker: mqtt://localhost:1883
- Database: ./data.db (lowdb JSON store)
- Camera snapshots: ./data/cam/latest.jpg (outside the public web root;
  configurable with `CAM_STORAGE_DIR`)

## Authentication

Every route under `/api/` requires a credential. The only exception is
`GET /api/health`, which is reachable anonymously so it can serve as a liveness
probe.

| Route | Credential | Header |
| --- | --- | --- |
| All `/api/*` except health and cam/upload | `DASH_TOKEN` | `Authorization: Bearer <token>` (`X-Access-Token` accepted as a legacy alias) |
| `POST /api/cam/upload` | `CAM_UPLOAD_TOKEN` | `Authorization: Bearer <token>` or `x-cam-token: <token>` |
| `GET /api/cam/latest` | `DASH_TOKEN` | `Authorization: Bearer <token>` |

Notes:
- An absent or incorrect credential returns **401**, never 403. The dashboard
  treats a 401 as "session invalid" and returns the user to the login state.
- `DASH_TOKEN` cannot upload camera frames, and `CAM_UPLOAD_TOKEN` cannot read
  `/api/state` or `/api/cam/latest`. The two roles are deliberately separate.
- Tokens are compared in constant time.
- Camera snapshots are **not** static assets. They are stored outside the
  public web root and served only by the authenticated `GET /api/cam/latest`
  route with `Cache-Control: no-store, private`; the legacy `/cam/latest.jpg`
  path returns 404.

## API
- `GET /api/health` - service and MQTT status (public; the only anonymous API)
- `GET /api/state` - latest device state
- `GET /api/events?limit=50` - recent events
- `POST /api/command` - JSON `{ "command": "LOCK|UNLOCK|SILENCE" }`
- `POST /api/pin` - JSON `{ "pin": "1069" }`
- `GET /api/cam/status` - last camera snapshot metadata
- `GET /api/cam/latest` - the persisted snapshot itself (`image/jpeg`, private)
- `GET /api/stream` - SSE feed for live updates
- Static dashboard at `/` (served from public/)

## Camera
- `POST /api/cam/upload` with `image/jpeg` body, authenticated with
  `CAM_UPLOAD_TOKEN`, writes to the private snapshot store
- `POST /api/cam/capture` to pull a snapshot from ESP32-CAM
- `GET /api/cam/stream` proxies the MJPEG stream
- `GET /api/cam/latest` serves the persisted snapshot; 404 when none exists.
  The dashboard fetches it with the dashboard token and renders it via a
  short-lived object URL, so the token never appears in the URL, the DOM, or
  a log line.

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
Every runtime artifact — database, snapshot store, generated environment files
— is written to a per-run temporary directory removed at teardown, so a test
run cannot dirty the working tree.

The same applies to the ad-hoc scripts in `test/`, which additionally point
`MQTT_BROKER` at an unreachable loopback port. Run the full acceptance suite
with `node test/verify-phase0.mjs`; it ends by asserting that the working tree
is clean, so a probe that polluted it fails the suite.

## Telegram
Set these in `.env` (do not hardcode in firmware):
- `TG_BOT_TOKEN`
- `TG_CHAT_ID`

## Notes
- Broker credentials can be set via environment variables
- `CAM_SNAPSHOT_URL` and `CAM_STREAM_URL` must use `https://` when set
