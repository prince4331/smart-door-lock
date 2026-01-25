#pragma once

// Wi-Fi credentials (STA mode). Replace with production values or load from NVS.
#define WIFI_STA_SSID       "UIU-STUDENT"
#define WIFI_STA_PASS       "12345678"

// Wi-Fi SoftAP settings for provisioning/fallback.
#define WIFI_AP_SSID        "smartlock-setup"
#define WIFI_AP_PASS        "12345678"
#define WIFI_AP_MAX_CONN    4

// MQTT broker settings (self-hosted). For TLS, set mqtts:// and configure certificates.
#define MQTT_BROKER_URI     "mqtts://7073d14c632e4e68b0ec38acf49d0c37.s1.eu.hivemq.cloud:8883"
#define MQTT_CLIENT_ID      "esp32-smartlock"
#define MQTT_USERNAME       "princeofhell069"
#define MQTT_PASSWORD       "Need@break069"

// SNTP time synchronization
#define SNTP_SERVER_PRIMARY    "pool.ntp.org"
#define SNTP_SERVER_SECONDARY  "time.google.com"
#define TZ_INFO               "UTC0"

// NVS (Non-Volatile Storage) keys
#define NVS_NAMESPACE          "smartlock"
#define NVS_KEY_LOCK_STATE     "lock_state"
#define NVS_KEY_PASSWORD       "password"
#define NVS_KEY_BOOT_COUNT     "boot_count"

// Command validation
#define CMD_TIMESTAMP_WINDOW_SEC  300   // Accept commands within 5 min window

// Unique device ID from MAC address (set at runtime)
extern char g_device_id[32];

// Topics
#define MQTT_TOPIC_STATE    "smartlock/state"
#define MQTT_TOPIC_ALERT    "smartlock/alert"
#define MQTT_TOPIC_CMD      "smartlock/command"
#define MQTT_TOPIC_METRIC   "smartlock/metric"
#define MQTT_TOPIC_ACK      "smartlock/command_ack"

// Device defaults
#define DEFAULT_LOCK_PASSWORD "1069"   // Default PIN
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

// Schedule (local time, 24h)
#define SCHEDULE_ENABLED     1
#define NIGHT_START_HH       23
#define NIGHT_START_MM       0
#define NIGHT_END_HH         6
#define NIGHT_END_MM         0

// OTA
#define OTA_URL             ""

// ESP32-CAM trigger (optional). Example: "http://192.168.1.50/capture"
#define CAM_CAPTURE_URL     ""
#define CAM_CAPTURE_TIMEOUT_MS 5000

// ===== HARDENING PATCH 1: Sensor debouncing =====
#define PIR_DEBOUNCE_THRESHOLD  3     // 3 stable samples before event
#define REED_DEBOUNCE_THRESHOLD 3
#define FIRE_DEBOUNCE_THRESHOLD 2     // Faster for safety-critical sensor

// ===== HARDENING PATCH 3: Health monitoring =====
#define HEAP_MIN_THRESHOLD_BYTES    20480  // Alert if < 20KB free
#define HEALTH_CHECK_MS             30000  // Check every 30 seconds

// ===== HARDENING PATCH 4: WiFi exponential backoff =====
#define WIFI_BACKOFF_MIN_MS     500     // Start with 500ms
#define WIFI_BACKOFF_MAX_MS     60000   // Cap at 60 seconds
#define WIFI_BACKOFF_MULTIPLIER 1.5    // 1.5x per retry

// GPIO mapping (boot-safe pins)
#define PIN_PIR        GPIO_NUM_25
#define PIN_REED       GPIO_NUM_26
#define PIN_FIRE       GPIO_NUM_33
#define PIN_BUZZER     GPIO_NUM_27
#define PIN_SERVO      GPIO_NUM_13
#define PIN_LED_RED    GPIO_NUM_4
#define PIN_LED_GREEN  GPIO_NUM_2

// Sensor logic levels (1 = active high, 0 = active low)
#define PIR_ACTIVE_LEVEL   1
#define REED_ACTIVE_LEVEL  1
#define FIRE_ACTIVE_LEVEL  1

// Pull configuration per sensor input
#define PIR_PULLUP_ENABLE   0
#define PIR_PULLDOWN_ENABLE 1
#define REED_PULLUP_ENABLE  1
#define REED_PULLDOWN_ENABLE 0
#define FIRE_PULLUP_ENABLE   0
#define FIRE_PULLDOWN_ENABLE 1

// Keypad pins (4x4). Rows = outputs, Cols = inputs
#define PIN_KP_R1      GPIO_NUM_23
#define PIN_KP_R2      GPIO_NUM_22
#define PIN_KP_R3      GPIO_NUM_21
#define PIN_KP_R4      GPIO_NUM_14
#define PIN_KP_C1      GPIO_NUM_32
#define PIN_KP_C2      GPIO_NUM_18
#define PIN_KP_C3      GPIO_NUM_17
#define PIN_KP_C4      GPIO_NUM_16

// Power management
#define LIGHT_SLEEP_MIN_MS    100
#define WAKE_TIMER_MS         5000

// Logging tag
#define TAG_MAIN "SMARTLOCK"
