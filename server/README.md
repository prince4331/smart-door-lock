# Smart Lock Backend Server

Self-hosted Node/Express backend with MQTT ingest, private camera storage, an authenticated dashboard, and backend-owned Telegram delivery.

## Authentication model

`DASH_TOKEN` is the single shared administrator credential. Its holder can administer the dashboard, including Telegram settings and capture requests. There are no user accounts, sessions, roles, or viewer permissions in the current model. WebAuthn/passkeys are a future upgrade after user accounts and server-side roles exist.

Every `/api/*` route except `GET /api/health` requires `DASH_TOKEN`. The canonical header is `Authorization: Bearer <token>`; the legacy `X-Access-Token` alias is retained for existing clients. Missing or incorrect credentials return 401.

## Setup

```bash
cd server
cp .env.example .env
npm install
npm start
```

Set at least:

- `DASH_TOKEN`: a unique administrator token.
- `SETTINGS_ENCRYPTION_KEY`: at least 32 random bytes, kept out of source and lowdb.
- `MQTT_BROKER`, `MQTT_USERNAME`, and `MQTT_PASSWORD`: local deployment values.

The backend validates required secrets before starting its listener and external connections. Telegram bot token and chat ID are configured through the authenticated dashboard settings endpoints and are encrypted at rest with AES-256-GCM. Do not put production credentials in `.env.example`, source, documentation, or firmware. Rotate any credentials previously exposed in repository history.

## API

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /api/health` | Public liveness probe | Backend and MQTT health |
| `GET /api/state` | `DASH_TOKEN` | Latest lock and sensor state |
| `GET /api/events?limit=50` | `DASH_TOKEN` | Recent persisted events |
| `POST /api/command` | `DASH_TOKEN` | Authenticated lock/device command; publishes to `smartlock/command` |
| `POST /api/cam/capture` | `DASH_TOKEN` | Manual capture request translated to the backend-owned MQTT camera command |
| `GET /api/cam/status` | `DASH_TOKEN` | Latest camera metadata |
| `GET /api/cam/latest` | `DASH_TOKEN` | Protected persisted JPEG; never a public static asset |
| `GET /api/stream` | `DASH_TOKEN` | Authenticated SSE updates |
| `GET /api/settings/telegram` | `DASH_TOKEN` | Masked Telegram configuration state |
| `PUT /api/settings/telegram` | `DASH_TOKEN` | Validate, encrypt, and save Telegram settings |
| `DELETE /api/settings/telegram` | `DASH_TOKEN` | Remove stored Telegram settings |
| `POST /api/settings/telegram/test` | `DASH_TOKEN` | Send a harmless test message |

`POST /api/pin` is not part of the current API. The camera firmware does not use an HTTP upload, snapshot, or stream URL; camera media follows the MQTT command flow described below.

## Camera flow

1. The authenticated dashboard or presence logic asks the backend for a capture.
2. The backend publishes `CAPTURE` with an event ID and timestamp to `smartlock/cam/command`.
3. The ESP32-CAM captures once, rejects duplicate event IDs, enforces its cooldown, and publishes `smartlock/cam/meta` plus `smartlock/cam/chunk`.
4. The backend reassembles the JPEG into private storage and broadcasts an authenticated camera event. The dashboard refreshes through `/api/cam/latest`.
5. Telegram delivery, when enabled, is performed once by the backend for that event ID. A Telegram failure is recorded in sanitized form and does not block dashboard delivery.

## Telegram settings

Telegram credentials are backend-owned. The settings endpoints are rate-limited, validate token and chat-ID formats, validate proposed credentials with a mocked or controlled Telegram check before saving, and return no complete bot token. Stored ciphertext includes its nonce/IV and authentication tag. Decrypted values are never logged.

## MQTT topics

- Lock ingest: `smartlock/state`, `smartlock/alert`, `smartlock/metric`, `smartlock/command_ack`
- Lock commands: `smartlock/command`
- Camera command: `smartlock/cam/command`
- Camera ingest: `smartlock/cam/meta`, `smartlock/cam/chunk`

Presence-setting changes use the authenticated device command/acknowledgement path. The dashboard shows pending, acknowledged, failed, and offline states rather than treating an unacknowledged value as active.

## Offline limitation

Dashboard unlock, provisioning requests, presence-setting changes, and camera commands require the backend and MQTT path. They are not queued as offline electronic unlock. Local fire auto-unlock and forced-entry safety behavior remain available independently of dashboard connectivity.

## Verification status

This README describes the requested feature architecture. It does not claim a backend test, firmware build, browser run, or hardware test result; record actual verification output separately.
