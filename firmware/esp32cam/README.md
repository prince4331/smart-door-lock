# ESP32-CAM Firmware

Arduino/PlatformIO firmware for one-shot camera capture and MQTT image delivery. The camera has no keypad, lock-control, direct Telegram, or HTTP capture role.

## Current behavior

- Normal operation uses STA credentials stored in Preferences/NVS.
- If STA is unavailable for 60 seconds, the device starts the WPA2 setup AP `SmartLock-CAM-Setup-<device suffix>` with gateway `192.168.4.1`.
- The setup AP uses the unique per-device **Setup code** from the QR/enclosure label, tests new Wi-Fi credentials before saving them, and times out after 10 minutes of inactivity.
- The setup portal has no lock controls and never displays or logs an existing password. A nearby phone is required when the camera is offline at a new location.
- After MQTT connection, the camera subscribes to `smartlock/cam/command` and accepts the `CAPTURE` command with an event ID and timestamp.
- Malformed commands are rejected. Duplicate event IDs are ignored. The camera-side cooldown is enforced, and each valid command produces at most one capture.
- A capture publishes an acknowledgement and image chunks to the backend-owned `smartlock/cam/meta` and `smartlock/cam/chunk` topics. The backend reassembles the JPEG, stores it outside the public web root, and makes it available through authenticated `/api/cam/latest`.
- Manual authenticated dashboard capture uses the same backend-owned command path.
- Telegram settings and delivery belong to the backend. The camera contains no Telegram token or chat ID and never sends a Telegram message.

## Provisioning

1. Flash the firmware and power the ESP32-CAM.
2. Connect a nearby phone to `SmartLock-CAM-Setup-<device suffix>` and open `http://192.168.4.1`.
3. Enter the unique **Setup code** printed on the device label or QR code.
4. Select the target Wi-Fi network and submit its credentials. The firmware tests the connection before replacing the stored configuration.
5. After a successful test, the camera reconnects as STA and subscribes to the MQTT camera command topic.

The setup code is unique per device, stored locally, and must not be committed or derived only from a public MAC address.

## MQTT camera flow

```text
backend -> smartlock/cam/command
  CAPTURE { event_id, timestamp }

ESP32-CAM -> smartlock/cam/meta
  image sequence and length metadata

ESP32-CAM -> smartlock/cam/chunk
  ordered JPEG chunks

backend -> private latest.jpg -> authenticated dashboard
```

The camera does not expose `/stream` or `/capture` endpoints, does not use a serial trigger, and does not call Telegram.

## Build and flash

Run these commands after installing PlatformIO and selecting the camera port:

```bash
cd firmware/esp32cam
python -m platformio run
python -m platformio run --target upload --upload-port COMx
python -m platformio device monitor --port COMx -b 115200
```

This README provides the operator commands but does not claim that a build or hardware run has passed.

## Security

Do not place production Wi-Fi, MQTT, setup-code, or Telegram credentials in source or documentation. Rotate credentials that may have appeared in repository history before deploying a device.
