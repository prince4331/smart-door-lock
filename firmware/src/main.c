#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"

#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_sntp.h"
#include "esp_netif.h"
#include "esp_crt_bundle.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "mqtt_client.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "esp_app_desc.h"
#include "esp_https_ota.h"
#include "esp_http_client.h"

#include "app_config.h"
#include "servo_control.h"

static const char *TAG = TAG_MAIN;

char g_device_id[32] = {0};

static EventGroupHandle_t wifi_event_group;
#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT BIT1

static esp_mqtt_client_handle_t mqtt_client = NULL;
static bool mqtt_connected = false;
static uint32_t mqtt_reconnects = 0;

typedef enum {
    LOCK_STATE_LOCKED = 0,
    LOCK_STATE_UNLOCKED = 1
} lock_state_t;

static lock_state_t lock_state = LOCK_STATE_LOCKED;

typedef enum {
    MODE_HOME = 0,
    MODE_AWAY = 1,
    MODE_NIGHT = 2
} security_mode_t;

static security_mode_t current_mode = MODE_HOME;

static int pir_stable = 0;
static int reed_stable = 0;
static int fire_stable = 0;
static bool pir_active = false;
static bool reed_active = false;
static bool fire_active = false;

static bool alarm_active = false;
static int64_t alarm_start_ms = 0;
static bool alarm_silenced = false;

static int64_t unlock_start_ms = 0;
static int64_t door_open_start_ms = 0;
static bool door_held_alerted = false;
static int64_t pir_active_start_ms = 0;
static bool pir_dwell_triggered = false;
static bool pir_tamper_alerted = false;
static bool reed_tamper_alerted = false;

#define KEYPAD_MAX_LEN 10
static char keypad_buffer[KEYPAD_MAX_LEN + 1];
static int keypad_pos = 0;
static int64_t keypad_lockout_until_ms = 0;
static char lock_password[KEYPAD_MAX_LEN + 1] = DEFAULT_LOCK_PASSWORD;

static nvs_handle_t nvs_storage_handle;
static uint32_t boot_count = 0;
static uint32_t failed_attempts = 0;

static TaskHandle_t sensor_task_handle = NULL;
static TaskHandle_t control_task_handle = NULL;
static TaskHandle_t health_task_handle = NULL;

typedef struct {
    char command[64];
} command_t;
static QueueHandle_t command_queue = NULL;

static int wifi_retry_count = 0;
static int wifi_backoff_ms = WIFI_BACKOFF_MIN_MS;

static void wifi_init_sta(void);
static void initialize_sntp(void);
static void mqtt_app_start(void);
static void gpio_init_all(void);
static void keypad_init(void);
static char scan_keypad(void);
static void configure_input(gpio_num_t pin, bool pullup, bool pulldown);
static void load_nvs_state(void);
static void save_nvs_state(void);
static void publish_state(void);
static void publish_alert(const char *type, const char *detail);
static void publish_command_ack(const char *command, const char *status, const char *reason);
static void publish_metric(void);
static void handle_command(const char *cmd);
static void update_schedule_mode(void);
static void perform_ota_update(void);
static void trigger_cam_capture(void);
static void apply_lock_state(lock_state_t new_state, const char *reason, bool notify);
static void sensor_task(void *pvParameters);
static void control_task(void *pvParameters);
static void health_task(void *pvParameters);

static bool is_command_word(const char *cmd)
{
    return (strcmp(cmd, "LOCK") == 0 ||
            strcmp(cmd, "UNLOCK") == 0 ||
            strcmp(cmd, "SILENCE") == 0 ||
            strcmp(cmd, "ARM") == 0 ||
            strcmp(cmd, "OTA") == 0 ||
            strcmp(cmd, "MODE_HOME") == 0 ||
            strcmp(cmd, "MODE_AWAY") == 0 ||
            strcmp(cmd, "MODE_NIGHT") == 0);
}

static int64_t now_ms(void) {
    return esp_timer_get_time() / 1000;
}

static void wifi_event_handler(void* arg, esp_event_base_t event_base,
                              int32_t event_id, void* event_data)
{
    (void)arg;
    (void)event_data;
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        if (wifi_retry_count < 10) {
            ESP_LOGW(TAG, "WiFi disconnected, retry %d in %d ms", wifi_retry_count + 1, wifi_backoff_ms);
            vTaskDelay(pdMS_TO_TICKS(wifi_backoff_ms));
            esp_wifi_connect();
            wifi_retry_count++;
            int next_backoff = (int)(wifi_backoff_ms * WIFI_BACKOFF_MULTIPLIER);
            wifi_backoff_ms = next_backoff > WIFI_BACKOFF_MAX_MS ? WIFI_BACKOFF_MAX_MS : next_backoff;
        } else {
            ESP_LOGE(TAG, "WiFi connection failed after retries");
            xEventGroupSetBits(wifi_event_group, WIFI_FAIL_BIT);
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        wifi_retry_count = 0;
        wifi_backoff_ms = WIFI_BACKOFF_MIN_MS;
        xEventGroupSetBits(wifi_event_group, WIFI_CONNECTED_BIT);
        esp_wifi_set_ps(WIFI_PS_NONE);
    }
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)handler_args;
    (void)base;
    esp_mqtt_event_handle_t event = event_data;

    switch ((esp_mqtt_event_id_t)event_id) {
        case MQTT_EVENT_CONNECTED:
            mqtt_connected = true;
            esp_mqtt_client_subscribe(mqtt_client, MQTT_TOPIC_CMD, 1);
            publish_state();
            break;

        case MQTT_EVENT_DISCONNECTED:
            ESP_LOGW(TAG, "MQTT disconnected");
            mqtt_connected = false;
            mqtt_reconnects++;
            break;

        case MQTT_EVENT_DATA: {
            char cmd[64];
            int len = event->data_len < (int)sizeof(cmd) - 1 ? event->data_len : (int)sizeof(cmd) - 1;
            memcpy(cmd, event->data, len);
            cmd[len] = '\0';
            command_t msg;
            strncpy(msg.command, cmd, sizeof(msg.command) - 1);
            msg.command[sizeof(msg.command) - 1] = '\0';
            xQueueSend(command_queue, &msg, 0);
            break;
        }

        case MQTT_EVENT_ERROR:
            ESP_LOGE(TAG, "MQTT ERROR event");
            if (event->error_handle->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT) {
                ESP_LOGE(TAG, "TLS stack error: 0x%x", event->error_handle->esp_tls_stack_err);
            }
            mqtt_connected = false;
            break;

        default:
            break;
    }
}

static void wifi_init_sta(void)
{
    wifi_event_group = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_t instance_any_id;
    esp_event_handler_instance_t instance_got_ip;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                        &wifi_event_handler, NULL, &instance_any_id));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                        &wifi_event_handler, NULL, &instance_got_ip));

    wifi_config_t wifi_config = {
        .sta = {
            .ssid = WIFI_STA_SSID,
            .password = WIFI_STA_PASS,
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
        },
    };

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

}

static void initialize_sntp(void)
{
    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, SNTP_SERVER_PRIMARY);
    esp_sntp_setservername(1, SNTP_SERVER_SECONDARY);
    esp_sntp_init();

    int retry = 0;
    const int retry_count = 15;
    while (esp_sntp_get_sync_status() == SNTP_SYNC_STATUS_RESET && ++retry < retry_count) {
        vTaskDelay(pdMS_TO_TICKS(2000));
    }

    if (retry < retry_count) {
        time_t now = 0;
        time(&now);
        struct tm timeinfo;
        localtime_r(&now, &timeinfo);
        char strftime_buf[64];
        strftime(strftime_buf, sizeof(strftime_buf), "%c", &timeinfo);
    } else {
        ESP_LOGW(TAG, "Time sync timeout - continuing anyway");
    }

    setenv("TZ", TZ_INFO, 1);
    tzset();

    vTaskDelay(pdMS_TO_TICKS(2000));
}

static void mqtt_app_start(void)
{

    esp_mqtt_client_config_t mqtt_cfg = {
        .broker = {
            .address.uri = MQTT_BROKER_URI,
            .verification = {
                .use_global_ca_store = false,
                .crt_bundle_attach = esp_crt_bundle_attach,
                .skip_cert_common_name_check = false,
            }
        },
        .credentials = {
            .username = MQTT_USERNAME,
            .authentication.password = MQTT_PASSWORD,
        },
        .session = {
            .last_will = {
                .topic = MQTT_TOPIC_ALERT,
                .msg = "{\"status\":\"offline\"}",
                .qos = 1,
                .retain = 0,
            }
        },
        .network = {
            .timeout_ms = 30000,
            .refresh_connection_after_ms = 60000,
        },
    };

    mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
    if (mqtt_client == NULL) {
        ESP_LOGE(TAG, "Failed to initialize MQTT client");
        return;
    }

    ESP_ERROR_CHECK(esp_mqtt_client_register_event(mqtt_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL));
    ESP_ERROR_CHECK(esp_mqtt_client_start(mqtt_client));
}

static void configure_input(gpio_num_t pin, bool pullup, bool pulldown)
{
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << pin),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = pullup ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE,
        .pull_down_en = pulldown ? GPIO_PULLDOWN_ENABLE : GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);
}

static void gpio_init_all(void)
{
    configure_input(PIN_PIR, PIR_PULLUP_ENABLE, PIR_PULLDOWN_ENABLE);
    configure_input(PIN_REED, REED_PULLUP_ENABLE, REED_PULLDOWN_ENABLE);
    configure_input(PIN_FIRE, FIRE_PULLUP_ENABLE, FIRE_PULLDOWN_ENABLE);

    gpio_config_t io_conf = {
        .pin_bit_mask = ((1ULL << PIN_BUZZER) | (1ULL << PIN_LED_RED) | (1ULL << PIN_LED_GREEN)),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);

    gpio_set_level(PIN_BUZZER, 0);
    gpio_set_level(PIN_LED_RED, 1);
    gpio_set_level(PIN_LED_GREEN, 0);

}

static void keypad_init(void)
{
    gpio_config_t io_conf = {
        .pin_bit_mask = ((1ULL << PIN_KP_R1) | (1ULL << PIN_KP_R2) | (1ULL << PIN_KP_R3) | (1ULL << PIN_KP_R4)),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);

    io_conf.pin_bit_mask = ((1ULL << PIN_KP_C1) | (1ULL << PIN_KP_C2) | (1ULL << PIN_KP_C3) | (1ULL << PIN_KP_C4));
    io_conf.mode = GPIO_MODE_INPUT;
    io_conf.pull_down_en = GPIO_PULLDOWN_ENABLE;
    gpio_config(&io_conf);

    gpio_set_level(PIN_KP_R1, 0);
    gpio_set_level(PIN_KP_R2, 0);
    gpio_set_level(PIN_KP_R3, 0);
    gpio_set_level(PIN_KP_R4, 0);

}

static char scan_keypad(void)
{
    const gpio_num_t rows[] = {PIN_KP_R1, PIN_KP_R2, PIN_KP_R3, PIN_KP_R4};
    const gpio_num_t cols[] = {PIN_KP_C1, PIN_KP_C2, PIN_KP_C3, PIN_KP_C4};
    const char keys[4][4] = {
        {'1', '2', '3', 'A'},
        {'4', '5', '6', 'B'},
        {'7', '8', '9', 'C'},
        {'*', '0', '#', 'D'}
    };

    for (int r = 0; r < 4; r++) {
        gpio_set_level(rows[r], 1);
        vTaskDelay(pdMS_TO_TICKS(1));
        for (int c = 0; c < 4; c++) {
            if (gpio_get_level(cols[c]) == 1) {
                char key = keys[r][c];
                while (gpio_get_level(cols[c]) == 1) {
                    vTaskDelay(pdMS_TO_TICKS(10));
                }
                gpio_set_level(rows[r], 0);
                return key;
            }
        }
        gpio_set_level(rows[r], 0);
    }

    return '\0';
}

static void load_nvs_state(void)
{
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs_storage_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Error opening NVS: %s", esp_err_to_name(err));
        return;
    }

    nvs_get_u32(nvs_storage_handle, NVS_KEY_BOOT_COUNT, &boot_count);
    boot_count++;
    nvs_set_u32(nvs_storage_handle, NVS_KEY_BOOT_COUNT, boot_count);

    uint8_t saved_state = 0;
    if (nvs_get_u8(nvs_storage_handle, NVS_KEY_LOCK_STATE, &saved_state) == ESP_OK) {
        lock_state = (lock_state_t)saved_state;
    }

    nvs_get_u32(nvs_storage_handle, "failed_att", &failed_attempts);

    size_t pass_len = sizeof(lock_password);
    if (nvs_get_str(nvs_storage_handle, NVS_KEY_PASSWORD, lock_password, &pass_len) != ESP_OK) {
        strncpy(lock_password, DEFAULT_LOCK_PASSWORD, sizeof(lock_password) - 1);
        lock_password[sizeof(lock_password) - 1] = '\0';
        nvs_set_str(nvs_storage_handle, NVS_KEY_PASSWORD, lock_password);
    }

    nvs_commit(nvs_storage_handle);

}

static void save_nvs_state(void)
{
    nvs_set_u8(nvs_storage_handle, NVS_KEY_LOCK_STATE, (uint8_t)lock_state);
    nvs_set_u32(nvs_storage_handle, "failed_att", failed_attempts);
    nvs_set_str(nvs_storage_handle, NVS_KEY_PASSWORD, lock_password);
    nvs_commit(nvs_storage_handle);
}

static void publish_state(void)
{
    if (!mqtt_connected) return;

    char payload[512];
    time_t now;
    time(&now);

    const char *lock_str[] = {"LOCKED", "UNLOCKED"};
    const char *mode_str[] = {"HOME", "AWAY", "NIGHT"};

    snprintf(payload, sizeof(payload),
             "{\"device_id\":\"%s\",\"lock_state\":\"%s\",\"security_mode\":\"%s\","
             "\"sensors\":{\"pir\":%s,\"reed\":%s,\"fire\":%s},"
             "\"alarm\":%s,\"alarm_silenced\":%s,\"boot_count\":%lu,\"failed_attempts\":%lu,\"timestamp\":%lld}",
             g_device_id, lock_str[lock_state], mode_str[current_mode],
             pir_active ? "true" : "false",
             reed_active ? "true" : "false",
             fire_active ? "true" : "false",
             alarm_active ? "true" : "false",
             alarm_silenced ? "true" : "false",
             boot_count, failed_attempts, (long long)now);

    esp_mqtt_client_publish(mqtt_client, MQTT_TOPIC_STATE, payload, 0, 1, 0);
}

static void publish_alert(const char *type, const char *detail)
{
    if (!mqtt_connected) return;

    char payload[256];
    time_t now;
    time(&now);

    snprintf(payload, sizeof(payload),
             "{\"device_id\":\"%s\",\"type\":\"%s\",\"message\":\"%s\",\"detail\":\"%s\",\"timestamp\":%lld}",
             g_device_id, type, detail, detail, (long long)now);

    esp_mqtt_client_publish(mqtt_client, MQTT_TOPIC_ALERT, payload, 0, 1, 0);
}

static void publish_command_ack(const char *command, const char *status, const char *reason)
{
    if (!mqtt_connected) return;

    char payload[256];
    time_t now;
    time(&now);

    snprintf(payload, sizeof(payload),
             "{\"device_id\":\"%s\",\"command\":\"%s\",\"status\":\"%s\",\"reason\":\"%s\",\"timestamp\":%lld}",
             g_device_id, command, status, reason, (long long)now);

    esp_mqtt_client_publish(mqtt_client, MQTT_TOPIC_ACK, payload, 0, 1, 0);
}

static void publish_metric(void)
{
    if (!mqtt_connected) return;

    wifi_ap_record_t ap_info;
    int rssi = -100;
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        rssi = ap_info.rssi;
    }

    size_t free_heap = esp_get_free_heap_size();
    uint32_t uptime_s = (uint32_t)(esp_timer_get_time() / 1000000ULL);
    const esp_app_desc_t *app_desc = esp_app_get_description();
    const char *fw_version = app_desc ? app_desc->version : "unknown";

    char payload[256];
    time_t now;
    time(&now);

    snprintf(payload, sizeof(payload),
             "{\"device_id\":\"%s\",\"rssi\":%d,\"heap_free\":%lu,\"uptime_s\":%lu,\"reconnects\":%lu,\"fw_version\":\"%s\",\"timestamp\":%lld}",
             g_device_id, rssi, (unsigned long)free_heap, (unsigned long)uptime_s,
             (unsigned long)mqtt_reconnects, fw_version, (long long)now);

    esp_mqtt_client_publish(mqtt_client, MQTT_TOPIC_METRIC, payload, 0, 1, 0);
}

static bool validate_command(const char *cmd)
{
    char buf[80];
    strncpy(buf, cmd, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    char *command = strtok(buf, "|");
    char *nonce = strtok(NULL, "|");
    char *ts_str = strtok(NULL, "|");

    if (!command || !nonce || !ts_str) {
        return false;
    }

    long ts = strtol(ts_str, NULL, 10);
    time_t now;
    time(&now);
    long diff = labs((long)now - ts);
    if (diff > CMD_TIMESTAMP_WINDOW_SEC) {
        ESP_LOGW(TAG, "Command timestamp out of window: %ld sec", diff);
        return false;
    }

    if (strcmp(command, "LOCK") != 0 &&
        strcmp(command, "UNLOCK") != 0 &&
        strcmp(command, "SILENCE") != 0 &&
        strcmp(command, "ARM") != 0 &&
        strcmp(command, "OTA") != 0 &&
        strcmp(command, "MODE_HOME") != 0 &&
        strcmp(command, "MODE_AWAY") != 0 &&
        strcmp(command, "MODE_NIGHT") != 0) {
        if (strncmp(command, "SET_PIN:", 8) != 0) {
            return false;
        }
    }

    return true;
}

static void handle_command(const char *cmd)
{
    bool has_delim = (strchr(cmd, '|') != NULL);
    if (has_delim) {
        if (!validate_command(cmd)) {
            ESP_LOGW(TAG, "Invalid command rejected: %s", cmd);
            publish_command_ack(cmd, "rejected", "invalid command");
            return;
        }
    } else if (!is_command_word(cmd)) {
        ESP_LOGW(TAG, "Invalid command rejected: %s", cmd);
        publish_command_ack(cmd, "rejected", "invalid command");
        return;
    }

    char cmd_copy[80];
    strncpy(cmd_copy, cmd, sizeof(cmd_copy) - 1);
    cmd_copy[sizeof(cmd_copy) - 1] = '\0';
    char *command = has_delim ? strtok(cmd_copy, "|") : cmd_copy;


    if (strcmp(command, "LOCK") == 0) {
        apply_lock_state(LOCK_STATE_LOCKED, "Command lock", true);
        publish_command_ack(command, "ok", "locked");
    } else if (strcmp(command, "UNLOCK") == 0) {
        apply_lock_state(LOCK_STATE_UNLOCKED, "Command unlock", true);
        publish_command_ack(command, "ok", "unlocked");
    } else if (strcmp(command, "SILENCE") == 0) {
        alarm_active = false;
        alarm_silenced = true;
        gpio_set_level(PIN_BUZZER, 0);
        publish_state();
        publish_command_ack(command, "ok", "silenced");
    } else if (strcmp(command, "ARM") == 0) {
        alarm_silenced = false;
        publish_state();
        publish_command_ack(command, "ok", "armed");
    } else if (strncmp(command, "SET_PIN:", 8) == 0) {
        const char *new_pin = command + 8;
        if (strlen(new_pin) >= 4 && strlen(new_pin) <= KEYPAD_MAX_LEN) {
            strncpy(lock_password, new_pin, sizeof(lock_password) - 1);
            lock_password[sizeof(lock_password) - 1] = '\0';
            save_nvs_state();
            publish_state();
            publish_command_ack("SET_PIN", "ok", "pin updated");
        } else {
            publish_command_ack("SET_PIN", "rejected", "invalid length");
        }
    } else if (strcmp(command, "OTA") == 0) {
        publish_command_ack("OTA", "ok", "starting");
        perform_ota_update();
    } else if (strcmp(command, "MODE_HOME") == 0) {
        current_mode = MODE_HOME;
        publish_state();
        publish_command_ack(command, "ok", "mode_home");
    } else if (strcmp(command, "MODE_AWAY") == 0) {
        current_mode = MODE_AWAY;
        publish_state();
        publish_command_ack(command, "ok", "mode_away");
    } else if (strcmp(command, "MODE_NIGHT") == 0) {
        current_mode = MODE_NIGHT;
        publish_state();
        publish_command_ack(command, "ok", "mode_night");
    }
}

static void sensor_task(void *pvParameters)
{

    while (1) {
        int64_t now = now_ms();
        bool keypad_locked_out = now < keypad_lockout_until_ms;
        int pir_raw = (gpio_get_level(PIN_PIR) == PIR_ACTIVE_LEVEL) ? 1 : 0;
        int reed_raw = (gpio_get_level(PIN_REED) == REED_ACTIVE_LEVEL) ? 1 : 0;
        int fire_raw = (gpio_get_level(PIN_FIRE) == FIRE_ACTIVE_LEVEL) ? 1 : 0;

        if (pir_raw == 1) {
            pir_stable++;
            if (pir_stable >= PIR_DEBOUNCE_THRESHOLD && !pir_active) {
                pir_active = true;
                pir_active_start_ms = now;
                pir_dwell_triggered = false;
                pir_tamper_alerted = false;
                publish_alert("PIR", "Motion detected");
                if (!alarm_silenced && lock_state == LOCK_STATE_LOCKED &&
                    (current_mode == MODE_AWAY || current_mode == MODE_NIGHT)) {
                    alarm_active = true;
                    alarm_start_ms = now;
                    publish_alert("ALARM", "Motion while armed");
                }
                publish_state();
            }
        } else {
            pir_stable = 0;
            if (pir_active) {
                pir_active = false;
                pir_active_start_ms = 0;
                pir_dwell_triggered = false;
                pir_tamper_alerted = false;
                publish_state();
            }
        }

        if (reed_raw == 1) {
            reed_stable++;
                if (reed_stable >= REED_DEBOUNCE_THRESHOLD && !reed_active) {
                    reed_active = true;
                    door_open_start_ms = now;
                    door_held_alerted = false;
                    reed_tamper_alerted = false;
                    publish_alert("REED", "Door opened");
                    if (!alarm_silenced && lock_state == LOCK_STATE_LOCKED) {
                        alarm_active = true;
                        alarm_start_ms = now;
                        publish_alert("ALARM", "Forced entry detected");
                        publish_alert("FORCED_ENTRY", "Door opened while locked");
                        trigger_cam_capture();
                    }
                    publish_state();
                }
        } else {
            reed_stable = 0;
            if (reed_active) {
                reed_active = false;
                door_open_start_ms = 0;
                door_held_alerted = false;
                reed_tamper_alerted = false;
                publish_state();
            }
        }

        if (fire_raw == 1) {
            fire_stable++;
            if (fire_stable >= FIRE_DEBOUNCE_THRESHOLD && !fire_active) {
                fire_active = true;
                alarm_active = true;
                alarm_silenced = false;
                alarm_start_ms = now;
                publish_alert("FIRE", "Fire detected");
                if (lock_state == LOCK_STATE_LOCKED &&
                    (current_mode == MODE_HOME || current_mode == MODE_NIGHT)) {
                    apply_lock_state(LOCK_STATE_UNLOCKED, "Fire auto-unlock", true);
                }
                publish_state();
            }
        } else {
            fire_stable = 0;
            if (fire_active) {
                fire_active = false;
                publish_state();
            }
        }

        if (reed_active && !door_held_alerted && door_open_start_ms > 0) {
            if (now - door_open_start_ms >= DOOR_HELD_OPEN_MS) {
                door_held_alerted = true;
                publish_alert("REED", "Door held open");
                if (!alarm_silenced && lock_state == LOCK_STATE_LOCKED &&
                    (current_mode == MODE_AWAY || current_mode == MODE_NIGHT)) {
                    alarm_active = true;
                    alarm_start_ms = now;
                    publish_alert("ALARM", "Door held open while armed");
                }
                publish_state();
            }
        }

        if (pir_active && !pir_dwell_triggered && pir_active_start_ms > 0) {
            if (now - pir_active_start_ms >= PIR_DWELL_MS) {
                pir_dwell_triggered = true;
                publish_alert("CAM_CAPTURE", "PIR dwell exceeded");
                trigger_cam_capture();
                publish_state();
            }
        }

        if (pir_active && !pir_tamper_alerted && pir_active_start_ms > 0) {
            if (now - pir_active_start_ms >= TAMPER_PIR_MS) {
                pir_tamper_alerted = true;
                publish_alert("TAMPER", "PIR sensor stuck active");
                publish_state();
            }
        }

        if (reed_active && !reed_tamper_alerted && door_open_start_ms > 0) {
            if (now - door_open_start_ms >= TAMPER_REED_MS) {
                reed_tamper_alerted = true;
                publish_alert("TAMPER", "Reed sensor stuck open");
                publish_state();
            }
        }

        if (!keypad_locked_out) {
            char key = scan_keypad();
            if (key != '\0') {
                gpio_set_level(PIN_BUZZER, 1);
                vTaskDelay(pdMS_TO_TICKS(30));
                gpio_set_level(PIN_BUZZER, 0);
                if (key == '#') {
                    keypad_buffer[keypad_pos] = '\0';
                    if (strcmp(keypad_buffer, lock_password) == 0) {
                        failed_attempts = 0;
                        if (lock_state == LOCK_STATE_LOCKED) {
                            apply_lock_state(LOCK_STATE_UNLOCKED, "Keypad unlock", true);
                        } else {
                            apply_lock_state(LOCK_STATE_LOCKED, "Keypad lock", true);
                        }
                    } else {
                        failed_attempts++;
                        save_nvs_state();
                        if (failed_attempts >= WRONG_ATTEMPTS_MAX) {
                            keypad_lockout_until_ms = now + KEYPAD_LOCKOUT_MS;
                            alarm_active = true;
                            alarm_silenced = false;
                            alarm_start_ms = now;
                            publish_alert("ALARM", "Too many wrong PIN attempts");
                            publish_state();
                        } else {
                            for (int i = 0; i < 3; i++) {
                                gpio_set_level(PIN_BUZZER, 1);
                                vTaskDelay(pdMS_TO_TICKS(100));
                                gpio_set_level(PIN_BUZZER, 0);
                                vTaskDelay(pdMS_TO_TICKS(100));
                            }
                        }
                    }
                    keypad_pos = 0;
                } else if (key == '*') {
                    keypad_pos = 0;
                } else if (keypad_pos < KEYPAD_MAX_LEN) {
                    keypad_buffer[keypad_pos++] = key;
                }
            }
        }

        if (alarm_silenced && !pir_active && !reed_active && !fire_active) {
            alarm_silenced = false;
            publish_state();
        }

        vTaskDelay(pdMS_TO_TICKS(SENSOR_SCAN_MS));
    }
}

static void control_task(void *pvParameters)
{

    while (1) {
        static int64_t last_schedule_ms = 0;
        command_t msg;
        if (xQueueReceive(command_queue, &msg, pdMS_TO_TICKS(100)) == pdTRUE) {
            handle_command(msg.command);
        }

        int64_t now = now_ms();
        if (now - last_schedule_ms >= 30000) {
            last_schedule_ms = now;
            update_schedule_mode();
        }

        if (lock_state == LOCK_STATE_UNLOCKED && unlock_start_ms > 0) {
            if (now_ms() - unlock_start_ms >= AUTO_LOCK_MS) {
                apply_lock_state(LOCK_STATE_LOCKED, "Auto-lock", true);
            }
        }

        if (alarm_active) {
            if (now_ms() - alarm_start_ms >= ALARM_DURATION_MS) {
                alarm_active = false;
                gpio_set_level(PIN_BUZZER, 0);
                publish_state();
            } else {
                static bool buzzer_state = false;
                buzzer_state = !buzzer_state;
                gpio_set_level(PIN_BUZZER, buzzer_state);
            }
        } else {
            gpio_set_level(PIN_BUZZER, 0);
        }

        vTaskDelay(pdMS_TO_TICKS(200));
    }
}

static void health_task(void *pvParameters)
{

    while (1) {
        size_t free_heap = esp_get_free_heap_size();
        if (free_heap < HEAP_MIN_THRESHOLD_BYTES) {
            publish_alert("HEALTH", "Low heap memory");
        }

        publish_metric();
        publish_state();

        vTaskDelay(pdMS_TO_TICKS(HEALTH_CHECK_MS));
    }
}

static void update_schedule_mode(void)
{
#if SCHEDULE_ENABLED
    time_t now;
    time(&now);
    struct tm timeinfo;
    localtime_r(&now, &timeinfo);

    int now_min = timeinfo.tm_hour * 60 + timeinfo.tm_min;
    int night_start = NIGHT_START_HH * 60 + NIGHT_START_MM;
    int night_end = NIGHT_END_HH * 60 + NIGHT_END_MM;

    bool in_night = false;
    if (night_start < night_end) {
        in_night = (now_min >= night_start && now_min < night_end);
    } else {
        in_night = (now_min >= night_start || now_min < night_end);
    }

    security_mode_t desired = in_night ? MODE_NIGHT : MODE_HOME;
    if (current_mode != desired) {
        current_mode = desired;
        publish_state();
    }
#endif
}

static void perform_ota_update(void)
{
    if (strlen(OTA_URL) == 0) {
        publish_alert("OTA", "OTA URL not configured");
        return;
    }

    esp_http_client_config_t config = {
        .url = OTA_URL,
        .timeout_ms = 30000,
    };
    esp_https_ota_config_t ota_config = {
        .http_config = &config,
    };

    esp_err_t ret = esp_https_ota(&ota_config);
    if (ret == ESP_OK) {
        publish_alert("OTA", "OTA update applied, rebooting");
        esp_restart();
    } else {
        publish_alert("OTA", "OTA update failed");
    }
}

static void trigger_cam_capture(void)
{
    if (strlen(CAM_CAPTURE_URL) == 0) {
        return;
    }

    esp_http_client_config_t config = {
        .url = CAM_CAPTURE_URL,
        .method = HTTP_METHOD_GET,
        .timeout_ms = CAM_CAPTURE_TIMEOUT_MS,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        ESP_LOGW(TAG, "CAM capture init failed");
        return;
    }

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
    } else {
        ESP_LOGW(TAG, "CAM capture failed: %s", esp_err_to_name(err));
    }
    esp_http_client_cleanup(client);
}

static void apply_lock_state(lock_state_t new_state, const char *reason, bool notify)
{
    if (lock_state == new_state) {
        return;
    }

    lock_state = new_state;
    if (lock_state == LOCK_STATE_UNLOCKED) {
        ESP_ERROR_CHECK(servo_control_set_unlocked());
        gpio_set_level(PIN_LED_RED, 0);
        gpio_set_level(PIN_LED_GREEN, 1);
        unlock_start_ms = now_ms();
    } else {
        ESP_ERROR_CHECK(servo_control_set_locked());
        gpio_set_level(PIN_LED_RED, 1);
        gpio_set_level(PIN_LED_GREEN, 0);
        unlock_start_ms = 0;
    }

    save_nvs_state();
    publish_state();

    if (notify && reason && reason[0] != '\0') {
        publish_alert("LOCK", reason);
    }
}

void app_main(void)
{

    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    load_nvs_state();

    gpio_init_all();
    ESP_ERROR_CHECK(servo_control_init());
    keypad_init();

    command_queue = xQueueCreate(10, sizeof(command_t));

    wifi_init_sta();

    EventBits_t bits = xEventGroupWaitBits(wifi_event_group,
                                           WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                                           pdFALSE, pdFALSE, portMAX_DELAY);

    if (bits & WIFI_CONNECTED_BIT) {
        uint8_t mac[6];
        if (esp_wifi_get_mac(WIFI_IF_STA, mac) == ESP_OK) {
            snprintf(g_device_id, sizeof(g_device_id), "smartlock-%02x%02x%02x%02x%02x%02x",
                     mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
        } else {
            snprintf(g_device_id, sizeof(g_device_id), "smartlock-default");
        }

        initialize_sntp();
        mqtt_app_start();

        xTaskCreate(sensor_task, "sensor_task", 4096, NULL, 5, &sensor_task_handle);
        xTaskCreate(control_task, "control_task", 4096, NULL, 5, &control_task_handle);
        xTaskCreate(health_task, "health_task", 4096, NULL, 3, &health_task_handle);

    } else {
        ESP_LOGE(TAG, "WiFi connection failed - system halted");
    }
}
