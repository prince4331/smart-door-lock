# Smart Lock Backend Server

Self-hosted API + MQTT ingest with SQLite persistence and SSE dashboard.

## Requirements
- Node.js 18+
- MQTT broker reachable by server and ESP32 (e.g., Mosquitto)

## Setup
```bash
cd server
cp .env.example .env   # adjust values
npm install
npm start
```

Defaults:
- API: http://localhost:8080
- MQTT broker: mqtt://localhost:1883
- Database: ./data.db (SQLite, WAL mode)

## API
- `GET /api/health` - service and MQTT status
- `GET /api/state` - latest device state
- `GET /api/events?limit=50` - recent events
- `POST /api/command` - JSON `{ "command": "LOCK|UNLOCK|SILENCE" }`
- `GET /api/stream` - SSE feed for live updates
- Static dashboard at `/` (served from public/)

## Camera
- `POST /api/cam/upload` with `image/jpeg` body
- `POST /api/cam/capture` to pull a snapshot from ESP32-CAM
- `GET /api/cam/stream` proxies MJPEG stream
- Latest snapshot served from `/cam/latest.jpg`

## PIN Management
- `POST /api/pin` JSON `{ "pin": "1069" }` (requires access token)

## Topics
- Ingest: `smartlock/state`, `smartlock/alert`, `smartlock/metric`, `smartlock/command_ack`
- Camera ingest (MQTT chunks): `smartlock/cam/meta`, `smartlock/cam/chunk`
- Commands (outbound): `smartlock/command`

## Telegram
Set these in `.env` (do not hardcode in firmware):
- `TG_BOT_TOKEN`
- `TG_CHAT_ID`

## Notes
- Broker credentials can be set via environment variables
- Replace SQLite with Postgres/MySQL by swapping the DB layer if needed
- Add TLS at the broker or use an mqtts URI with proper certificates
