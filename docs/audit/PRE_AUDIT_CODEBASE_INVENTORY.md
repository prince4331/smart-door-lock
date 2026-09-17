# PRE_AUDIT_CODEBASE_INVENTORY

Machine-readable structural inventory of the local workspace at baseline commit `b6a1247` on branch `baseline/full-project-pre-audit`.

## Project Components

- Backend HTTP + MQTT server
- Browser dashboard (static SPA)
- ESP32 lock firmware (ESP-IDF / FreeRTOS)
- ESP32-CAM firmware (Arduino / PlatformIO)
- Documentation and diagrams
- Deployment configuration

## Directory Structure

```
D:\My_projects\IOT_Project\
├── .git/
├── .openclaude/
├── .vscode/
├── docs/
│   └── audit/
├── firmware/
│   ├── .pio/                         # generated PlatformIO build artifacts
│   ├── .vscode/
│   ├── esp32cam/
│   │   ├── .pio/                     # generated PlatformIO build artifacts
│   │   └── src/
│   ├── include/
│   └── src/
├── server/
│   ├── node_modules/                  # generated dependencies
│   ├── public/
│   ├── src/
│   └── test/
├── Keypad_Authentication_State_Diagram.svg
├── README.md
└── Smart_Lock_Full_System_Flowchart.svg
```

## Languages / Frameworks

- Node.js (ESM) + Express
- lowdb (JSON file store)
- MQTT.js
- Vanilla HTML/CSS/JS (dashboard)
- C (ESP-IDF / FreeRTOS)
- C++ (Arduino framework)
- PlatformIO
- CMake
- Markdown / SVG documentation

## Main Entry Points

- `server/src/index.js` — backend server entrypoint
- `server/public/index.html` — dashboard entrypoint
- `firmware/src/main.c` — ESP32 lock firmware entrypoint
- `firmware/esp32cam/src/main.cpp` — ESP32-CAM firmware entrypoint

## Firmware Projects

- `firmware/` — ESP-IDF lock controller project
  - `platformio.ini`
  - `CMakeLists.txt`
  - `sdkconfig.esp32dev`
  - `src/main.c`
  - `src/servo_control.c`
  - `include/app_config_example.h`
  - `include/app_config_local.example.h`
  - `include/servo_control.h`
  - `include/ca_cert.h`
- `firmware/esp32cam/` — PlatformIO ESP32-CAM project
  - `platformio.ini`
  - `src/main.cpp`

## Server Components

- Express HTTP server
- CORS middleware
- Morgan request logger
- express-rate-limit
- lowdb JSON persistence
- MQTT client
- SSE endpoint (`/api/stream`)
- Authenticated REST endpoints:
  - `GET /api/health`
  - `GET /api/state`
  - `GET /api/events`
  - `POST /api/command`
  - `GET /api/cam/latest`
  - `GET /api/cam/status`
  - `POST /api/cam/upload`
  - `GET /api/settings/telegram`
  - `POST /api/settings/telegram`
  - `POST /api/settings/telegram/test`
- Static asset serving (`server/public/`)

## Dashboard Components

- Single-page HTML application
- Bearer token login flow
- Hold-to-unlock interaction
- Door state display
- Event log
- Camera snapshot display
- Presence settings UI
- Telegram settings UI
- SSE event consumption via `fetch()` + `ReadableStream`

## Communication Protocols Observed

- HTTP/1.1 (REST API)
- Server-Sent Events (SSE)
- MQTT over TCP/TLS
- WiFi STA and AP mode (ESP32 provisioning)

## Configuration Sources

- `server/.env` — local runtime environment (ignored, contains live secrets)
- `server/.env.example` — tracked sanitized template
- `firmware/include/app_config.h` — local firmware secrets (ignored, contains live secrets)
- `firmware/include/app_config_example.h` — tracked sanitized template
- `firmware/include/app_config_local.example.h` — tracked local-pin template
- `firmware/platformio.ini` — PlatformIO build configuration
- `firmware/esp32cam/platformio.ini` — ESP32-CAM PlatformIO configuration
- `firmware/sdkconfig.esp32dev` — ESP-IDF sdkconfig
- `firmware/partitions.csv` — ESP-IDF partition table

## Test Locations

- `server/test/security.test.mjs` — Node built-in test runner suite
- `server/test/dashboard-phase0.mjs` — standalone dashboard probe
- `server/test/probe-phase0.mjs` — standalone startup/auth probe
- `server/test/verify-phase0.mjs` — full acceptance verifier

## Build Commands Found

- `npm start` — start backend (server/)
- `npm test` — run backend test suite (server/)
- `node test/verify-phase0.mjs` — run acceptance verifier (server/)
- `python -m platformio run` — build ESP32 lock firmware (firmware/)
- `python -m platformio run` — build ESP32-CAM firmware (firmware/esp32cam/)
- `idf.py build` — ESP-IDF build alternative (firmware/)

## Deployment Files

- `server/render.yaml` — Render deployment configuration
- `server/netlify.toml` — Netlify deployment configuration

## Data Storage

- `server/data.db` — lowdb JSON database (ignored)
- `server/data/cam/` — runtime camera snapshots (ignored)
- NVS/Preferences — ESP32 non-volatile storage for Wi-Fi credentials, setup code, lock state

## External Integrations

- MQTT broker (configurable URI, username, password)
- Telegram Bot API (backend-owned encrypted delivery)
- NTP servers:
  - `pool.ntp.org`
  - `time.google.com`
- OTA update endpoint (configurable URL)

## Files Excluded for Security

- `server/.env` — contains live MQTT credentials, DASH_TOKEN, Telegram bot token, Telegram chat ID
- `firmware/include/app_config.h` — contains live Wi-Fi SSID/password, MQTT credentials, broker URI, default PIN
- `server/node_modules/` — third-party dependencies
- `firmware/.pio/` — PlatformIO build artifacts
- `firmware/esp32cam/.pio/` — PlatformIO build artifacts
- `server/data.db` — local database file
- `server/data/` — runtime camera snapshot directory
