# Codebase Inventory — Smart Door Lock

Audit date: 2026-09-16
Baseline commit: `b0893d7` (branch `audit/full-codebase-baseline-20260916`)

## 1. Component map

| # | Component | Location | Language / Runtime | Status in baseline |
|---|-----------|----------|--------------------|--------------------|
| 1 | Lock firmware (main MCU) | `firmware/` | C / ESP-IDF v5.x | Present, builds NOT verified |
| 2 | Camera firmware | `firmware/esp32cam/` | C++ / Arduino core + PlatformIO | Present, builds NOT verified |
| 3 | Backend + dashboard | `server/` | Node.js 18 (ESM) + Express | Present, boots, HTTP 200 |
| 4 | Dashboard SPA | `server/public/` | Vanilla HTML/CSS/JS | Present, not built/tested |
| 5 | Docs / diagrams | `Keypad_Authentication_State_Diagram.svg`, `Smart_Lock_Full_System_Flowchart.svg`, `README.md` | SVG / Markdown | Present |
| 6 | Deployment config | `server/render.yaml`, `server/netlify.toml` | YAML / TOML | Present, NOT deploy-verified |
| 7 | Docs/audit output | `docs/audit/` | Markdown | Created by this audit |

## 2. Directory responsibilities

```
/
├── firmware/                     ESP32 lock controller (ESP-IDF)
│   ├── include/
│   │   ├── app_config.h          Secret-bearing config (UNTRACKED after baseline)
│   │   ├── app_config_example.h  Sanitized template (added by audit)
│   │   ├── app_config_local.example.h
│   │   ├── servo_control.h
│   │   └── ca_cert.h             Declares cert; NOT included by any source
│   ├── src/
│   │   ├── main.c                Wi-Fi, MQTT, keypad, sensors, OTA, state
│   │   └── servo_control.c       LEDC PWM servo driver
│   ├── platformio.ini            PlatformIO project for lock firmware
│   ├── CMakeLists.txt            ESP-IDF build definition
│   ├── partitions.csv            Partition table
│   └── esp32cam/                 Separate ESP32-CAM companion project
│       ├── src/main.cpp          Camera + MQTT chunking + Telegram
│       └── platformio.ini
├── server/
│   ├── src/index.js              Express API + MQTT client + SSE + lowdb
│   ├── public/                   Dashboard SPA + camera snapshots
│   │   ├── index.html            ~1160 lines, single-file dashboard
│   │   └── cam/latest.jpg        Camera snapshot artifact
│   ├── package.json              Scripts: start only
│   ├── .env.example              Sanitized env template (present)
│   ├── .env                      LOCAL ONLY — never tracked
│   ├── render.yaml               Render web service deploy
│   └── netlify.toml              Static deploy of public/
├── docs/audit/                   This audit output
└── .gitignore                    Root ignore rules
```

## 3. Technologies and detected versions

| Area | Technology | Version evidence |
|------|-----------|------------------|
| Lock firmware | ESP-IDF C | `esp_https_ota.h`, `mqtt_client.h`, CMake build, `partitions.csv` |
| Camera firmware | Arduino-ESP32 + PlatformIO | `platformio.ini` board `esp32cam`, framework `arduino` |
| Camera MQTT | `PubSubClient` | `#include <PubSubClient.h>` |
| Runtime | Node.js | `.env.example` states Node 18 |
| Web framework | express | `package.json` |
| Realtime | Server-Sent Events | `/api/stream`, `EventSource` in dashboard |
| DB | lowdb (JSON file store) | `db.data.events`, `db.write()` |
| Auth | static shared tokens | `DASH_TOKEN`, `ACCESS_TOKEN` (env), `API_KEY` (device) |
| Rate limiting | express-rate-limit | `package.json`, `/api/*` limiter |
| Process mgmt | none (single node) | no PM2/supervisor config |

Exact dependency versions come from `server/package-lock.json` (created by `npm ci` during the audit — generated artifact, not committed).

## 4. Build / test commands (discovered, not invented)

| Component | Command | Result this audit |
|-----------|---------|-------------------|
| Lock firmware | `pio run -d firmware` (or `idf.py build`) | NOT RUN — toolchain absent |
| Camera firmware | `pio run -d firmware/esp32cam` | NOT RUN — toolchain absent |
| Server deps | `npm ci` (in `server/`) | PASS (7 vulns found, see audit) |
| Server syntax | `node --check src/index.js` | PASS |
| Server boot | `node src/index.js` + `GET /api/health` | PASS — HTTP 200 |
| Server lint | n/a — no `lint` script in package.json | NOT PRESENT |
| Server unit tests | n/a — no `test` script, no test files | NOT PRESENT |
| Frontend build | n/a — no bundler, plain HTML | NOT PRESENT |
| Mobile app | n/a — no mobile directory | NOT PRESENT |

## 5. Missing components (relative to a production smart-lock system)

1. **Mobile application** — none present, though the README describes app-style control.
2. **Database migrations** — lowdb JSON file only; no schema, no migrations, no indexes.
3. **Test suites** — zero unit/integration/e2e tests anywhere in the repo.
4. **CI/CD** — no `.github/`, no pipeline definitions.
5. **Hardware documentation** — no schematic, PCB, or bill of materials. `README.md` references `CIRCUIT_DIAGRAM.md` and `LICENSE`, neither of which exists in the workspace.
6. **User accounts / multi-tenancy** — single shared static token; no users, roles, or device ownership.
7. **MQTT broker config** — broker is external; no provisioning, ACL, or topic-authorization artifacts.
8. **Backup/restore** — no strategy for `data.db`/`data.json`.
9. **OTA signing artifacts** — OTA URL is empty; no signed-image policy.

## 6. Repository topology note

The workspace has two remotes and one nested repository. Full detail is in
`AUDIT_REPORT.md` (GOV-01) and `SYSTEM_ARCHITECTURE.md` §6.

- `origin` → `github.com/prince4331/iotlabesp` (default `master`) — holds the
  full local tree *including* live credentials in `firmware/include/app_config.h`.
- `smart` → `github.com/prince4331/smart-door-lock` (default `main`) — held
  only the server/dashboard subtree before this audit.
- `server/` contains its own `.git` directory (the smart-door-lock working
  clone) which is **not** ignored by the root `.gitignore`. This audit added
  `server/.git/` to the root ignore rules.
