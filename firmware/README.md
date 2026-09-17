# ESP32 Smart Lock Firmware

ESP-IDF/FreeRTOS firmware for the lock controller. Electronic access is provided by the authenticated dashboard; the damaged keypad/PIN path is not part of this firmware.

## Current behavior

- No keypad initialization, scanning, PIN comparison, failed-attempt counter, PIN lockout, or `SET_PIN` command.
- `LOCK`, `UNLOCK`, `SILENCE`, and the retained device commands are received over MQTT. The firmware publishes command acknowledgements on `smartlock/command_ack`.
- Normal operation uses STA credentials stored in NVS. If credentials are absent or STA fails for 60 seconds, the device enters provisioning mode.
- The provisioning AP is `SmartLock-Setup-<device suffix>` with gateway `192.168.4.1`. Access uses the unique per-device **Setup code** from the QR/enclosure label.
- The setup portal scans and selects Wi-Fi networks, tests new credentials before replacing working credentials, saves successful credentials to NVS, and stops after 10 minutes of inactivity. It has no lock/unlock controls and does not log passwords.
- An authenticated online `START_PROVISIONING` command can request provisioning mode, but new Wi-Fi passwords are entered only by a nearby phone on the setup AP and are not sent over MQTT.
- Persistent motion detection uses a dedicated state machine (PRESENCE_IDLE -> PRESENCE_PENDING -> PRESENCE_CONFIRMED -> PRESENCE_CAPTURED -> PRESENCE_COOLDOWN) with a configurable 30-second or 60-second threshold (stored in NVS under key `presence_sec`, default 30s) and a five-minute cooldown.
- Threshold selection uses secure replay-protected commands (`SET_PRESENCE_30`, `SET_PRESENCE_60`) and acknowledges results on `smartlock/command_ack`.
- When presence is confirmed, the device attempts one camera capture. If a verified hardware serial link is absent, the trigger abstraction cleanly publishes `CAM_TRIGGER_UNAVAILABLE` without blocking sensors or crashing.
- A stuck PIR (120s continuous active) produces one tamper alert (`TAMPER: PIR sensor stuck active`) without re-triggering camera captures. Forced-entry capture remains immediate. Fire detection preserves local auto-unlock safety behavior.
- When the backend or MQTT path is offline, dashboard electronic unlock is unavailable. Local fire and forced-entry safety behavior remains independent of dashboard connectivity.

## Provisioning

1. Flash the firmware and power the device.
2. If there is no valid stored STA configuration, connect a nearby phone to `SmartLock-Setup-<device suffix>` and open `http://192.168.4.1`.
3. Enter the unique **Setup code** printed on the device label or QR code.
4. Scan/select the target network and submit its SSID and password. The firmware tests the connection before committing it to NVS.
5. After a successful test, the device leaves AP mode and reconnects as STA. If STA fails for 60 seconds, the AP fallback is available again.

The setup code must be unique per device, stored in NVS, and never committed or derived only from a public MAC address.

## MQTT interfaces

| Direction | Topic | Purpose |
| --- | --- | --- |
| Backend to lock | `smartlock/command` | Authenticated lock/device commands (`LOCK`, `UNLOCK`, `SILENCE`, `ARM`, `SET_PRESENCE_30`, `SET_PRESENCE_60`, etc.) |
| Lock to backend | `smartlock/command_ack` | Command result and presence-setting acknowledgement |
| Lock to backend | `smartlock/state` | Lock, alarm, door, sensor, presence state/threshold, and connectivity state |
| Lock to backend | `smartlock/alert` | Forced entry, fire, presence (`PRESENCE_CONFIRMED`), camera status (`CAM_TRIGGER_UNAVAILABLE`), fault, and safety alerts |
| Lock to backend | `smartlock/metric` | Device metrics (heap, uptime, RSSI, firmware version) |

Note on camera trigger: Presence detection is complete, but automatic new-photo capture requires an existing main-ESP32 → CAM serial connection. No new hardware was added.

## Build and flash

Run these commands after installing the project toolchain:

```bash
cd firmware
pio run
pio run --target upload
pio device monitor -b 115200
```

This README provides the operator commands but does not claim that a build or hardware run has passed.

## Security

Do not place production Wi-Fi, MQTT, setup-code, or Telegram credentials in source or documentation. Rotate credentials that may have appeared in repository history before deploying a device.
