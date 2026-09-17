# Feature Completeness Matrix — Smart Door Lock

Audit date: 2026-09-17
Branch: `feature/software-access-provisioning-alerts`

Status wording:

- **Implemented** — part of the requested feature architecture.
- **Current limitation** — intentionally present in the current single-token design.
- **Future** — planned after its stated prerequisite.
- **Not verified** — no build, runtime, browser, or hardware evidence is claimed in this documentation update.

## Lock firmware

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Keypad and PIN path removed | Implemented | No keypad/PIN access path is documented or used by the dashboard |
| Dashboard-only electronic unlock | Implemented | Authenticated command flow with deliberate hold-to-unlock |
| NVS STA provisioning | Implemented | Stored credentials, 60-second failed-STA fallback, 10-minute setup timeout |
| Fixed setup AP gateway | Implemented | `192.168.4.1` |
| Unique setup-code label | Implemented | Per-device **Setup code** intended for QR/enclosure label |
| Offline limitation | Implemented | No offline electronic unlock; local safety behavior remains |
| MQTT lock command and ACK | Implemented | `smartlock/command` and `smartlock/command_ack` |
| Persistent motion thresholds | Implemented | Selectable 30/60 seconds with 15-second grace |
| One capture per presence session | Implemented | Session capture flag plus five-minute global cooldown |
| Stuck-PIR fault | Implemented | One tamper/fault event, no repeated automatic photos |
| Forced-entry capture | Implemented | Immediate capture behavior preserved |
| Fire auto-unlock | Implemented | Local safety behavior preserved |
| Build/runtime verification | Not verified | Record actual ESP-IDF and hardware results separately |

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
| HTTP/UART/direct-Telegram paths removed | Implemented | No camera HTTP endpoint, serial trigger, or direct Telegram flow |
| Build/runtime verification | Not verified | Record actual PlatformIO and hardware results separately |

## Backend and dashboard

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| Single `DASH_TOKEN` administrator | Current limitation | One shared credential; no accounts or roles |
| Authenticated lock commands | Implemented | `POST /api/command` publishes MQTT command |
| PIN endpoint removed | Implemented | No `POST /api/pin` or PIN UI |
| Authenticated Telegram settings | Implemented | GET/PUT/DELETE/test settings routes |
| AES-256-GCM Telegram storage | Implemented | Required `SETTINGS_ENCRYPTION_KEY`; nonce/IV and tag stored with ciphertext |
| Masked settings response | Implemented | Complete bot token is not returned |
| Backend Telegram delivery | Implemented | One delivery per event ID; sanitized failure state |
| Camera command publication | Implemented | Backend publishes `CAPTURE` to `smartlock/cam/command` |
| Presence-setting acknowledgement | Implemented | Pending/success/failure/offline dashboard states |
| Private camera media | Implemented | Backend storage and authenticated `/api/cam/latest` |
| User accounts and roles | Current limitation | Prerequisite for stronger access control |
| WebAuthn/passkeys | Future | Planned only after user accounts and server-side roles |
| Backend/browser verification | Not verified | Record actual test and browser results separately |

## Cross-cutting

| Feature | Status | Evidence / notes |
| --- | --- | --- |
| No production credentials in documentation/examples | Implemented | Placeholders only; local deployment values remain untracked |
| Credential rotation reminder | Open | Rotate previously exposed Wi-Fi, MQTT, Telegram, token, setup-code, and encryption-key material |
| Phase 0 authentication and camera privacy controls | Implemented | Retained as baseline controls; verification is not claimed here |
| End-to-end firmware/backend/hardware verification | Not verified | No result is asserted by this documentation update |
