# ESP32 Smart Lock (ESP-IDF + FreeRTOS)

Industry-grade scaffold with FreeRTOS tasks, MQTT, dual AP/STA, and power management hooks.

## Requirements
- VS Code + PlatformIO extension (recommended) or `pio` CLI
- ESP32-DevKitC or equivalent
- Toolchain from PlatformIO (auto-installed)

## Build & Flash
```bash
# From firmware/ directory
pio run
pio run --target upload
pio device monitor -b 115200
```

## Configure
Edit `include/app_config.h` before flashing:
- `WIFI_STA_SSID` / `WIFI_STA_PASS`
- `WIFI_AP_SSID` / `WIFI_AP_PASS` (fallback provisioning AP)
- `MQTT_BROKER_URI` (e.g., mqtt://192.168.1.10:1883 or mqtts://...)
- Topics as needed
- Timing constants (auto lock, publish interval)

## Features in this scaffold
- FreeRTOS tasks: sensors, control, MQTT, power, keypad stub
- Event groups for mode and connectivity state
- Queues for sensor events and commands
- MQTT publish/subscribe for state, alerts, and commands
- Dual-mode Wi-Fi (STA + AP fallback)
- Light sleep hook with GPIO + timer wake
- Servo (LEDC PWM), buzzer, LEDs driven in control task

## Next steps
- Implement keypad scanning and password validation (replace placeholder task)
- Move secrets to NVS (current defaults are compile-time)
- Add TLS certs for MQTT if using cloud
- Fine-tune light-sleep policy and ULP program for always-on sensing
- Add OTA using the provided OTA partitions
