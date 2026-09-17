# IoT Smart Door Lock

A dashboard-controlled ESP32 door-lock system with an ESP32-CAM companion, MQTT telemetry, persistent-motion alerts, and backend-owned Telegram delivery.

## Current architecture

- Electronic access is dashboard-only. The keypad and PIN path are removed; there is no default PIN or local PIN unlock.
- The dashboard authenticates with one shared `DASH_TOKEN`. Its holder is the administrator. There are no user accounts or roles yet.
- An authenticated lock or unlock request is sent to the backend, which publishes `smartlock/command`; the lock publishes `smartlock/command_ack`.
- The dashboard unlock interaction is deliberate hold-to-unlock (approximately two seconds) with Sent, Acknowledged, Failed, and Timed-out states.
- Both ESP32 firmwares use stored STA credentials. If STA is unavailable, they start WPA2 setup APs:
  - `SmartLock-Setup-<device suffix>`
  - `SmartLock-CAM-Setup-<device suffix>`
  Both use gateway `192.168.4.1` and a unique per-device setup code printed as a QR/enclosure label.
- A nearby phone is required for provisioning at a new or offline location. The portal does not expose lock controls or accept a cloud Wi-Fi password. An online `START_PROVISIONING` request only asks the device to enter local provisioning mode; the Wi-Fi password is not sent over MQTT.
- Persistent motion detection is PIR-based, not guaranteed human-presence detection. It uses a selectable 30/60-second threshold, a 15-second absence grace, a five-minute automatic-capture cooldown, and one automatic capture per presence session. Forced-entry capture is immediate.
- Fire auto-unlock and forced-entry safety behavior are preserved.
- Camera capture is MQTT-driven: the backend publishes `CAPTURE` with an event ID and timestamp to `smartlock/cam/command`; the ESP32-CAM captures once and publishes `smartlock/cam/meta` and `smartlock/cam/chunk`. The backend stores the latest image outside the public web root and serves it through authenticated `/api/cam/latest`. Manual capture uses the same backend-owned command path.
- Telegram credentials are configured through the authenticated dashboard, encrypted with AES-256-GCM by the backend, and used only by the backend. The camera never sends Telegram messages.
- This documentation and `server/.env.example` contain placeholders only. Do not commit production credentials; rotate any credentials previously exposed in repository history.

## Components

| Component | Purpose |
| --- | --- |
| ESP32 lock controller | PIR, reed, and fire sensing; servo control; MQTT state, alerts, and command handling |
| ESP32-CAM | One-shot JPEG capture and MQTT chunk publication |
| MQTT broker | Command, telemetry, acknowledgement, and camera-media transport |
| Node/Express backend | Authentication, persistence, camera reassembly, settings, and Telegram delivery |
| Browser dashboard | Authenticated administration, provisioning guidance, presence settings, and camera view |

## Setup

1. Copy `server/.env.example` to a local, untracked `.env`. Set `DASH_TOKEN`, `SETTINGS_ENCRYPTION_KEY` (at least 32 random bytes), and the local MQTT settings. Do not copy production credentials into the repository.
2. Configure Telegram through the authenticated dashboard settings page. The backend encrypts the stored settings; do not place Telegram credentials in firmware or documentation.
3. Flash both firmwares. On first boot, or after 60 seconds of failed STA connection, connect a nearby phone to the device setup AP and open `http://192.168.4.1`.
4. Enter the unique **Setup code** from the device QR/enclosure label, scan/select the target Wi-Fi network, and let the firmware test the credentials before saving them. Provisioning times out after 10 minutes if unused.
5. Start the backend and open the dashboard. Authenticate with `DASH_TOKEN`; there is no anonymous or PIN-based access path.

## Operation and limits

- Remote lock/unlock and provisioning commands require the backend and MQTT path to be online. There is no offline electronic unlock path; use the documented mechanical/inside emergency-access assumption when the system is offline.
- A presence session starts on validated PIR motion. Continued or repeated motion inside the 15-second grace keeps it active. At the selected 30/60-second threshold, the lock publishes one `PRESENCE_CONFIRMED` event and requests one camera capture. The session cannot produce another automatic capture, and the global cooldown is five minutes.
- A stuck PIR produces one tamper/fault event, not repeated photos. Forced entry produces an immediate capture. Fire detection still triggers the local auto-unlock safety behavior.
- The current authentication model is one shared administrator token, not multi-user role control. WebAuthn/passkeys are a future upgrade after user accounts, sessions, and server-side roles exist.
- The current flow has no keypad/PIN path, camera UART trigger, `CAM_CAPTURE_URL`, direct camera Telegram delivery, or camera HTTP upload/stream dependency.

## Verification status

All backend test suites (26 suites, 93 tests) and security probes pass cleanly without regressions. Both the Main ESP32 firmware and the ESP32-CAM companion firmware compile with zero warnings or errors. For detailed verification results, see `docs/MVP_FINAL_STATUS.md`. For physical bench testing and validation on actual hardware, follow `docs/HARDWARE_MVP_TEST_CHECKLIST.md`.
