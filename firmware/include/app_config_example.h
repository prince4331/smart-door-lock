// Example configuration template for the ESP32 smart-lock firmware.
//
// Copy this file to `app_config.h` and fill in your own values.
// NEVER commit the real `app_config.h` with live credentials.
// The committed `app_config.h` currently contains real values and must be
// rotated (see docs/audit/AUDIT_REPORT.md, SEC-01).

#pragma once

// ---- Wi-Fi (station) ----
#define WIFI_STA_SSID       "YOUR_WIFI_SSID"
#define WIFI_STA_PASS       "YOUR_WIFI_PASSWORD"

// ---- MQTT broker (use mqtts:// in production) ----
#define MQTT_BROKER_URI     "mqtts://your-broker.example.com:8883"
#define MQTT_CLIENT_ID      "esp32-smartlock"
#define MQTT_USERNAME       "YOUR_MQTT_USERNAME"
#define MQTT_PASSWORD       "YOUR_MQTT_PASSWORD"

#define SNTP_SERVER_PRIMARY    "pool.ntp.org"
#define SNTP_SERVER_SECONDARY  "time.google.com"
#define TZ_INFO               "UTC0"

#define NVS_NAMESPACE          "smartlock"
#define NVS_KEY_LOCK_STATE     "lock_state"
#define NVS_KEY_PASSWORD       "password"
#define NVS_KEY_BOOT_COUNT     "boot_count"

#define CMD_TIMESTAMP_WINDOW_SEC  300   // Accept commands within 5 min window

extern char g_device_id[32];

#define MQTT_TOPIC_STATE    "smartlock/state"
#define MQTT_TOPIC_ALERT    "smartlock/alert"
#define MQTT_TOPIC_CMD      "smartlock/command"
#define MQTT_TOPIC_METRIC   "smartlock/metric"
#define MQTT_TOPIC_ACK      "smartlock/command_ack"

#define DEFAULT_LOCK_PASSWORD "CHANGE_ME"   // Default PIN; rotate on first boot
#define AUTO_LOCK_MS          (10 * 1000)
#define SENSOR_SCAN_MS        500
#define MQTT_PUBLISH_MS       2000
#define ALARM_DURATION_MS     30000
#define WRONG_ATTEMPTS_MAX    3
#define KEYPAD_LOCKOUT_MS    (30 * 1000)
#define DOOR_HELD_OPEN_MS    (20 * 1000)
#define PIR_DWELL_MS         (20 * 1000)
#define TAMPER_PIR_MS        (120 * 1000)
#define TAMPER_REED_MS       (120 * 1000)

#define CAM_COOLDOWN_MS      (30 * 1000)

#define SCHEDULE_ENABLED     1
#define NIGHT_START_HH       23
#define NIGHT_START_MM       0
#define NIGHT_END_HH         6
#define NIGHT_END_MM         0

#define OTA_URL             ""

#define CAM_CAPTURE_URL     ""
#define CAM_CAPTURE_TIMEOUT_MS 5000

#define CAM_UART_ENABLE     1
#define CAM_UART_BAUD       115200
#define CAM_UART_TRIGGER_BYTE '1'

#define PIR_DEBOUNCE_THRESHOLD  5
#define REED_DEBOUNCE_THRESHOLD 3
