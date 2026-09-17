# Feature Completeness Matrix — Smart Door Lock

Audit date: 2026-09-18
Branch: `mvp/final-smart-lock-upgrade`

Status wording:

- **Implemented** — verified and built cleanly as part of the MVP architecture.
- **Current limitation** — intentionally present in the current single-token design.
- **Future** — planned after its stated prerequisite.
- **Hardware test required** — firmware builds cleanly, physical bench verification required.

## Lock firmware

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Keypad and PIN path removed | Implemented | No keypad/PIN access path in firmware or dashboard |
| Dashboard-only electronic unlock | Implemented | Authenticated command flow with deliberate hold-to-unlock |
| NVS STA provisioning | Implemented | Stored credentials, 60-second failed-STA fallback, 10-minute setup timeout |
| Fixed setup AP gateway | Implemented | `192.168.4.1` captive portal |
| Unique setup-code label | Implemented | Per-device **Setup code** intended for QR/enclosure label |
| Offline limitation | Implemented | No offline electronic unlock; local safety behavior remains |
| MQTT lock command and ACK | Implemented | `smartlock/command` and `smartlock/command_ack` with replay protection |
| Persistent motion thresholds | Implemented | Selectable 30/60 seconds with 15-second grace; NVS-backed |
| One capture per presence session | Implemented | State machine (`IDLE` -> `PENDING` -> `CONFIRMED` -> `CAPTURED` -> `COOLDOWN`) |
| 5-minute capture cooldown | Implemented | Enforced globally on presence-triggered captures |
| Stuck-PIR fault | Implemented | 120s timer emits single `STUCK_PIR_TAMPER` event, no repeated photos |
| Forced-entry capture | Implemented | Immediate capture behavior preserved |
| Fire auto-unlock | Implemented | Local safety interrupt (<1ms) preserved offline |
| Build verification | Implemented | ESP-IDF clean build (RAM: 10.8%, Flash: 67.7% < 80%) |
| Physical bench run | Hardware test required | Follow `docs/HARDWARE_MVP_TEST_CHECKLIST.md` |

## ESP32-CAM firmware

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Preferences/NVS STA provisioning | Implemented | 60-second fallback and 10-minute setup timeout |
| Fixed setup AP gateway | Implemented | `192.168.4.1` |
| Unique setup-code label | Implemented | Per-device **Setup code** intended for QR/enclosure label |
| MQTT `CAPTURE` command | Implemented | `smartlock/cam/command` with event ID and timestamp |
| Malformed/duplicate command handling | Implemented | Reject malformed commands and duplicate event IDs |
| One capture per valid command | Implemented | Cooldown and single-capture behavior |
| MQTT image chunks | Implemented | `smartlock/cam/meta` and `smartlock/cam/chunk` |
| Backend-owned Telegram delivery | Implemented | Camera has no Telegram credentials or sender |
| Serial trigger integrity | Implemented | Listens on UART0 Serial byte `'1'`; firmware untouched |
| Build verification | Implemented | PlatformIO clean build (RAM: 17.8%, Flash: 31.1%) |
| Physical bench run | Hardware test required | Follow `docs/HARDWARE_MVP_TEST_CHECKLIST.md` |

## Backend and dashboard

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Single `DASH_TOKEN` administrator | Current limitation | One shared credential; no accounts or roles |
| Authenticated lock commands | Implemented | `POST /api/command` publishes replay-protected MQTT command |
| PIN endpoint removed | Implemented | No `POST /api/pin` or PIN UI |
| Authenticated Telegram settings | Implemented | GET/PUT/DELETE/test settings routes |
| AES-256-GCM Telegram storage | Implemented | Required `SETTINGS_ENCRYPTION_KEY`; nonce/IV and tag stored with ciphertext |
| Masked settings response | Implemented | Complete bot token is not returned |
| Backend Telegram delivery | Implemented | One delivery per event ID; sanitized failure state |
| Camera command publication | Implemented | Backend publishes `CAPTURE` to `smartlock/cam/command` |
| Presence settings API & UI | Implemented | `GET/PUT /api/settings/presence` with 30s/60s radio buttons and feedback |
| Wi-Fi provisioning trigger UI | Implemented | `START_PROVISIONING` card with confirmation modal & setup steps |
| 15-second offline threshold | Implemented | Dashboard periodic liveness tracking flags offline device at 15s |
| Non-alarming camera notice | Implemented | Clarifies that automatic camera trigger requires hardware serial link |
| Private camera media | Implemented | Backend storage and authenticated `/api/cam/latest` |
| Test suite verification | Implemented | 26 test suites passed (93/93 tests), Phase 0 verify & probe passed |
| User accounts and roles | Current limitation | Prerequisite for stronger access control |
| WebAuthn/passkeys | Future | Planned only after user accounts and server-side roles |

## Cross-cutting

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| No production credentials in repo | Implemented | Placeholders only; local deployment values remain untracked |
| Credential rotation reminder | Open | Rotate previously exposed Wi-Fi, MQTT, Telegram, token, setup-code material |
| Phase 0 security controls | Implemented | Verified via `test/probe-phase0.mjs` and `test/verify-phase0.mjs` |
| Hardware test checklist | Implemented | Comprehensive checklist in `docs/HARDWARE_MVP_TEST_CHECKLIST.md` |
