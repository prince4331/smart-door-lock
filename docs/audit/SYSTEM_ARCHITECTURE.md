# System Architecture — Smart Door Lock

Audit date: 2026-09-18
Branch: `mvp/final-smart-lock-upgrade`

This document records the implemented feature architecture for the Smart Door Lock MVP. It reflects the validated software access, runtime Wi-Fi provisioning, encrypted Telegram configuration, presence detection state machine, backend APIs, and camera integration status.

## 1. Component map

```text
                         authenticated browser dashboard
                         DASH_TOKEN administrator session
                                      |
                                      | REST + authenticated SSE
                                      v
                         Node/Express backend
                         ├─ state, events, commands
                         ├─ Telegram settings (AES-256-GCM)
                         ├─ private camera storage
                         └─ MQTT client
                                      |
                         ┌────────────┴────────────┐
                         |                         |
                  smartlock/command        smartlock/cam/command
                         |                         |
                         v                         v
                 ESP32 lock controller        ESP32-CAM
                 ├─ PIR/reed/fire           ├─ one-shot JPEG
                 ├─ servo/buzzer/LED        ├─ meta/chunk publish
                 ├─ NVS STA config          └─ capture acknowledgement
                 └─ command ACK
                         |
                         v
                  physical lock and sensors

Camera chunks -> backend reassembly -> private latest.jpg
                                      -> authenticated /api/cam/latest
Backend -> encrypted Telegram settings -> Telegram Bot API
```

## 2. Access and provisioning

### Dashboard access

- The keypad and PIN path are removed. There is no default PIN, PIN update endpoint, or local PIN unlock.
- The dashboard authenticates with one shared `DASH_TOKEN`; its holder is the administrator. There are no user accounts, roles, or WebAuthn/passkeys yet.
- Unlock requires a deliberate hold-to-unlock interaction and reports Sent, Acknowledged, Failed, or Timed-out states.
- The backend publishes lock commands to `smartlock/command`; the lock publishes results to `smartlock/command_ack`.
- When the backend or MQTT path is offline, remote electronic unlock is unavailable. The documented mechanical/inside emergency-access assumption remains the offline fallback.

### AP/STA provisioning

Both firmwares store normal STA credentials locally and use the same provisioning contract:

| Firmware | Setup AP | Gateway | Access |
| --- | --- | --- | --- |
| Lock ESP32 | `SmartLock-Setup-<device suffix>` | `192.168.4.1` | Unique per-device **Setup code** |
| ESP32-CAM | `SmartLock-CAM-Setup-<device suffix>` | `192.168.4.1` | Unique per-device **Setup code** |

The setup code is stored in NVS/Preferences and should be printed as a QR/enclosure label. It is not a universal password and is not derived only from a public MAC address.

The device enters provisioning when credentials are absent, STA fails for 60 seconds, or an authenticated online `START_PROVISIONING` command is received. The nearby-phone portal scans/selects Wi-Fi, tests new credentials before replacing working credentials, saves successful credentials, has no lock controls, and stops after 10 minutes of inactivity. A password entered on the portal is not sent through the MQTT command channel.

## 3. Presence, safety, and camera flow

### Persistent motion detection

- The feature is labeled **Persistent motion detection** and is PIR-based, not guaranteed human-presence detection.
- The dashboard selects a 30-second or 60-second threshold.
- A first validated PIR activation starts a presence session. Continued HIGH output or repeated motion inside a 15-second absence grace keeps the session active.
- At the selected threshold, the lock publishes one `PRESENCE_CONFIRMED` event containing an event ID, threshold, start time, and confirmation time, then requests one camera capture.
- A session produces at most one automatic capture. A global five-minute cooldown prevents another automatic capture.
- A stuck PIR produces one tamper/fault event, not repeated photos.
- Forced-entry capture remains immediate. Fire detection preserves the local auto-unlock safety behavior.

### MQTT camera command flow

```text
backend publishes CAPTURE { event_id, timestamp }
  -> smartlock/cam/command
ESP32-CAM validates the JSON, event ID, and cooldown
  -> captures exactly once
  -> publishes acknowledgement
  -> publishes smartlock/cam/meta
  -> publishes ordered smartlock/cam/chunk messages
backend reassembles and persists latest.jpg outside the public web root
  -> dashboard fetches authenticated /api/cam/latest
```

Malformed commands are rejected, duplicate event IDs are ignored, and the camera does not capture continuously. Manual authenticated dashboard capture uses the same backend-owned command path. The current flow has no UART trigger, `CAM_CAPTURE_URL`, camera HTTP upload/stream dependency, or direct camera Telegram transmission.

## 4. Alerts and Telegram delivery

The lock publishes state and alert messages over MQTT. The backend normalizes and persists alerts, broadcasts authenticated dashboard events, and owns Telegram delivery.

Telegram settings are available only through the authenticated dashboard settings endpoints:

- `GET /api/settings/telegram`
- `PUT /api/settings/telegram`
- `DELETE /api/settings/telegram`
- `POST /api/settings/telegram/test`

The backend encrypts stored bot token and chat ID with AES-256-GCM using required `SETTINGS_ENCRYPTION_KEY` material. Nonce/IV and authentication tag are stored with ciphertext; the complete token is never returned or logged. The backend sends at most one Telegram photo per event ID and records sanitized success/failure without blocking dashboard delivery.

## 5. Trust boundaries and current limitations

| Boundary | Current mechanism | Limitation |
| --- | --- | --- |
| Browser to backend | `DASH_TOKEN` Bearer authentication; health is the only anonymous API route | One shared administrator, no users or roles |
| Backend to devices | Authenticated MQTT command flow with acknowledgements | No offline queued unlock |
| Devices to broker | Provisioned STA and deployment-specific MQTT credentials | Per-device identity/revocation remains future work |
| Camera to backend | MQTT metadata/chunks; private backend storage | No direct camera HTTP or Telegram path |
| Backend to Telegram | Backend-owned encrypted settings and delivery | Requires `SETTINGS_ENCRYPTION_KEY` and operator rotation |
| Camera media to dashboard | Authenticated `/api/cam/latest`, private storage | No public static image asset |

No production credentials belong in documentation, `.env.example`, firmware source, or committed configuration. Rotate Wi-Fi, MQTT, Telegram, `DASH_TOKEN`, setup-code, and encryption-key material that may have appeared in repository history before deployment.

WebAuthn/passkeys are intentionally deferred until after user accounts, sessions, revocation, and server-side roles are implemented.
