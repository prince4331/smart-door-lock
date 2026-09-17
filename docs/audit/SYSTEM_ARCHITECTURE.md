# System Architecture — Smart Door Lock

Audit date: 2026-09-16
Baseline commit: `b0893d7` (branch `audit/full-codebase-baseline-20260916`)

Trust-boundary and flow descriptions were updated 2026-09-17 to match the
Phase 0 containment work on branch `fix/phase-0-security-containment`, and
updated again the same day for the corrective review pass: persisted camera
media is no longer a static asset, and the environment file is resolved,
loaded once, and validated before any service is created.

This document describes what is **implemented**, not what is documented. For
documented-vs-implemented gaps see `FEATURE_COMPLETENESS_MATRIX.md`.

## 1. Implemented component map

```
                     ┌──────────────────────────────────────────────┐
                     │  Browser dashboard                            │
                     │  server/public/index.html (static SPA)        │
                     └───────┬───────────────────────┬──────────────┘
                             │ HTTP (REST)             │ SSE over fetch()
                             │ Authorization: Bearer   │ Authorization: Bearer
                             ▼                         ▼
                     ┌──────────────────────────────────────────────┐
                     │  Node/Express backend                         │
                     │  server/src/index.js                          │
                     │  ├─ REST: state, events, pin, command, cam     │
                     │  ├─ MQTT client (publisher + subscriber)       │
                     │  ├─ lowdb JSON store (data.db / data.json)     │
                     │  ├─ SSE broadcaster                            │
                     │  └─ Telegram alert sender                      │
                     └───────┬───────────────────────┬──────────────┘
                             │                        │
              MQTT (TLS 8883) │                        │ HTTPS fetch
                             ▼                        ▼
   ┌──────────────────────────────┐        ┌────────────────────────────┐
   │  ESP32 lock controller        │        │  ESP32-CAM companion        │
   │  firmware/src/main.c          │        │  firmware/esp32cam/         │
   │  ├─ Wi-Fi STA                 │        │  ├─ Wi-Fi STA                │
   │  ├─ MQTT pub/sub              │        │  ├─ MQTT TLS + chunks        │
   │  ├─ Keypad (4x4)              │        │  ├─ Telegram photo send      │
   │  ├─ PIR / reed / fire sensors │        │  └─ Snapshot on trigger      │
   │  ├─ Servo (LED PWM)           │        └────────────────────────────┘
   │  ├─ Buzzer / LED              │
   │  ├─ NVS persistence           │
   │  └─ HTTPS OTA                 │
   └──────────────────────────────┘
                             │
                             ▼
                     Physical lock (servo-actuated)
```

## 2. Data and command flow

### 2.1 Unlock command flow (verified by reading and by runtime probe)

1. Dashboard collects a shared access token from the user, stored in
   `sessionStorage` (`public/index.html:571`, `:586`).
2. `POST /api/command` with an `Authorization: Bearer <token>` header
   (the legacy `X-Access-Token` header is still accepted).
3. The `/api/*` router middleware runs `authenticateAccessToken`, which
   compares the token to `DASH_TOKEN` using SHA-256 plus
   `crypto.timingSafeEqual`, so an unknown credential cannot be
   distinguished from a missing one.
4. On success the server builds
   `"<COMMAND>|<nonce>|<timestamp>"` where nonce is
   `Date.now()*1000 + random*1000` and timestamp is Unix seconds
   (`server/src/index.js:549`-`550`), then publishes to `smartlock/command`
   with QoS 1.
5. Firmware receives the message (`firmware/src/main.c:806`) and calls
   `handle_command()` (`:555`), which first calls `validate_command()`
   (`:516`).
6. `validate_command()` splits on `|`, requires command/nonce/timestamp, and
   rejects if `|now - ts| > CMD_TIMESTAMP_WINDOW_SEC` (300 s, defined in
   `app_config.h`). **It does not record the nonce**, so the same command can
   be replayed within the 300-second window (`firmware/src/main.c:516`-`553`).
7. Firmware publishes an ACK to `smartlock/command_ack`
   (`firmware/src/main.c:474`-`487`), which the server stores and forwards to
   the dashboard over SSE.
8. Dashboard confirms the state change by re-reading `/api/state` and by
   receiving the ACK over SSE.

### 2.2 Telemetry / state flow

- Firmware publishes `smartlock/state` (lock/alarm/door/uptime/rssi/heap) and
  `smartlock/metric` periodically (`firmware/src/main.c:447`, `:509`).
- Server persists each into `db.data.events` capped at 500 entries
  (`server/src/index.js:242`, `:271`) and broadcasts over SSE.
- Dashboard renders device metrics and an event/history table.

### 2.3 Camera flow

- ESP32-CAM publishes JPEG frames in chunks to `smartlock/cam/chunk` with a
  metadata message to `smartlock/cam/meta` (`firmware/esp32cam/src/main.cpp`).
- Server reassembles and persists the latest frame to
  `server/data/cam/latest.jpg` (`CAM_STORAGE_DIR`, default `./data/cam`) —
  **outside** the public static root, untracked — and exposes
  `/api/cam/status`, `/api/cam/stream` (proxy to camera), `/api/cam/capture`,
  and `GET /api/cam/latest`.
- The dashboard never names the snapshot file. It fetches
  `/api/cam/latest` with `Authorization: Bearer`, turns the response into a
  blob object URL, revokes the previous URL, and points the `<img>` at it;
  a 401 returns the user to the login state and a 404 shows the placeholder.
- Phase 0 corrective pass: this file used to live at
  `server/public/cam/latest.jpg` and was served anonymously by
  `express.static`. The legacy path now returns a hard 404 — anonymous *and*
  authenticated — and the snapshot is reachable only through authenticated
  `GET /api/cam/latest`. The route additionally resolves the file with
  `fs.realpathSync` and rejects anything that does not resolve to
  `<camDir>/latest.jpg`, so traversal and symlink substitution both fail
  closed.
- Lock firmware can trigger a capture via a UART byte to the camera
  (`CAM_UART_TRIGGER_BYTE` in `app_config.h`).

### 2.4 Alert flow

- Firmware publishes `smartlock/alert` on tamper, wrong PIN, PIR dwell, or
  door-held-open (`firmware/src/main.c:460`-`472`).
- Server normalizes the payload (`normalizeAlertPayload`, `:153`), stores it,
  broadcasts it, and optionally sends a Telegram photo (`handleAlertSideEffects`).

## 3. Trust boundaries

| # | Boundary | Mechanism (as implemented) | Verdict |
|---|----------|---------------------------|---------|
| TB1 | Internet → Backend | Static shared `DASH_TOKEN`; constant-time compare; startup resolves the env file, loads it once, then validates and exits before the listener, MQTT, camera, Telegram or database is touched if the token is missing, empty or under 16 characters | Single shared secret, no users |
| TB3a | Internet → persisted camera media | Snapshot written outside the public static root; served only by authenticated `GET /api/cam/latest`; the removed public path returns a hard 404 | Closed by the corrective review (was SEC-09) |
| TB2 | Backend → Device | MQTT over TLS 8883; command carries nonce+timestamp | Replay window 300 s, nonce not tracked |
| TB3 | Browser → Backend | `Authorization: Bearer` on every `/api/*` route except `/api/health` | Closed by Phase 0 (was SEC-04) |
| TB4 | Camera → Backend | `CAM_UPLOAD_TOKEN` as Bearer or `X-Cam-Token` on `/api/cam/upload`; mandatory | Closed by Phase 0 (was optional and fail-open) |
| TB5 | Device → Broker | MQTT username/password from `app_config.h` | Shared across all devices (see SEC-02) |
| TB6 | Backend → Telegram | Bot token in firmware + server env | Token committed publicly (SEC-01) |
| TB7 | Browser ↔ SSE | `/api/stream` requires `Authorization: Bearer`; the browser client uses `fetch()`, not `EventSource` | Closed by Phase 0 (was SEC-04) |

## 4. External services and dependencies

| Service | Used by | Purpose | Credential location |
|---------|---------|---------|---------------------|
| HiveMQ Cloud MQTT broker | Lock firmware, camera firmware, server | Command/telemetry transport | `app_config.h` + `esp32cam/src/main.cpp` (committed) + `server/.env` (untracked) |
| Telegram Bot API | Camera firmware, server | Alert photos | `esp32cam/src/main.cpp` (committed) + `server/.env` |
| Camera HTTP snapshot/stream | Server | `/api/cam/capture`, `/api/cam/stream` | `CAM_SNAPSHOT_URL` / `CAM_STREAM_URL` env |
| Render | Backend | PaaS deploy | `server/render.yaml` |
| Netlify | Dashboard static | Static deploy | `server/netlify.toml` |
| SNTP (`pool.ntp.org`, `time.google.com`) | Lock firmware | Command timestamp validation | none |

## 5. Hardware / software integration points

| Interface | Firmware | Notes |
|-----------|----------|-------|
| Servo PWM | `servo_control.c` (LEDC) | Pin/timing from `app_config.h` |
| Keypad 4x4 | `main.c` sensor task | Debounce + lockout after `WRONG_ATTEMPTS_MAX` |
| PIR motion | GPIO input | `PIR_DEBOUNCE_THRESHOLD` |
| Reed switch | GPIO input | Door open/closed state |
| Fire sensor | GPIO input | Alarm path |
| Buzzer / LED | GPIO output | Alarm + status indication |
| Camera UART | UART trigger byte | Cross-MCU capture trigger |

Hardware pins are defined in `app_config.h` and `servo_control.h`. Per the
audit ground rules, **no pin assignment was modified**.

## 6. Repository and history topology (as found)
The workspace is one Git repository at the project root with two remotes:

- `origin` → `github.com/prince4331/iotlabesp`, default branch `master`.
  Local `master` (`61785c7` → later `b0893d7`) is a fast-forward descendant of
  this remote's history. **This remote already contains the full tree
  including committed credentials** — it is the exposure source (SEC-01).
- `smart` → `github.com/prince4331/smart-door-lock`, default branch `main`,
  also has an identical `master` branch. Before this audit it contained only
  the `server/` subtree (35 files). Local history and `smart` history share
  **no common ancestor** (`git merge-base` fails).

Additionally, `server/` is itself a Git working clone (nested `.git`) of
`smart-door-lock`. Before this audit, the root `.gitignore` did **not** ignore
`server/.git/`, so a naive `git add .` at the root would have committed the
nested repository's internals. This audit added `server/.git/` to the root
`.gitignore` without modifying the nested repository.

Integration strategy is documented in `AUDIT_REPORT.md` §"Integration
strategy" and in the baseline commit message.
