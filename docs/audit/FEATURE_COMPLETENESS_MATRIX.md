# Feature Completeness Matrix — Smart Door Lock

Audit date: 2026-09-16
Baseline commit: `b0893d7` (branch `audit/full-codebase-baseline-20260916`)

Status legend:

- **Complete** — implemented and evidenced in code
- **Partial** — implemented but with material gaps
- **Missing** — not implemented
- **Broken** — implemented but does not work as intended
- **Not verified** — present but could not be confirmed by build or runtime

## Firmware — lock controller (`firmware/src/main.c`, `servo_control.c`)

| Feature | Status | Evidence / Notes |
|---|---|---|
| Wi-Fi station connect | Complete | `main.c` Wi-Fi init + reconnect handling |
| MQTT publish/subscribe | Complete | topics in `app_config.h`; TLS 8883 broker |
| TLS certificate validation | Not verified | `esp_crt_bundle.h` included but no `esp_crt_bundle_attach()` found (AUDIT REL-05) |
| Keypad PIN entry | Complete | 4x4 matrix, debounce, `WRONG_ATTEMPTS_MAX` 3 |
| Keypad lockout | Partial | 30 s fixed lockout, no backoff/alert (REL-03) |
| PIN storage | Partial | NVS `NVS_KEY_PASSWORD`; stored/compared in plaintext (SEC-05) |
| Relay/servo lock actuation | Complete | `servo_control.c` LEDC PWM |
| Servo repeated-actuation protection | Missing | no rate limit on actuation (REL-04) |
| PIR motion sensing | Complete | task + debounce threshold |
| Reed switch door sensing | Complete | door state in published state |
| Fire/gas sensor input | Complete | alarm path present |
| Buzzer/LED alarm | Complete | alarm state + silence command |
| NVS lock-state persistence | Partial | best-effort write, no checksum/two-slot (REL-01) |
| Safe default lock state on boot | Not verified | boot reads NVS; fail-safe default not evidenced |
| Watchdog / crash recovery | Missing | no task WDT registration (REL-02) |
| Brownout / power-loss handling | Not verified | no explicit policy in source |
| Network-loss behavior | Partial | reconnect logic present; no offline access rules |
| OTA update | Partial | `esp_https_ota.h` included but `OTA_URL` empty (REL-02) |
| OTA rollback | Missing | no anti-rollback policy |
| Firmware version reporting | Complete | `fw_version` in metrics topic |
| Tamper detection | Partial | PIR/reed tamper windows in `app_config.h` |
| Camera capture trigger | Complete | UART trigger byte to ESP32-CAM |
| Auto-lock timer | Complete | `AUTO_LOCK_MS` |
| Night/home/away modes | Complete | `MODE_HOME/AWAY/NIGHT` commands |
| Command timestamp window | Partial | 300 s window, nonce not tracked → replayable (SEC-06) |
| Factory reset | Missing | no factory-reset path found |

## Firmware — ESP32-CAM (`firmware/esp32cam/src/main.cpp`)

| Feature | Status | Evidence / Notes |
|---|---|---|
| Camera initialization | Complete | `esp_camera.h`, board `esp32cam` |
| MQTT TLS connect | Complete | HiveMQ 8883, `WiFiClientSecure` |
| TLS root CA | Not verified | cert constant present; pinning behavior unconfirmed |
| Frame chunking over MQTT | Complete | `smartlock/cam/meta` + `smartlock/cam/chunk` |
| Telegram photo alert | Complete | bot token + chat id (committed — SEC-01) |
| Snapshot on trigger | Complete | subscribes to trigger topic |
| Motion-triggered capture | Complete | cooldown `CAM_COOLDOWN_MS` |
| Wi-Fi provisioning | Missing | hardcoded SSID/password (SEC-01) |

## Backend (`server/src/index.js`)

| Feature | Status | Evidence / Notes |
|---|---|---|
| REST: health | Complete | `/api/health` 200, public by design (verified runtime) |
| REST: state read | Complete | authenticated as of Phase 0 (was SEC-04) |
| REST: event history | Complete | authenticated as of Phase 0 (was SEC-04) |
| REST: send command | Complete | token-gated, fail-closed startup as of Phase 0 (was SEC-03) |
| REST: set PIN | Partial | token-gated; PIN relayed in plaintext over MQTT |
| SSE live stream | Complete | authenticated on connect as of Phase 0 (was SEC-04) |
| Camera status/stream/capture/upload | Partial | upload now requires mandatory `CAM_UPLOAD_TOKEN` (Phase 0); camera URLs must be `https://` (SEC-07) |
| Rate limiting | Complete | only `/api/health` exempt; `DISABLE_RATE_LIMIT` dev/test-only (was API-03) |
| Constant-time token compare | Complete | SHA-256 both sides then `crypto.timingSafeEqual` |
| User registration/login | Missing | single static token |
| Password hashing | Missing | no user store |
| JWT / refresh tokens | Missing | static shared token |
| Session revocation | Missing | no sessions |
| Roles / permissions | Missing | no admin/viewer distinction |
| Per-device ownership | Missing | shared fleet credentials (SEC-02) |
| Brute-force lockout on token | Missing | rate limit only (API-03) |
| Command idempotency | Missing | duplicates double-actuate (API-01) |
| Nonce ledger / replay prevention | Missing | nonce generated, never tracked (SEC-06) |
| Request validation | Partial | command allow-list + PIN regex; limited length checks |
| SQL/NoSQL injection risk | Low | lowdb JSON store; no query builder |
| Audit trail integrity | Partial | mutable JSON events, no signing (SEC-08) |
| Data retention policy | Missing | hard cap only |
| Backup/restore | Missing | file store, no backup |
| Timezone handling | Partial | server-local timestamps |
| Telegram alerting | Complete | env-configured |
| DB migrations | Missing | no schema/migrations |
| Deployment config | Partial | `render.yaml`, `netlify.toml` present, not verified |
| Automated regression tests | Partial | `server/test/security.test.mjs` covers auth only (Phase 0); no firmware or UI DOM tests |

## Dashboard (`server/public/index.html`)

| Feature | Status | Evidence / Notes |
|---|---|---|
| Login overlay with token | Complete | cleared on any 401 as of Phase 0 (was UI-02) |
| Token storage | Partial | `sessionStorage`; cleared on any 401 as of Phase 0 (was UI-02) |
| Route protection | Missing | single-file SPA, no router guards |
| Role-based UI | Partial | `VIEWER_MODE` client-side flag only (UI-01) |
| Authenticated SSE transport | Complete | `fetch()` + `ReadableStream` with `Authorization: Bearer`; bounded backoff, reconnect stops on 401 (Phase 0; `EventSource` cannot set headers) |
| Live device status | Complete | metrics + SSE |
| Door/lock state display | Complete | updated from `/api/state` and SSE |
| Lock/unlock with confirmation | Partial | ACK-based, no offline/queue handling (UI-02) |
| Loading states | Partial | spinners present for camera only |
| Empty states | Missing | no empty-event/empty-history state |
| Error states | Partial | camera error pane only |
| Offline/retry behavior | Partial | SSE reconnects with bounded exponential backoff (cap 30 s) as of Phase 0; no retry queue yet (was UI-02) |
| Event history table + filters | Complete | search + type + date filters |
| Camera pane | Partial | no retry/stale indicator (UI-03) |
| PIN change UI | Complete | pin input + validation message |
| Notifications | Partial | in-browser only; no push notifications |
| Emergency-access UX | Missing | no duress or emergency override flow |
| Accidental-unlock prevention | Partial | client-side confirm; no server-side guard |
| XSS-safe rendering | Not verified | no obvious `eval`/`document.write` found; not tested |
| Responsive layout | Partial | CSS present; not tested across breakpoints |
| Mobile app | Missing | no mobile project exists |

## Cross-cutting

| Feature | Status | Evidence / Notes |
|---|---|---|
| CI/CD | Missing | no `.github/` or pipeline |
| Unit/integration/e2e tests | Complete | 35 assertions in `server/test/security.test.mjs` (Node built-in runner); dashboard + startup probes in `server/test/` (was GOV-04) |
| Dependency lockfile | Complete | lockfile committed; `npm audit fix` applied, 0 advisories remain (was GOV-05) |
| Secret management | Broken | credentials committed publicly (SEC-01); rotation still an owner action |
| `.gitignore` coverage | Partial | hardened by this audit; `app_config.h` now excluded |
| Documentation | Partial | README + `.env.example` rewritten for Phase 0 auth model; still references some absent files (GOV-03) |
| Hardware documentation | Missing | no schematic/PCB/BOM |
| Observability/logging | Partial | console logs; no metrics/tracing |
| Environment separation | Partial | `.env.example` + `.env`; no per-stage configs |
| Reproducible setup | Partial | README steps reference absent files |
