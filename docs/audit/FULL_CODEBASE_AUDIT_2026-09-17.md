# FULL_CODEBASE_AUDIT_2026-09-17

## Executive Summary

This audit covers the complete local Smart Door Lock project at baseline commit `ddfaec9` on branch `baseline/full-project-pre-audit`. The system comprises a Node.js/Express backend, a vanilla HTML/CSS/JS dashboard, an ESP-IDF main ESP32 firmware, and an Arduino/PlatformIO ESP32-CAM firmware. Both firmware projects build successfully.

The audit reveals significant documentation/implementation drift, several integration defects, and critical security issues that must be resolved before the mandatory upgrades can proceed. The most urgent finding is that the ESP32-CAM trigger mechanism is fundamentally incompatible with the main ESP32's current trigger implementation, and the claimed dashboard-configurable Telegram settings endpoints do not exist in executable code.

## System Actually Implemented

### Backend (server/src/index.js)
- Express HTTP server with CORS, Morgan, rate limiting
- MQTT client subscribing to `smartlock/state`, `smartlock/alert`, `smartlock/metric`, `smartlock/command_ack`, `smartlock/cam/meta`, `smartlock/cam/chunk`
- Lowdb JSON file persistence (events capped at 500, state in memory)
- Authenticated REST endpoints: `/api/health` (public), `/api/state`, `/api/events`, `/api/command`, `/api/pin`, `/api/cam/latest`, `/api/cam/status`, `/api/cam/upload`, `/api/cam/stream`, `/api/cam/capture`
- SSE stream at `/api/stream` using `fetch()` with Bearer auth
- Camera chunk reassembly from MQTT, storage outside public root
- Telegram delivery via environment variables only (no dashboard settings)
- Fail-closed startup validation for `DASH_TOKEN` and `CAM_UPLOAD_TOKEN`

### Dashboard (server/public/index.html)
- Single-page application with login overlay
- Bearer token authentication stored in `sessionStorage`
- Viewer mode (read-only, no token)
- Command center: LOCK, UNLOCK, SILENCE, ARM with 10-second timeout UI
- Security mode selection: HOME, AWAY, NIGHT
- PIN update UI calling `POST /api/pin`
- Camera snapshot display via authenticated fetch
- Live event feed and history table with search/filter
- Analytics charts (alarms per hour, unlocks per day)
- SSE connection with bounded exponential backoff

### Main ESP32 Firmware (firmware/src/main.c)
- ESP-IDF/FreeRTOS application
- Wi-Fi STA only, hardcoded credentials from `app_config.h`
- MQTT client with TLS using `esp_crt_bundle_attach`
- Three FreeRTOS tasks: sensor_task, control_task, health_task
- GPIO sensors: PIR (GPIO25), reed (GPIO26), fire (GPIO33)
- Outputs: buzzer (GPIO27), servo (GPIO13), LEDs (GPIO4, GPIO2)
- Keypad: 4x4 matrix on GPIOs 23,22,21,14 (rows) and 32,18,17,16 (cols)
- PIN validation with `strcmp` (timing leak)
- Command parser for LOCK, UNLOCK, SILENCE, ARM, OTA, MODE_*, SET_PIN
- Timestamp-based replay protection (300s window, no nonce verification)
- NVS storage for lock_state, failed_attempts, password, boot_count
- Auto-lock after 10 seconds
- Schedule-based mode switching (HOME/NIGHT)
- OTA update support
- Camera trigger via HTTP GET to `CAM_CAPTURE_URL` (currently empty)
- Health metrics publishing

### ESP32-CAM Firmware (firmware/esp32cam/src/main.cpp) — READ ONLY
- Arduino framework, PlatformIO project
- Wi-Fi STA with hardcoded credentials
- MQTT publish-only client to `smartlock/cam/meta` and `smartlock/cam/chunk`
- Camera capture with flash LED
- JPEG encoding at QVGA resolution
- Image chunking (2048 bytes) with sequence numbers
- **Trigger mechanism: Serial UART byte '1' with 30-second cooldown**
- **Direct Telegram sender** with hardcoded bot token and chat ID
- `WiFiClientSecure::setInsecure()` for both MQTT and Telegram (no cert validation)
- No MQTT subscription, no HTTP server, no command reception

## Architecture and Data Flow

```
Sensors (PIR, reed, fire)
    |
    v
Main ESP32 (GPIO → FreeRTOS tasks)
    |
    |-- MQTT (state, alerts, metrics, ACKs) -->
    |
    v
MQTT Broker (HiveMQ Cloud)
    |
    |-- MQTT <-- Backend (commands)
    |
    v
Backend (Node.js/Express)
    |
    |-- lowdb (JSON file)
    |-- SSE --> Dashboard
    |-- Telegram Bot API
    |
    v
Dashboard (browser)
    |
    |-- Bearer auth --> Backend REST API
    |
ESP32-CAM (independent)
    |
    |-- Serial trigger (UART byte '1') --> capture
    |-- MQTT publish --> Backend (chunks)
    |-- Direct HTTPS --> Telegram (bypasses backend)
```

**Critical observation:** The ESP32-CAM is NOT controlled by the main ESP32 or backend via the currently implemented paths. The main ESP32 attempts HTTP GET to trigger the CAM, but the CAM listens for Serial UART. The CAM also sends Telegram photos independently, bypassing backend authority.

## Build/Test Results

| Component | Result | Details |
|-----------|--------|---------|
| `npm ci` | PASS | 126 packages installed |
| `npm test` | PASS | 62/62 assertions passed |
| `node test/verify-phase0.mjs` | PASS | All Phase 0 checks passed |
| `npm audit --json` | PASS | 0 vulnerabilities |
| `git diff --check` | PASS | No whitespace issues |
| Main ESP32 build | PASS | `python -m platformio run` in `firmware/` |
| ESP32-CAM build | PASS | `python -m platformio run` in `firmware/esp32cam/` |
| `git diff -- firmware/esp32cam/` | PASS | Empty — CAM firmware unchanged |

## Critical Findings

### CRIT-01 — Exposed live credentials in tracked deployment file
- **File:** `server/render.yaml`
- **Evidence:** Lines 13-16 contain hardcoded MQTT broker URI with credentials, username, and password. `DASH_TOKEN` is marked `sync: false` but the broker credentials are not.
- **Impact:** Anyone with read access to the repository can see the MQTT broker hostname, port, username, and password. They can publish commands to `smartlock/command` and potentially unlock the door.
- **Recommendation:** Move all secrets to Render's encrypted environment variable UI. Remove all credential values from `render.yaml`.

### CRIT-02 — Camera trigger path is fundamentally broken
- **Files:** `firmware/src/main.c:906-930`, `firmware/esp32cam/src/main.cpp:286-303`
- **Evidence:** Main ESP32 `trigger_cam_capture()` performs HTTP GET to `CAM_CAPTURE_URL`. ESP32-CAM `loop()` waits for Serial byte `'1'` on `Serial.read()`. The CAM has no HTTP server and no MQTT subscription for capture commands.
- **Impact:** Camera capture CANNOT work in the current codebase. No path exists from main ESP32 or backend to trigger the CAM. The `CAM_CAPTURE_URL` is empty string, so even if the CAM had an HTTP server, no request would be made.
- **Recommendation:** This is an integration defect requiring firmware/backend coordination. Since CAM cannot be reflashed, the main ESP32 must be modified to send the UART trigger byte, OR the CAM's existing UART trigger must be wired and used.

### CRIT-03 — ESP32-CAM sends Telegram directly with hardcoded credentials
- **Files:** `firmware/esp32cam/src/main.cpp:25-26`, `187-233`
- **Evidence:** `tg_bot_token` and `tg_chat_id` are hardcoded constants. `sendTelegramPhoto()` constructs raw HTTP multipart POST to `api.telegram.org` using `WiFiClientSecure::setInsecure()`.
- **Impact:** The CAM bypasses backend authority entirely. If the CAM has old/rotated credentials, Telegram delivery fails silently. If credentials are exposed, anyone with firmware access can read them. The CAM's direct Telegram path cannot be disabled without reflashing.
- **Recommendation:** Accept that CAM will continue attempting direct Telegram delivery. Backend must become authoritative sender. Rotate/revoke old CAM Telegram credentials externally. Backend should send photos via dashboard-managed credentials.

## High Findings

### HIGH-01 — Documentation/implementation drift: keypad removal
- **Files:** `firmware/src/main.c:342-393`, `firmware/include/app_config.h:30-36,76-80,95-102`, `server/src/index.js:645-665`, `server/public/index.html:399-407,1176-1200`, `docs/audit/FEATURE_COMPLETENESS_MATRIX.md:17`, `docs/audit/SYSTEM_ARCHITECTURE.md:45`, `firmware/README.md:7`
- **Evidence:** Documentation claims keypad is removed. Executable code shows full keypad implementation: GPIO initialization, 4x4 scanner, PIN buffer, validation, lockout, `SET_PIN` command, NVS storage, dashboard PIN UI, backend `/api/pin` endpoint.
- **Impact:** The system is NOT in the state documentation claims. A damaged keypad still has its GPIOs configured and scanned, potentially causing electrical issues or unexpected behavior.
- **Recommendation:** Remove keypad code from firmware, remove `/api/pin` from backend, remove PIN UI from dashboard.

### HIGH-02 — Documentation/implementation drift: Telegram dashboard settings
- **Files:** `docs/audit/FEATURE_COMPLETENESS_MATRIX.md:53`, `docs/audit/SYSTEM_ARCHITECTURE.md:96-103`, `server/README.md:57`, `server/public/index.html` (no Telegram settings UI found)
- **Evidence:** Documentation claims `GET/PUT/DELETE /api/settings/telegram` endpoints with AES-256-GCM encryption. Executable code shows no such endpoints. Telegram credentials are read from environment variables `TG_BOT_TOKEN` and `TG_CHAT_ID` and used directly.
- **Impact:** Dashboard-configurable Telegram settings DO NOT EXIST. The claimed security boundary (encrypted storage, masked responses, test endpoint) is not implemented.
- **Recommendation:** Implement Telegram settings endpoints or update documentation to match current env-only behavior.

### HIGH-03 — Documentation/implementation drift: presence settings
- **Files:** `docs/audit/FEATURE_COMPLETENESS_MATRIX.md`, `docs/audit/SYSTEM_ARCHITECTURE.md`, `firmware/include/app_config_example.h:50-52`, `firmware/include/app_config.h:38-42`
- **Evidence:** Documentation claims 30/60-second threshold, 15-second grace, 5-minute cooldown, one capture per session. Actual `app_config.h` has `PIR_DWELL_MS = 20` seconds, no grace period, `CAM_COOLDOWN_MS = 30` seconds, no per-session tracking.
- **Impact:** Presence behavior does not match documented or desired behavior. 20-second dwell is too short for meaningful presence confirmation.
- **Recommendation:** Implement configurable presence state machine on main ESP32.

### HIGH-04 — Wi-Fi hardcoding makes field deployment impractical
- **Files:** `firmware/include/app_config.h:3-4`, `firmware/src/main.c:207-237`
- **Evidence:** Wi-Fi SSID and password are compile-time constants. `wifi_init_sta()` uses them directly with no fallback. If STA fails after 10 retries, the device halts (`ESP_LOGE(TAG, "WiFi connection failed - system halted")`).
- **Impact:** Moving the device requires recompiling and reflashing. No provisioning mechanism exists.
- **Recommendation:** Implement NVS-based Wi-Fi provisioning with AP fallback.

### HIGH-05 — Command replay protection is weak
- **Files:** `firmware/src/main.c:516-553`, `server/src/index.js:737-740`
- **Evidence:** Backend adds `nonce|timestamp` to commands. Firmware validates only the timestamp window (300s). The nonce is never checked for uniqueness or stored for idempotency.
- **Impact:** An attacker who intercepts a valid command can replay it within the 5-minute window. The nonce provides no actual protection.
- **Recommendation:** Implement nonce/idempotency key tracking on the device or backend.

### HIGH-06 — CAM firmware uses insecure TLS
- **Files:** `firmware/esp32cam/src/main.cpp:87`, `192-193`
- **Evidence:** `net.setInsecure()` and `client.setInsecure()` disable certificate validation for both MQTT and Telegram HTTPS.
- **Impact:** Vulnerable to man-in-the-middle attacks. An attacker on the network path can intercept camera images and Telegram credentials.
- **Recommendation:** Cannot fix without reflashing CAM. Accept as immutable limitation. Ensure network-level security (isolated VLAN, firewall).

## Medium Findings

### MEDIUM-01 — Keypad PIN comparison uses non-constant-time strcmp
- **File:** `firmware/src/main.c:555`
- **Evidence:** `strcmp(keypad_buffer, lock_password)` compares PINs byte-by-byte, exiting on first mismatch.
- **Impact:** Local or network observer can theoretically use timing to brute-force PIN faster.
- **Recommendation:** Use constant-time comparison or hash-based verification.

### MEDIUM-02 — Default PIN is hardcoded and universal
- **File:** `firmware/include/app_config.h:30`
- **Evidence:** `DEFAULT_LOCK_PASSWORD "1069"` is used as fallback when NVS has no password.
- **Impact:** Any device that has not set a custom PIN uses the same universal default.
- **Recommendation:** Remove default PIN. Require explicit PIN setup during provisioning.

### MEDIUM-03 — No exponential backoff for keypad lockout
- **File:** `firmware/src/main.c:765-770`
- **Evidence:** Fixed 30-second lockout after 3 wrong attempts. No escalation.
- **Impact:** Persistent local attacker can attempt 3 PINs every 30 seconds indefinitely.
- **Recommendation:** Implement escalating lockout or alert on repeated failures.

### MEDIUM-04 — render.yaml exposes MQTT broker credentials
- **File:** `server/render.yaml:13-16`
- **Evidence:** Hardcoded `MQTT_BROKER`, `MQTT_USERNAME`, `MQTT_PASSWORD` in deployment config.
- **Impact:** Credentials visible in repository. Anyone can connect to the broker.
- **Recommendation:** Use Render's encrypted environment variables.

### MEDIUM-05 — Dashboard innerHTML with event data
- **File:** `server/public/index.html:916`, `1104`
- **Evidence:** `item.innerHTML = ...` includes `${message}` and `${details}` from MQTT events without explicit sanitization.
- **Impact:** If an attacker can publish crafted MQTT messages, they could inject HTML/JS into the dashboard.
- **Recommendation:** Use `textContent` for user-controlled strings or sanitize before `innerHTML`.

### MEDIUM-06 — No watchdog timer in firmware
- **File:** `firmware/src/main.c` (all tasks)
- **Evidence:** FreeRTOS tasks have no watchdog configuration. A blocked task would not reset the system.
- **Impact:** A software fault could hang the device without recovery.
- **Recommendation:** Enable ESP-IDF task watchdog or implement application-level heartbeats.

### MEDIUM-07 — Blocking delay in sensor_task
- **File:** `firmware/src/main.c:795`
- **Evidence:** `vTaskDelay(pdMS_TO_TICKS(SENSOR_SCAN_MS))` blocks the entire sensor task for 500ms.
- **Impact:** Keypad scanning, sensor sampling, and trigger checks are delayed uniformly.
- **Recommendation:** Use non-blocking timers or separate tasks for different sensor classes.

### MEDIUM-08 — MQTT reconnect does not resubscribe
- **File:** `firmware/src/main.c:169-174`
- **Evidence:** Subscription to `MQTT_TOPIC_CMD` happens only on `MQTT_EVENT_CONNECTED`. If the connection drops and reconnects, the subscription is re-established. However, the backend does not see the device's state after reconnect until the next publish.
- **Impact:** Minor — commands could be missed during reconnection window.
- **Recommendation:** Publish state immediately after reconnect (already done in firmware, verify backend handles it).

## Low Findings

### LOW-01 — Stale documentation references
- **Files:** Multiple docs reference `CIRCUIT_DIAGRAM.md` and `LICENSE` which do not exist.
- **Impact:** Confusion for new developers.
- **Recommendation:** Remove or create missing files.

### LOW-02 — Firmware flash usage high
- **File:** Build output shows 96.9% flash usage for main ESP32.
- **Impact:** Little room for new features without optimization.
- **Recommendation:** Review linker map, remove unused code, consider larger flash variant.

### LOW-03 — No CI/CD pipeline
- **Evidence:** No `.github/workflows/` or equivalent.
- **Impact:** No automated testing or building on commits.
- **Recommendation:** Add GitHub Actions for backend tests and firmware builds.

### LOW-04 — CORS allows localhost HTTP
- **File:** `server/src/index.js:124`
- **Evidence:** `http://localhost:8080` is in CORS origins.
- **Impact:** Development convenience, but could be exploited if browser is tricked.
- **Recommendation:** Restrict to specific dev ports or use environment-based CORS.

### LOW-05 — Camera upload size limit 3MB
- **File:** `server/src/index.js:706`
- **Evidence:** `limit: "3mb"` on camera upload endpoint.
- **Impact:** Large images rejected. QVGA JPEGs should be well under this.
- **Recommendation:** Current limit is acceptable for QVGA. Monitor if resolution increases.

## Documentation / Implementation Drift

| Claim | Evidence | Verdict |
|-------|----------|---------|
| Keypad removed | `firmware/src/main.c:342-393`, `server/public/index.html:399-407`, `server/src/index.js:645-665` | **DRIFT** — fully implemented |
| Telegram settings endpoints exist | No `/api/settings` routes in `index.js` | **DRIFT** — does not exist |
| AES-256-GCM Telegram storage | No encryption code in backend | **DRIFT** — not implemented |
| Dashboard manages Telegram | No Telegram UI in dashboard | **DRIFT** — env-only |
| 30/60-second presence threshold | `PIR_DWELL_MS = 20` in `app_config.h` | **DRIFT** — 20s hardcoded |
| 15-second grace period | No grace logic in firmware | **DRIFT** — not implemented |
| 5-minute cooldown | `CAM_COOLDOWN_MS = 30` seconds | **DRIFT** — 30s cooldown |
| One capture per session | No session tracking, repeated triggers possible | **DRIFT** — not implemented |
| CAM capture via MQTT command | CAM has no MQTT subscription | **DRIFT** — not implemented |
| No camera UART trigger | CAM uses UART trigger exclusively | **DRIFT** — opposite of claim |
| No direct camera Telegram | CAM sends Telegram directly | **DRIFT** — direct sender exists |

## Keypad Removal Analysis

### Every keypad dependency found:

**Firmware:**
- `firmware/include/app_config.h:30` — `DEFAULT_LOCK_PASSWORD "1069"`
- `firmware/include/app_config.h:36` — `KEYPAD_LOCKOUT_MS`
- `firmware/include/app_config.h:76-80` — `KEYPAD_MAX_LEN`, `keypad_buffer`, `keypad_pos`, `keypad_lockout_until_ms`, `lock_password`
- `firmware/include/app_config.h:84` — `failed_attempts`
- `firmware/include/app_config.h:95-102` — `PIN_KP_R1`-`PIN_KP_C4` GPIO definitions
- `firmware/src/main.c:102-103` — `keypad_init()`, `scan_keypad()` declarations
- `firmware/src/main.c:342-393` — `keypad_init()` and `scan_keypad()` implementations
- `firmware/src/main.c:414-419` — NVS load of password
- `firmware/src/main.c:428-429` — NVS save of password and failed_attempts
- `firmware/src/main.c:447` — `failed_attempts` in state publish
- `firmware/src/main.c:592-602` — `SET_PIN` command handler
- `firmware/src/main.c:626` — `keypad_locked_out` check
- `firmware/src/main.c:747-788` — keypad scanning loop with PIN validation and lockout

**Backend:**
- `server/src/index.js:325-327` — Telegram alert for `WRONG_PIN`
- `server/src/index.js:645-665` — `POST /api/pin` endpoint
- `server/src/index.js:656` — `SET_PIN:${pin}` command construction

**Dashboard:**
- `server/public/index.html:399-407` — PIN input and Update PIN button
- `server/public/index.html:565-566` — `pinInput`, `pinMsg` element references
- `server/public/index.html:1176-1200` — `updatePin()` function

**Tests:**
- `server/test/security.test.mjs:292-299` — test for `POST /api/pin`

**Documentation:**
- `docs/audit/FEATURE_COMPLETENESS_MATRIX.md:17` — claims keypad removed
- `docs/audit/SYSTEM_ARCHITECTURE.md:45` — claims no PIN path
- `firmware/README.md:7` — claims no keypad initialization
- `README.md:7` — claims keypad removed

### What breaks if keypad is removed:
1. Local PIN unlock capability is lost (acceptable per requirement)
2. `failed_attempts` NVS field becomes unused
3. `POST /api/pin` endpoint returns 404
4. Dashboard PIN UI shows/hides incorrectly
5. Backend Telegram alert for wrong PIN never triggers
6. `lock_password` and keypad GPIOs become dead code

### Software-only replacement evaluation:
The existing `POST /api/command` flow already provides:
- Authentication (Bearer token)
- Authorization (dash token required)
- Replay protection (timestamp window, weak nonce)
- Auto-lock (10s timer in firmware)
- Event logging (MQTT state/alert/ack)
- Command acknowledgment (`command_ack`)

**The backend→MQTT→ESP32→lock/unlock path is ALREADY IMPLEMENTED and can become the primary access-control mechanism.** The hold-to-unlock UI exists in dashboard but is not actually implemented in the command flow (it's just a 10-second UI timer).

## Main ESP32 Wi-Fi Provisioning Analysis

### Current behavior:
1. `app_main()` calls `nvs_flash_init()`
2. `load_nvs_state()` reads lock_state, failed_attempts, password — but NOT Wi-Fi credentials
3. `wifi_init_sta()` uses compile-time `WIFI_STA_SSID` and `WIFI_STA_PASS`
4. WiFi connects in STA mode only
5. If connection fails after 10 retries with exponential backoff, device halts
6. No AP mode, no provisioning portal, no credential persistence for Wi-Fi

### Required design:
Normal boot:
1. Initialize NVS
2. Check for stored Wi-Fi credentials in NVS
3. If present: attempt STA connection
4. If absent OR STA fails for 60 seconds: enter AP provisioning mode

Provisioning mode:
1. Start AP with deterministic SSID: `SmartLock-Setup-<device_suffix>`
2. Gateway: `192.168.4.1`
3. Start HTTP server (captive portal or direct IP)
4. User connects phone to AP, opens portal
5. Portal shows setup code entry (from NVS or QR label)
6. User selects Wi-Fi network, enters password
7. Firmware tests connection before saving
8. On success: save to NVS, reboot, connect as STA
9. Timeout: 10 minutes of inactivity
10. AP shuts down after successful STA connection

### ESP-IDF components available:
- `esp_wifi` — AP+STA concurrent mode supported
- `wifi_provisioning` — ESP-IDF has built-in provisioning component with HTTPD transport
- `esp_netif` — network interface abstraction
- `nvs_flash` — already used for other state

### Feasibility:
- ESP-IDF `wifi_provisioning` component supports exactly this pattern
- The example `scheme_softap.c` is already compiled (visible in build output)
- No display required — deterministic SSID and `192.168.4.1` are sufficient
- Setup code stored in NVS provides authentication without shared password

## No-Display Provisioning Solution

Recommended flow:

1. **First boot / no credentials:**
   - Start AP: `SmartLock-Setup-XXXX` (XXXX = last 4 of MAC or random suffix)
   - Gateway: `192.168.4.1`
   - Start HTTP server on port 80
   - Optional: DNS redirect to 192.168.4.1 for captive portal behavior

2. **User connects:**
   - Phone connects to AP (open or WPA2 with known password)
   - Browser opens `http://192.168.4.1` (or user types it)
   - Portal asks for setup code (printed on device label)

3. **Credential entry:**
   - User selects target Wi-Fi network from scan list
   - User enters password
   - Firmware validates by connecting briefly
   - On success: save to NVS (consider encryption)
   - On failure: retry or go back

4. **Recovery:**
   - If STA fails for 60 seconds: re-enter AP mode
   - Long-press button or `START_PROVISIONING` MQTT command triggers reprovisioning
   - Factory reset: erase NVS

5. **Security:**
   - Setup code prevents unauthorized provisioning
   - AP timeout after 10 minutes
   - WPA2-PSK on provisioning AP with device-specific password derived from setup code
   - No credentials sent over MQTT

## Telegram Architecture Analysis

### Current senders:

1. **Backend (`server/src/index.js:210-238`):**
   - `sendTelegramMessage(text)` — POST to `/bot${TG_BOT_TOKEN}/sendMessage`
   - `sendTelegramPhoto(caption)` — POST to `/bot${TG_BOT_TOKEN}/sendPhoto`
   - Credentials: environment variables `TG_BOT_TOKEN`, `TG_CHAT_ID`
   - Triggered by: `handleAlertSideEffects()` for FIRE, ALARM, TAMPER, UNLOCK, WRONG_PIN, PIR_DWELL, CAM_CAPTURE

2. **ESP32-CAM (`firmware/esp32cam/src/main.cpp:187-233`):**
   - `sendTelegramPhoto()` — raw HTTP multipart POST to `api.telegram.org`
   - Credentials: hardcoded `tg_bot_token`, `tg_chat_id`
   - Triggered by: every image capture (line 268)
   - Uses `WiFiClientSecure::setInsecure()` — NO CERTIFICATE VALIDATION

### Migration strategy without CAM reflashing:

1. Backend becomes authoritative Telegram sender (already is for most alerts)
2. CAM continues MQTT image upload (backend receives and stores)
3. Backend sends photo to Telegram using dashboard-managed credentials (implement this)
4. Old CAM Telegram credentials are revoked/rotated externally
5. CAM's obsolete direct Telegram attempts fail harmlessly (401 from Telegram)
6. Net effect: images still reach backend, backend delivers via new credentials

**This strategy is SAFE and TECHNICALLY COMPATIBLE.** The CAM's direct Telegram path will simply fail after credential rotation, which is the desired outcome. No CAM reflashing required.

### What is missing for full migration:
- Dashboard-configurable Telegram settings (not implemented)
- Encrypted storage for Telegram credentials (not implemented)
- Backend sending photo on camera capture (partially implemented — `sendTelegramPhoto()` exists but uses env vars)
- Masked responses, test endpoint, validation (not implemented)

## Immutable ESP32-CAM Analysis

### What the CAM currently does:
- Wi-Fi STA connection (hardcoded credentials)
- MQTT publish-only (no subscriptions)
- Camera capture on Serial UART byte `'1'` (30s cooldown)
- JPEG encoding and chunked MQTT upload
- Direct Telegram photo sending (hardcoded credentials, insecure TLS)

### What cannot be changed:
- Trigger mechanism (Serial UART)
- Telegram sender (hardcoded credentials)
- TLS validation (`setInsecure()`)
- Wi-Fi credentials (hardcoded)

### What CAN be achieved without reflashing:
1. Backend receives MQTT chunks and reassembles images ✓
2. Backend sends Telegram photos using dashboard credentials (needs implementation)
3. Main ESP32 can trigger CAM via UART if wired (needs hardware check)
4. CAM's direct Telegram can be neutralized by rotating credentials externally

### Blocker for mandatory upgrade:
**The ESP32-CAM cannot be made to trigger via MQTT or HTTP without reflashing.** If the main ESP32 cannot send the UART byte, camera capture is impossible. This is an integration blocker unless:
- UART wiring exists between main ESP32 and CAM (unverified)
- OR the requirement is relaxed to "backend-triggered capture via main ESP32 UART"

## Presence / PIR / Camera Analysis

### Current flow:
1. PIR goes high → `pir_stable++` in `sensor_task` (500ms cycle)
2. After 5 consecutive highs (`PIR_DEBOUNCE_THRESHOLD`): `pir_active = true`
3. If `lock_state == LOCKED` and mode is AWAY/NIGHT: `alarm_active = true`
4. After 20 seconds of continuous PIR (`PIR_DWELL_MS`): `pir_dwell_triggered = true`, `trigger_cam_capture()`
5. `trigger_cam_capture()` does HTTP GET to `CAM_CAPTURE_URL` (empty string → no-op)
6. After 120 seconds: `TAMPER` alert for stuck PIR

### Issues:
1. **20-second dwell is too short** — matches documentation drift
2. **No grace period** — brief PIR blips trigger full dwell countdown
3. **No cooldown/session tracking** — repeated PIR cycles can trigger repeated captures
4. **No dashboard configuration** — threshold is compile-time constant
5. **Broken trigger** — HTTP GET to empty URL does nothing

### Desired state machine (implementable on main ESP32):
```
IDLE
  → PIR_HIGH: PRESENCE_PENDING (start timer)
  → PIR_LOW before threshold: IDLE (cancel)
  → PIR_HIGH >= threshold: PRESENCE_CONFIRMED
    → trigger_cam_capture() [via working mechanism]
    → COOLDOWN (5 minutes)
    → IDLE when PIR clears
  → PIR_HIGH >= 120s: TAMPER_ALERT (stuck sensor)
```

## ESP32 ↔ ESP32-CAM Compatibility

### What exact mechanism does main ESP32 use to trigger the CAM?
`firmware/src/main.c:906-930` — `trigger_cam_capture()` performs `esp_http_client_perform()` with HTTP GET to `CAM_CAPTURE_URL`.

### What exact mechanism does CAM listen for?
`firmware/esp32cam/src/main.cpp:294-303` — `loop()` checks `Serial.available()` for byte `'1'` (`CAM_TRIGGER_BYTE`).

### Are they compatible?
**NO.** HTTP GET vs Serial UART byte. These are completely incompatible. No bridge exists in the codebase.

### What existing physical connection is implied by source?
The CAM firmware defines `CAM_UART_ENABLE 1`, `CAM_UART_BAUD 115200`, `CAM_UART_TRIGGER_BYTE '1'` in `app_config.h`. The main ESP32 has UART hardware available but no code to send the trigger byte. The physical wiring is unknown — it may exist but is not used by current firmware.

### Can desired 30/60-second capture policy be implemented without CAM changes?
**YES**, if:
1. UART wiring exists between main ESP32 TX and CAM RX, OR
2. The CAM's existing UART trigger mechanism is utilized by modifying main ESP32 firmware to send the byte

**Without UART wiring or CAM modification, the 30/60-second capture policy is IMPOSSIBLE.**

### Assumptions that cannot be verified from code alone:
1. Whether UART wires exist between main ESP32 and CAM
2. Whether CAM is powered from main ESP32 or independently
3. Whether CAM has a reset GPIO wired to main ESP32
4. Physical enclosure and accessibility for provisioning AP mode

## Security Findings

### SEC-01 — Hardcoded credentials in deployment config
- **File:** `server/render.yaml`
- **Severity:** CRITICAL
- **Type:** Secret exposure

### SEC-02 — Insecure TLS in CAM firmware
- **File:** `firmware/esp32cam/src/main.cpp:87,193`
- **Severity:** HIGH
- **Type:** Cryptographic failure

### SEC-03 — Weak command replay protection
- **File:** `firmware/src/main.c:516-553`
- **Severity:** HIGH
- **Type:** Authentication bypass

### SEC-04 — Non-constant-time PIN comparison
- **File:** `firmware/src/main.c:555`
- **Severity:** MEDIUM
- **Type:** Timing attack

### SEC-05 — Default universal PIN
- **File:** `firmware/include/app_config.h:30`
- **Severity:** MEDIUM
- **Type:** Weak credential

### SEC-06 — innerHTML with unsanitized event data
- **File:** `server/public/index.html:916,1104`
- **Severity:** MEDIUM
- **Type:** XSS risk

### SEC-07 — No Telegram settings endpoints
- **File:** `server/src/index.js` (absence)
- **Severity:** HIGH
- **Type:** Missing security boundary

### SEC-08 — CORS allows localhost HTTP
- **File:** `server/src/index.js:124`
- **Severity:** LOW
- **Type:** Overly permissive CORS

## Reliability Findings

### REL-01 — WiFi failure halts system
- **File:** `firmware/src/main.c:999-1001`
- **Severity:** HIGH
- **Evidence:** `ESP_LOGE(TAG, "WiFi connection failed - system halted")` with no recovery path.

### REL-02 — No watchdog timer
- **Severity:** MEDIUM
- **Evidence:** No wdt or task watchdog configuration found.

### REL-03 — Blocking sensor task
- **Severity:** MEDIUM
- **Evidence:** 500ms blocking delay in sensor_task.

## Backend/API Findings

### API-01 — POST /api/pin exists but should not
- **File:** `server/src/index.js:645-665`
- **Severity:** HIGH (for keypad removal requirement)
- **Evidence:** Endpoint publishes `SET_PIN:${pin}` command. Should be removed with keypad.

### API-02 — No Telegram settings endpoints
- **File:** `server/src/index.js` (absence)
- **Severity:** HIGH
- **Evidence:** Documentation claims `GET/PUT/DELETE /api/settings/telegram`. Not implemented.

### API-03 — Command validation allows only 8 commands
- **File:** `server/src/index.js:733`
- **Severity:** INFO
- **Evidence:** Hardcoded allowlist. Future commands require code change.

## Dashboard Findings

### UI-01 — PIN configuration UI present
- **File:** `server/public/index.html:399-407`
- **Severity:** HIGH (for keypad removal requirement)
- **Evidence:** PIN input and Update PIN button call `POST /api/pin`.

### UI-02 — Viewer mode allows read access without token
- **File:** `server/public/index.html:622-630`
- **Severity:** INFO
- **Evidence:** `skipLogin()` sets `VIEWER_MODE = true` and clears token. Controls are disabled but state/events/camera are still fetched.

### UI-03 — 10-second command timeout is UI-only
- **File:** `server/public/index.html:1134-1148`
- **Severity:** MEDIUM
- **Evidence:** Timer clears after 10s but does not cancel the actual HTTP request. Dashboard shows "timeout" while command may still execute.

## Firmware Findings

### FW-01 — No WiFi provisioning
- **File:** `firmware/src/main.c:207-237`
- **Severity:** HIGH
- **Evidence:** STA only, hardcoded credentials, no AP fallback.

### FW-02 — No OTA without URL
- **File:** `firmware/src/main.c:882-904`
- **Severity:** INFO
- **Evidence:** `OTA_URL` is empty string by default. OTA works only if configured.

### FW-03 — MQTT TLS uses global CA bundle
- **File:** `firmware/src/main.c:275-278`
- **Severity:** LOW
- **Evidence:** `crt_bundle_attach = esp_crt_bundle_attach` uses ESP-IDF's global CA bundle. Acceptable for public brokers.

## Deployment Findings

### DEP-01 — Render.yaml contains live secrets
- **File:** `server/render.yaml`
- **Severity:** CRITICAL
- **Evidence:** MQTT credentials hardcoded.

### DEP-02 — Netlify redirects API to Render
- **File:** `server/netlify.toml`
- **Severity:** INFO
- **Evidence:** Dashboard is SPA, API calls proxied to Render. CORS must allow both origins.

### DEP-03 — Ephemeral filesystem risk
- **File:** `server/render.yaml`
- **Severity:** MEDIUM
- **Evidence:** Render web services have ephemeral filesystem. `data.db` and `data/cam/` will be lost on redeploy unless persistent disk is configured.

## Dead / Legacy / Incomplete Code

### Dead code:
- `firmware/include/app_config.h:52-57` — `CAM_CAPTURE_URL`, `CAM_CAPTURE_TIMEOUT_MS`, `CAM_UART_ENABLE`, `CAM_UART_BAUD`, `CAM_UART_TRIGGER_BYTE` — UART constants unused by main firmware code
- `firmware/include/app_config.h:104-105` — `LIGHT_SLEEP_MIN_MS`, `WAKE_TIMER_MS` — defined but never used
- `firmware/src/main.c:100-101` — `initialize_sntp`, `mqtt_app_start` declarations are used
- `server/public/index.html:521` — `let API_KEY = null` — declared but never used

### Incomplete features:
- Telegram dashboard settings (documented, not implemented)
- Presence state machine (documented, not implemented)
- Wi-Fi provisioning (documented, not implemented)
- Camera capture via MQTT (documented, not implemented)

## Secret Exposure Review

### Files containing secrets (NOT tracked in baseline):
- `firmware/include/app_config.h` — Wi-Fi SSID/password, MQTT credentials, broker URI, default PIN
- `server/.env` — MQTT credentials, DASH_TOKEN, Telegram bot token, Telegram chat ID

### Files with secret-shaped placeholders (TRACKED, safe):
- `firmware/include/app_config_example.h` — sanitized template
- `firmware/include/app_config_local.example.h` — sanitized template
- `server/.env.example` — sanitized template

### Previously committed secrets:
- The `legacy-iotlabesp` remote (`origin/master`) contains the original push with live credentials in `firmware/include/app_config.h`. This history is publicly readable on GitHub and cannot be fully purged without rewriting history.

## Required Changes

### Phase 1 — Remove keypad runtime dependency
- Remove keypad GPIO initialization (`keypad_init()`)
- Remove keypad scanning (`scan_keypad()`)
- Remove PIN buffer, lockout, and validation variables
- Remove `SET_PIN` command handler
- Remove `POST /api/pin` endpoint
- Remove PIN UI from dashboard
- Remove keypad-specific Telegram alerts
- Remove `failed_attempts` NVS field

### Phase 2 — Implement software access/unlock
- Retain `POST /api/command` as primary unlock path
- Implement deliberate hold-to-unlock in dashboard (2-second press)
- Add command status tracking (Sent, Acknowledged, Failed, Timed-out)
- Maintain rate limiting and authentication

### Phase 3 — Main ESP32 Wi-Fi NVS provisioning + captive portal
- Add NVS keys for STA SSID/password
- Implement AP+STA concurrent mode
- Add HTTP server with provisioning portal
- Add captive portal / DNS redirect
- Add setup code authentication
- Add credential validation before NVS write
- Add 10-minute timeout
- Replace `wifi_init_sta()` with provisioning-aware flow

### Phase 4 — Migrate Telegram authority to backend
- Implement `GET/PUT/DELETE /api/settings/telegram` endpoints
- Add AES-256-GCM encryption for stored credentials
- Add masked response format
- Add test endpoint
- Add validation and rate limiting
- Remove direct Telegram from CAM (requires reflashing — OPTIONAL FUTURE)
- Backend sends photo on camera capture

### Phase 5 — Implement sustained-presence state machine
- Replace 20-second dwell with configurable 30/60-second threshold
- Add 15-second grace period
- Add per-session capture tracking (one capture per presence episode)
- Add 5-minute cooldown
- Make threshold dashboard-configurable via backend
- Add stuck-PIR detection (existing 120s tamper logic is acceptable)

### Phase 6 — Main ESP32 triggers CAM via available mechanism
- Determine if UART wiring exists between main ESP32 and CAM
- If yes: modify main ESP32 to send UART trigger byte
- If no: document that manual/local provisioning is the only CAM trigger path
- Backend can still request capture via main ESP32 if wired

### Phase 7 — Dashboard UX/settings integration
- Remove PIN configuration UI
- Add presence threshold settings
- Add Telegram settings UI
- Improve command status display
- Add offline state indicators

### Phase 8 — Integration/regression/security tests
- Add tests for provisioning flow (mocked)
- Add tests for Telegram settings endpoints
- Add tests for presence state machine
- Add tests for hold-to-unlock UX
- Add firmware integration tests

### Phase 9 — Hardware test checklist
- Verify UART wiring between main ESP32 and CAM (if required)
- Test AP provisioning with phone
- Test credential persistence across power cycles
- Test 30/60-second presence capture
- Test Telegram delivery end-to-end
- Test alarm and safety behaviors

## Optional Future Changes

- ESP32-CAM OTA without reflashing current firmware — **IMPOSSIBLE** without existing OTA partition and bootloader support. Current CAM firmware has no OTA support.
- ESP32-CAM provisioning — requires reflashing. Current CAM has no provisioning code.
- WebAuthn/passkeys — requires user accounts, sessions, server-side roles.
- Per-device MQTT credentials — requires broker ACL support.
- Hardware schematic/PCB documentation — does not exist.

## Final Audit Verdict

### Working:
- Backend HTTP API with authentication
- MQTT state/alert/metric ingestion
- Dashboard UI with SSE live updates
- FreeRTOS sensor/control/health tasks
- Lock/unlock/silence/arm commands
- Auto-lock and schedule-based modes
- Alarm logic (PIR, reed, fire)
- Lowdb persistence
- Backend test suite (62/62 passing)
- Both firmware projects compile successfully

### Partially implemented:
- Camera capture (backend reassembly works, trigger path broken)
- Telegram delivery (backend env-based works, dashboard settings missing)
- Presence detection (basic dwell exists, configurable state machine missing)
- Wi-Fi (hardcoded, no provisioning)

### Missing:
- Keypad removal (code still present despite documentation)
- Dashboard-configurable Telegram settings
- Encrypted Telegram storage
- Main ESP32 Wi-Fi provisioning
- Presence threshold configuration
- Proper replay protection (nonce tracking)
- Watchdog timer

### Broken:
- ESP32-CAM trigger path (HTTP vs Serial mismatch)
- Presence documentation vs implementation (20s vs 30/60s)
- Keypad documentation vs implementation (claims removed, fully present)

### Unverified on hardware:
- AP provisioning flow
- UART wiring between ESP32s
- CAM trigger latency
- Telegram delivery end-to-end
- MQTT broker behavior under load
- OTA update process

---

## UPGRADE_IMPLEMENTATION_PLAN_2026-09-17

## Phase 0 — Preserve security/regression baseline
**Status:** COMPLETE
**Objective:** Capture current state in `baseline/full-project-pre-audit` branch with all tests passing.

## Phase 1 — Remove keypad runtime dependency and dead PIN functionality
**Objective:** Eliminate all keypad-related code from firmware, backend, and dashboard.
**Files:**
- `firmware/src/main.c`
- `firmware/include/app_config.h`
- `server/src/index.js`
- `server/public/index.html`
- `server/test/security.test.mjs`
**Behavior:**
- No keypad GPIO configuration
- No PIN scanning or validation
- No `SET_PIN` command handling
- No `POST /api/pin` endpoint
- No PIN UI in dashboard
- `failed_attempts` NVS field removed
**Dependencies:** None
**Security considerations:** Eliminates timing-leak PIN comparison and universal default PIN.
**Tests:** Update `security.test.mjs` to remove PIN tests. Add regression test confirming `/api/pin` returns 404.
**Rollback risk:** LOW — keypad functionality is isolated.

## Phase 2 — Implement secure software access/unlock
**Objective:** Make authenticated dashboard the primary unlock mechanism with deliberate UI interaction.
**Files:**
- `server/public/index.html`
- `server/src/index.js`
**Behavior:**
- Dashboard hold-to-unlock: user must press and hold UNLOCK button for 2 seconds
- Command states: Sent, Acknowledged, Failed, Timed-out
- Backend validates command and publishes to MQTT
- Rate limiting applies
**Dependencies:** Phase 1 complete
**Security considerations:** Prevents accidental unlock. Maintains Bearer auth and MQTT command signing.
**Tests:** Dashboard probe verifies hold-to-unlock states. Backend tests verify command flow.
**Rollback risk:** LOW — existing command path unchanged.

## Phase 3 — Implement main ESP32 Wi-Fi NVS provisioning + captive portal
**Objective:** Replace hardcoded Wi-Fi with persistent runtime provisioning.
**Files:**
- `firmware/src/main.c`
- `firmware/include/app_config.h`
- `firmware/include/app_config_example.h`
**Behavior:**
- Normal boot: check NVS for STA credentials → connect
- If no credentials OR STA fails 60s: start AP `SmartLock-Setup-XXXX`
- HTTP server on 192.168.4.1 serves provisioning portal
- Setup code authentication
- Wi-Fi scan, selection, password entry
- Credential validation before NVS write
- 10-minute timeout, AP shutdown on success
**Dependencies:** None
**Security considerations:** Setup code prevents unauthorized provisioning. Credentials stored in NVS (consider encryption).
**Tests:** Unit tests for provisioning state machine. Integration tests with mocked Wi-Fi.
**Rollback risk:** MEDIUM — Wi-Fi behavior fundamentally changes. Requires hardware testing.

## Phase 4 — Migrate Telegram authority to backend/dashboard
**Objective:** Backend becomes sole Telegram sender using dashboard-managed credentials.
**Files:**
- `server/src/index.js`
- `server/public/index.html`
- `server/.env.example`
**Behavior:**
- Implement `GET/PUT/DELETE /api/settings/telegram`
- Encrypt stored bot token and chat ID with AES-256-GCM
- Never return full bot token to browser
- Masked status response
- Test connection endpoint
- Backend sends photo on camera capture using stored credentials
- Old CAM Telegram credentials rotated externally (owner action)
**Dependencies:** Phase 2 complete
**Security considerations:** `SETTINGS_ENCRYPTION_KEY` required at startup. Credentials never logged.
**Tests:** Test settings CRUD, encryption/decryption, masked responses, test endpoint.
**Rollback risk:** MEDIUM — Telegram delivery path changes. CAM direct delivery fails after credential rotation.

## Phase 5 — Implement sustained-presence state machine on main ESP32
**Objective:** Replace 20-second dwell with configurable presence confirmation.
**Files:**
- `firmware/src/main.c`
- `firmware/include/app_config.h`
- `server/src/index.js`
- `server/public/index.html`
**Behavior:**
- IDLE → PRESENCE_PENDING (PIR high)
- → PRESENCE_CONFIRMED (threshold exceeded: 30s or 60s)
- → CAPTURE_TRIGGERED (request camera)
- → COOLDOWN (5 minutes, no repeat captures)
- → IDLE (PIR clears)
- 15-second grace: brief PIR blips do not reset timer
- Stuck-PIR detection at 120s
- Dashboard-configurable threshold
**Dependencies:** Phase 3 complete (for reliable Wi-Fi), Phase 6 (for working camera trigger)
**Security considerations:** Single capture per session prevents spam. Cooldown prevents flooding.
**Tests:** Simulate PIR sequences, verify state transitions, verify single capture per session.
**Rollback risk:** MEDIUM — changes sensor behavior.

## Phase 6 — Make main ESP32 trigger existing immutable CAM
**Objective:** Establish working trigger path from main ESP32 to CAM without reflashing CAM.
**Files:**
- `firmware/src/main.c`
**Behavior:**
- Determine if UART wiring exists between main ESP32 and CAM
- If yes: add UART initialization and send `CAM_TRIGGER_BYTE` ('1') with 30s cooldown
- If no: document limitation, rely on manual/local provisioning for CAM triggers
- Backend can request capture via MQTT command to main ESP32
**Dependencies:** Phase 5 complete
**Security considerations:** UART trigger is local/physical only. No network exposure.
**Tests:** Hardware test required. Cannot be fully verified in CI.
**Rollback risk:** HIGH — requires hardware verification.

## Phase 7 — Dashboard UX/settings integration
**Objective:** Update dashboard for new features and remove keypad remnants.
**Files:**
- `server/public/index.html`
**Behavior:**
- Remove PIN configuration UI
- Add presence threshold settings
- Add Telegram settings UI (encrypted, masked)
- Improve command status display
- Add offline state indicators
**Dependencies:** Phases 1, 4, 5 complete
**Security considerations:** Settings changes require Bearer auth.
**Tests:** Dashboard probe verifies new UI elements and settings flow.
**Rollback risk:** LOW — UI changes only.

## Phase 8 — Integration/regression/security tests
**Objective:** Ensure all phases work together and security boundaries hold.
**Files:**
- `server/test/*.mjs`
- New test files for provisioning, Telegram, presence
**Behavior:**
- All existing tests continue passing
- New tests for each new feature
- Security regression tests for new attack surfaces
**Dependencies:** All implementation phases complete
**Tests:** Full test suite, firmware unit tests if possible.
**Rollback risk:** LOW — tests only.

## Phase 9 — Hardware test checklist for owner
**Objective:** Verify real-world behavior before declaring upgrade complete.
**Checklist:**
1. Flash main ESP32 with provisioning-enabled firmware
2. Test AP provisioning with phone
3. Verify Wi-Fi persistence across power cycles
4. Test dashboard unlock with hold-to-unlock
5. Verify auto-lock after 10 seconds
6. Test 30/60-second presence capture
7. Verify stuck-PIR tamper alert
8. Test fire auto-unlock
9. Verify Telegram delivery via backend
10. Verify CAM trigger via available mechanism
11. Test alarm silence and reset
12. Verify MQTT reconnection and state recovery

## Feasibility Matrix

| Requirement | Currently implemented? | Can be implemented without new hardware? | Requires main ESP32 flash? | Requires ESP32-CAM flash? | Recommended approach | Evidence |
|-------------|----------------------|----------------------------------------|---------------------------|--------------------------|---------------------|----------|
| Remove keypad | NO — fully present | YES | YES | NO | Remove keypad code from firmware, backend, dashboard | `firmware/src/main.c:342-788`, `server/src/index.js:645-665`, `server/public/index.html:399-407` |
| Software unlock | YES | YES | NO | NO | Existing `POST /api/command` already works | `server/src/index.js:723-750`, `firmware/src/main.c:576-581` |
| Change main ESP32 Wi-Fi without recompiling | NO | YES | YES | NO | NVS provisioning + AP captive portal | `firmware/src/main.c:207-237` hardcodes credentials |
| No-display Wi-Fi setup | NO | YES | YES | NO | ESP-IDF `wifi_provisioning` with softAP scheme | ESP-IDF `wifi_provisioning` component available |
| Dashboard Telegram config | NO | YES | NO | NO | Implement `GET/PUT/DELETE /api/settings/telegram` | Absent from `server/src/index.js` |
| Send camera image to dashboard | PARTIAL | YES | NO | NO | Backend reassembles MQTT chunks (works), trigger path broken | `server/src/index.js:407-484` |
| Send camera image using dashboard Telegram credentials | PARTIAL | YES | NO | NO | Backend `sendTelegramPhoto()` exists but uses env vars | `server/src/index.js:224-238` |
| 30-second presence capture | PARTIAL | YES | YES | NO | State machine with configurable threshold | `PIR_DWELL_MS=20` in `firmware/include/app_config.h:38` |
| 60-second presence capture | PARTIAL | YES | YES | NO | State machine with configurable threshold | Same as above |
| Configurable presence threshold | NO | YES | YES | NO | Backend setting + MQTT command to device | Not implemented |
| Single image per presence episode | NO | YES | YES | NO | Session tracking in firmware state machine | Not implemented |
| Camera cooldown | PARTIAL | YES | YES | NO | Extend existing `CAM_COOLDOWN_MS` to per-session cooldown | `CAM_COOLDOWN_MS=30` in `firmware/include/app_config.h:42` |
| Main ESP32 OTA | YES | YES | YES | NO | `OTA_URL` configurable via env/OTA command | `firmware/src/main.c:882-904` |
| ESP32-CAM OTA without reflashing current firmware | NO | NO | NO | YES | Impossible — CAM firmware has no OTA support | No OTA partition or bootloader support in CAM firmware |

## Final Status

AUDIT COMPLETE — READY FOR TECHNICAL REVIEW
