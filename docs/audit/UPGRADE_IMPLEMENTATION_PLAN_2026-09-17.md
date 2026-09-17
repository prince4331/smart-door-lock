# UPGRADE_IMPLEMENTATION_PLAN_2026-09-17

## Overview

This plan addresses the mandatory user requirements identified in the full codebase audit. It respects the immutable constraint that `firmware/esp32cam/src/main.cpp` and `firmware/esp32cam/platformio.ini` cannot be modified.

Allowed implementation surfaces:
- `firmware/src/*`
- `firmware/include/*`
- `server/src/*`
- `server/public/*`
- `server/test/*`
- `docs/*`
- Sanitized config examples

## Phase 0 — Preserve security/regression baseline
**Status:** COMPLETE
**Branch:** `baseline/full-project-pre-audit` at `ddfaec9`

## Phase 1 — Remove keypad runtime dependency
**Objective:** Eliminate all keypad-related code from firmware, backend, and dashboard.
**Files:**
- `firmware/src/main.c`
- `firmware/include/app_config.h`
- `server/src/index.js`
- `server/public/index.html`
- `server/test/security.test.mjs`
**Exact behavior:**
- Remove `keypad_init()`, `scan_keypad()`, keypad variables
- Remove `SET_PIN` command handler from `handle_command()`
- Remove `POST /api/pin` route
- Remove PIN input, Update PIN button, and `updatePin()` from dashboard
- Remove `failed_attempts` NVS persistence
- Remove keypad GPIO defines from `app_config.h`
**Dependencies:** None
**Security considerations:** Eliminates timing-leak PIN comparison and universal default PIN "1069".
**Tests:** Remove PIN-related tests. Add regression test confirming `/api/pin` returns 404.
**Rollback risk:** LOW

## Phase 2 — Implement secure software access/unlock
**Objective:** Make authenticated dashboard the primary unlock mechanism with deliberate hold-to-unlock.
**Files:**
- `server/public/index.html`
- `server/src/index.js`
**Exact behavior:**
- Dashboard UNLOCK button requires 2-second press (mousedown/touchstart → timer → mouseup/touchend)
- If released before 2 seconds: cancel, show "Hold to unlock"
- If held 2 seconds: send `POST /api/command` with `UNLOCK`
- Show command progress: Sent → Acknowledged/Failed/Timed-out
- Backend publishes `UNLOCK|nonce|timestamp` to MQTT
- Firmware acknowledges via `command_ack`
- Dashboard displays ack status
**Dependencies:** Phase 1 complete
**Security considerations:** Prevents accidental unlock. Maintains Bearer auth. Rate limiting applies.
**Tests:** Dashboard probe verifies hold-to-unlock states. Backend tests verify command flow unchanged.
**Rollback risk:** LOW

## Phase 3 — Main ESP32 Wi-Fi NVS provisioning + captive portal
**Objective:** Replace hardcoded Wi-Fi with persistent runtime provisioning.
**Files:**
- `firmware/src/main.c`
- `firmware/include/app_config.h`
- `firmware/include/app_config_example.h`
- `firmware/CMakeLists.txt` (if needed for HTTP server component)
**Exact behavior:**
1. Add NVS keys: `sta_ssid`, `sta_pass`, `setup_code`
2. `load_nvs_state()` also loads Wi-Fi credentials
3. New `wifi_provisioning_init()`:
   - Check NVS for stored credentials
   - If present: `wifi_init_sta()` with stored creds
   - If absent OR `WIFI_FAIL_BIT` after 60s: enter provisioning mode
4. Provisioning mode:
   - `esp_wifi_set_mode(WIFI_MODE_APSTA)`
   - Start AP: `SmartLock-Setup-XXXX` (XXXX = last 4 of MAC)
   - Gateway: `192.168.4.1`
   - Start HTTP server on port 80
   - Optional: DNS server redirecting all queries to 192.168.4.1
5. Provisioning portal:
   - GET `/` — serve HTML page (minimal, no CSS framework)
   - POST `/setup` — `{setup_code, ssid, password}`
   - Validate setup code against NVS
   - Scan for SSID (or accept any)
   - Test connection: `esp_wifi_sta_start()`, wait for IP or timeout
   - On success: save to NVS, `nvs_commit()`, `esp_restart()`
   - On failure: return error, retry
6. Timeout: 10 minutes of no HTTP requests → stop AP, reboot
7. Recovery: if STA fails, re-enter provisioning after backoff
**Dependencies:** None
**Security considerations:** Setup code prevents unauthorized provisioning. AP can use WPA2 with derived password. Credentials stored in NVS (plaintext acceptable for local-only storage; consider NVS encryption if available).
**Tests:** Unit tests for provisioning state machine. Mock Wi-Fi events. Test credential validation flow.
**Rollback risk:** MEDIUM — Wi-Fi behavior fundamentally changes. Requires hardware testing.

## Phase 4 — Migrate Telegram authority to backend/dashboard
**Objective:** Backend becomes sole Telegram sender using dashboard-managed credentials.
**Files:**
- `server/src/index.js`
- `server/public/index.html`
- `server/.env.example`
**Exact behavior:**
1. Add `SETTINGS_ENCRYPTION_KEY` validation at startup (required, min 32 bytes)
2. Implement routes:
   - `GET /api/settings/telegram` — returns `{configured: true/false, bot_token_masked: "****...****"}`
   - `PUT /api/settings/telegram` — `{bot_token, chat_id}`, validates format, encrypts with AES-256-GCM
   - `DELETE /api/settings/telegram` — removes stored settings
   - `POST /api/settings/telegram/test` — sends test message, returns success/failure
3. Storage: lowdb `settings` collection with `telegram` object containing `nonce`, `ciphertext`, `tag`
4. Encryption: AES-256-GCM with `SETTINGS_ENCRYPTION_KEY`, random 12-byte nonce per save
5. Decryption: on send, decrypt in memory, never log plaintext
6. `sendTelegramMessage()` and `sendTelegramPhoto()` use stored encrypted credentials instead of env vars
7. Dashboard adds Telegram settings page (masked token display, test button)
8. Backward compat: `TG_BOT_TOKEN`/`TG_CHAT_ID` env vars still work as fallback if no dashboard settings
**Dependencies:** Phase 2 complete
**Security considerations:** `SETTINGS_ENCRYPTION_KEY` required at startup. Plaintext never persisted or logged. Nonce/IV stored with ciphertext.
**Tests:** Test encryption/decryption roundtrip. Test masked response. Test validation rejects malformed tokens. Test test-endpoint sends real Telegram message (mocked in CI).
**Rollback risk:** MEDIUM — Telegram delivery path changes.

## Phase 5 — Implement sustained-presence state machine on main ESP32
**Objective:** Replace 20-second dwell with configurable presence confirmation.
**Files:**
- `firmware/src/main.c`
- `firmware/include/app_config.h`
- `server/src/index.js`
- `server/public/index.html`
**Exact behavior:**
1. Add state machine enum: `PRESENCE_IDLE`, `PRESENCE_PENDING`, `PRESENCE_CONFIRMED`, `CAPTURE_TRIGGERED`, `COOLDOWN`
2. Add variables: `presence_state`, `presence_start_ms`, `presence_cooldown_until_ms`, `presence_captured`
3. In `sensor_task()`:
   - PIR high: if `PRESENCE_IDLE` → `PRESENCE_PENDING`, record `presence_start_ms`
   - PIR low: if `PRESENCE_PENDING` and elapsed < 15s → `PRESENCE_IDLE` (grace)
   - PIR high and elapsed >= 30s (or configured threshold): → `PRESENCE_CONFIRMED`
   - If `PRESENCE_CONFIRMED` and not `presence_captured`: trigger capture, set `presence_captured = true`, `presence_cooldown_until_ms = now + 5min`
   - PIR low: → `PRESENCE_IDLE`, reset all presence state
   - If cooldown active: no new captures
4. Add backend endpoint `POST /api/settings/presence` with `{threshold_ms, grace_ms, cooldown_ms}`
5. Publish `PRESENCE_CONFIRMED` alert with threshold, start time, confirmation time
6. Stuck-PIR detection at 120s unchanged
**Dependencies:** Phase 3 (Wi-Fi), Phase 6 (camera trigger)
**Security considerations:** Single capture per session prevents flooding. Cooldown prevents spam.
**Tests:** Simulate PIR sequences with test doubles. Verify state transitions. Verify single capture per session.
**Rollback risk:** MEDIUM — changes sensor behavior.

## Phase 6 — Make main ESP32 trigger existing immutable CAM
**Objective:** Establish working trigger path from main ESP32 to CAM without reflashing CAM.
**Files:**
- `firmware/src/main.c`
**Exact behavior:**
1. Hardware check: verify UART wiring between main ESP32 TX (GPIO17 or GPIO1) and CAM RX (GPIO14 or GPIO15)
2. If wired:
   - Add UART initialization in `app_main()`
   - Configure UART: 115200 baud, 8N1
   - In `trigger_cam_capture()`: send byte `'1'` via UART with 30s software cooldown
   - Keep HTTP GET as fallback if `CAM_CAPTURE_URL` is set
3. If not wired:
   - Document that CAM cannot be triggered remotely
   - Manual/local provisioning is the only CAM trigger path
   - Backend can still receive MQTT chunks if CAM is manually triggered
**Dependencies:** Phase 5 complete
**Security considerations:** UART trigger is local only. No network exposure.
**Tests:** Hardware test required. Mock UART in unit tests.
**Rollback risk:** HIGH — requires hardware verification.

## Phase 7 — Dashboard UX/settings integration
**Objective:** Update dashboard for new features and remove keypad remnants.
**Files:**
- `server/public/index.html`
**Exact behavior:**
1. Remove PIN configuration card (lines 399-407)
2. Add presence settings card (threshold selector: 30s/60s)
3. Add Telegram settings card (masked token display, test button, save form)
4. Improve command progress: show actual ack status from SSE
5. Add offline/online indicator for device
6. Add provisioning guide link/modal
**Dependencies:** Phases 1, 4, 5 complete
**Security considerations:** Settings changes require Bearer auth. No secrets in DOM.
**Tests:** Dashboard probe verifies new UI elements and settings flow.
**Rollback risk:** LOW

## Phase 8 — Integration/regression/security tests
**Objective:** Ensure all phases work together and security boundaries hold.
**Files:**
- `server/test/security.test.mjs`
- New: `server/test/provisioning.test.mjs`
- New: `server/test/telegram-settings.test.mjs`
- New: `server/test/presence.test.mjs`
- New: `firmware/test/` (if PlatformIO unit testing is configured)
**Exact behavior:**
- All existing tests continue passing
- New tests for each new feature
- Security regression tests for new attack surfaces
- Firmware tests run in CI if possible
**Dependencies:** All implementation phases complete
**Tests:** Full suite pass.
**Rollback risk:** LOW

## Phase 9 — Hardware test checklist for owner
**Objective:** Verify real-world behavior before declaring upgrade complete.
**Checklist:**
1. Flash main ESP32 with provisioning-enabled firmware
2. Test AP provisioning with phone (scan, select, password, validate, save)
3. Verify Wi-Fi persistence across power cycles
4. Test dashboard unlock with 2-second hold
5. Verify auto-lock after 10 seconds
6. Test 30/60-second presence capture (PIR simulation)
7. Verify stuck-PIR tamper alert at 120s
8. Test fire auto-unlock
9. Verify Telegram delivery via backend (configure via dashboard, trigger alert)
10. Verify CAM trigger via available mechanism (UART or document limitation)
11. Test alarm silence and reset
12. Verify MQTT reconnection and state recovery
13. Test OTA update (if URL configured)
14. Verify Render deployment with encrypted env vars

## Rollback Strategy

For each phase:
- **Phase 1:** Git revert removes keypad code. No data migration needed.
- **Phase 2:** UI changes are additive. Revert removes hold-to-unlock, restores simple click.
- **Phase 3:** Wi-Fi provisioning is additive. Hardcoded fallback can be preserved in NVS.
- **Phase 4:** Telegram settings are additive. Env var fallback preserved.
- **Phase 5:** Presence state machine additive. Old dwell logic can be preserved behind config flag.
- **Phase 6:** UART trigger additive. HTTP GET fallback preserved.
- **Phase 7:** UI changes additive. Revert removes new cards.
- **Phase 8:** Tests only, no runtime changes.
- **Phase 9:** Hardware validation only.

## Security Considerations Summary

1. **Keypad removal** eliminates timing-leak PIN comparison and universal default PIN.
2. **Hold-to-unlock** reduces accidental activation risk.
3. **Wi-Fi provisioning** eliminates hardcoded credentials. Setup code provides authentication.
4. **Telegram settings** add encryption at rest, masked responses, and dashboard control.
5. **Presence state machine** prevents capture flooding with cooldown and single-capture-per-session.
6. **UART trigger** (if wired) is local-only, no network exposure.
7. **Render.yaml** must have secrets removed before deployment.

## Testing Strategy

- **Unit tests:** Backend routes, encryption helpers, state machine logic
- **Integration tests:** MQTT publish/subscribe, camera chunk reassembly, Telegram delivery
- **Firmware tests:** Mock Wi-Fi, mock NVS, provisioning flow (PlatformIO Unity or similar)
- **Dashboard tests:** Puppeteer or similar for hold-to-unlock, settings UI
- **Hardware tests:** Owner-performed checklist in Phase 9
