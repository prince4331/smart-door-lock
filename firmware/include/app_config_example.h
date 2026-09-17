// Example configuration template for the ESP32 smart-lock firmware.
//
// Copy this file to `app_config.h` and fill in your own values.
// NEVER commit the real `app_config.h` with live credentials.
// Provision Wi-Fi through the setup AP; do not hardcode production Wi-Fi
// credentials here.

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
#define NVS_KEY_BOOT_COUNT     "boot_count"
#define NVS_KEY_STA_SSID       "sta_ssid"
#define NVS_KEY_STA_PASS       "sta_pass"
#define NVS_KEY_SETUP_CODE     "setup_code"

#define CMD_TIMESTAMP_WINDOW_SEC  300   // Accept commands within 5 min window

extern char g_device_id[32];

#define MQTT_TOPIC_STATE    "smartlock/state"
#define MQTT_TOPIC_ALERT    "smartlock/alert"
#define MQTT_TOPIC_CMD      "smartlock/command"
#define MQTT_TOPIC_METRIC   "smartlock/metric"
#define MQTT_TOPIC_ACK      "smartlock/command_ack"
#define MQTT_TOPIC_CAM_CMD  "smartlock/cam/command"

#define AUTO_LOCK_MS          (10 * 1000)
#define SENSOR_SCAN_MS        500
#define MQTT_PUBLISH_MS       2000
#define ALARM_DURATION_MS     30000
#define DOOR_HELD_OPEN_MS     (20 * 1000)
#define PIR_DWELL_MS          (20 * 1000)
#define TAMPER_PIR_MS         (120 * 1000)
#define TAMPER_REED_MS        (120 * 1000)
#define PRESENCE_THRESHOLD_MS (30 * 1000)
#define PRESENCE_GRACE_MS     (15 * 1000)
#define CAPTURE_COOLDOWN_MS   (5 * 60 * 1000)

#define SCHEDULE_ENABLED     1
#define NIGHT_START_HH       23
#define NIGHT_START_MM       0
#define NIGHT_END_HH         6
#define NIGHT_END_MM         0

#define OTA_URL             ""

#define WIFI_PROV_SSID_PREFIX "SmartLock-Setup-"
#define WIFI_PROV_PASS_MIN   8
#define WIFI_PROV_TIMEOUT_MS (10 * 60 * 1000)
#define WIFI_STA_FAIL_DELAY_MS 60000
