#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <time.h>
#include <ctype.h>

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
#include "esp_http_server.h"

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

#define NONCE_CACHE_SIZE 64
static int64_t nonce_cache[NONCE_CACHE_SIZE];
static int nonce_cache_index = 0;

static nvs_handle_t nvs_storage_handle;
static uint32_t boot_count = 0;

static TaskHandle_t sensor_task_handle = NULL;
static TaskHandle_t control_task_handle = NULL;
static TaskHandle_t health_task_handle = NULL;

typedef struct {
    char command[64];
} command_t;
static QueueHandle_t command_queue = NULL;

static int wifi_retry_count = 0;
static int wifi_backoff_ms = WIFI_BACKOFF_MIN_MS;

static bool provisioning_active = false;
static httpd_handle_t prov_httpd = NULL;
static EventGroupHandle_t prov_event_group;
#define PROV_CRED_RECV_BIT BIT0
#define PROV_TIMEOUT_BIT BIT1

static esp_event_handler_instance_t instance_any_id = NULL;
static esp_event_handler_instance_t instance_got_ip = NULL;

static void wifi_init_sta(const char *ssid, const char *pass);
static void initialize_sntp(void);
static void mqtt_app_start(void);
static void mqtt_app_stop(void);
static void gpio_init_all(void);
static void configure_input(gpio_num_t pin, bool pullup, bool pulldown);
static void load_nvs_state(void);
static void save_nvs_state(void);
static bool load_wifi_credentials(char *ssid, size_t ssid_len, char *pass, size_t pass_len);
static bool save_wifi_credentials(const char *ssid, const char *pass);
static bool load_setup_code(char *code, size_t max_len);
static bool save_setup_code(const char *code);
static bool generate_setup_code(char *buf, size_t len);
static void start_provisioning(void);
static void stop_provisioning(void);
static void provisioning_task(void *pvParameters);
static esp_err_t prov_get_handler(httpd_req_t *req);
static esp_err_t prov_post_handler(httpd_req_t *req);
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

static int64_t now_ms(void) {
    return esp_timer_get_time() / 1000;
}

static bool is_nonce_seen(int64_t nonce) {
    for (int i = 0; i < NONCE_CACHE_SIZE; i++) {
        if (nonce_cache[i] == nonce) {
            return true;
        }
    }
    return false;
}

static void record_nonce(int64_t nonce) {
    nonce_cache[nonce_cache_index] = nonce;
    nonce_cache_index = (nonce_cache_index + 1) % NONCE_CACHE_SIZE;
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
            if (wifi_event_group) {
                xEventGroupSetBits(wifi_event_group, WIFI_FAIL_BIT);
            }
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        wifi_retry_count = 0;
        wifi_backoff_ms = WIFI_BACKOFF_MIN_MS;
        if (wifi_event_group) {
            xEventGroupSetBits(wifi_event_group, WIFI_CONNECTED_BIT);
        }
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

static void wifi_init_sta(const char *ssid, const char *pass)
{
    wifi_event_group = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                        &wifi_event_handler, NULL, &instance_any_id));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                        &wifi_event_handler, NULL, &instance_got_ip));

    wifi_config_t wifi_config = {
        .sta = {
            .ssid = {0},
            .password = {0},
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
        },
    };

    if (ssid && ssid[0]) {
        strncpy((char *)wifi_config.sta.ssid, ssid, sizeof(wifi_config.sta.ssid) - 1);
    }
    if (pass && pass[0]) {
        strncpy((char *)wifi_config.sta.password, pass, sizeof(wifi_config.sta.password) - 1);
    }

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

static void mqtt_app_stop(void)
{
    if (mqtt_client) {
        esp_mqtt_client_stop(mqtt_client);
        esp_mqtt_client_destroy(mqtt_client);
        mqtt_client = NULL;
        mqtt_connected = false;
    }
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

    nvs_commit(nvs_storage_handle);
}

static void save_nvs_state(void)
{
    nvs_set_u8(nvs_storage_handle, NVS_KEY_LOCK_STATE, (uint8_t)lock_state);
    nvs_commit(nvs_storage_handle);
}

static bool load_wifi_credentials(char *ssid, size_t ssid_len, char *pass, size_t pass_len)
{
    if (!nvs_storage_handle) {
        return false;
    }

    size_t needed = ssid_len;
    if (nvs_get_str(nvs_storage_handle, NVS_KEY_STA_SSID, ssid, &needed) != ESP_OK) {
        return false;
    }

    needed = pass_len;
    if (nvs_get_str(nvs_storage_handle, NVS_KEY_STA_PASS, pass, &needed) != ESP_OK) {
        return false;
    }

    return ssid[0] != '\0';
}

static bool save_wifi_credentials(const char *ssid, const char *pass)
{
    if (!nvs_storage_handle) {
        return false;
    }

    esp_err_t err = nvs_set_str(nvs_storage_handle, NVS_KEY_STA_SSID, ssid);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to save SSID: %s", esp_err_to_name(err));
        return false;
    }

    err = nvs_set_str(nvs_storage_handle, NVS_KEY_STA_PASS, pass);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to save password: %s", esp_err_to_name(err));
        return false;
    }

    err = nvs_commit(nvs_storage_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to commit NVS: %s", esp_err_to_name(err));
        return false;
    }

    ESP_LOGI(TAG, "WiFi credentials saved to NVS");
    return true;
}

static bool load_setup_code(char *code, size_t max_len)
{
    if (!nvs_storage_handle) {
        return false;
    }

    size_t needed = max_len;
    if (nvs_get_str(nvs_storage_handle, NVS_KEY_SETUP_CODE, code, &needed) != ESP_OK) {
        return false;
    }

    return code[0] != '\0';
}

static bool save_setup_code(const char *code)
{
    if (!nvs_storage_handle) {
        return false;
    }

    esp_err_t err = nvs_set_str(nvs_storage_handle, NVS_KEY_SETUP_CODE, code);
    if (err != ESP_OK) {
        return false;
    }

    return nvs_commit(nvs_storage_handle) == ESP_OK;
}

static bool generate_setup_code(char *buf, size_t len)
{
    const char charset[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (size_t i = 0; i < len - 1; i++) {
        buf[i] = charset[esp_random() % (sizeof(charset) - 1)];
    }
    buf[len - 1] = '\0';
    return true;
}

static void prov_test_event_handler(void* arg, esp_event_base_t event_base,
                                    int32_t event_id, void* event_data)
{
    (void)event_data;
    EventGroupHandle_t test_group = (EventGroupHandle_t)arg;
    if (!test_group) return;

    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(test_group, WIFI_CONNECTED_BIT);
    }
}

static esp_err_t test_sta_connection(const char *ssid, const char *pass)
{
    ESP_LOGI(TAG, "Testing STA connection to %s", ssid);

    wifi_config_t wifi_config = {
        .sta = {
            .ssid = {0},
            .password = {0},
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
        },
    };

    strncpy((char *)wifi_config.sta.ssid, ssid, sizeof(wifi_config.sta.ssid) - 1);
    if (pass && pass[0]) {
        strncpy((char *)wifi_config.sta.password, pass, sizeof(wifi_config.sta.password) - 1);
    }

    EventGroupHandle_t test_group = xEventGroupCreate();
    if (!test_group) {
        return ESP_FAIL;
    }

    esp_event_handler_instance_t test_instance_any = NULL;
    esp_event_handler_instance_t test_instance_got_ip = NULL;

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                        &prov_test_event_handler, test_group, &test_instance_any));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                        &prov_test_event_handler, test_group, &test_instance_got_ip));

    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    esp_wifi_connect();

    EventBits_t bits = xEventGroupWaitBits(test_group,
                                           WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                                           pdTRUE, pdFALSE, pdMS_TO_TICKS(20000));

    if (test_instance_any) {
        esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, test_instance_any);
    }
    if (test_instance_got_ip) {
        esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, test_instance_got_ip);
    }
    vEventGroupDelete(test_group);

    esp_wifi_disconnect();

    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG, "Test connection successful");
        return ESP_OK;
    } else {
        ESP_LOGE(TAG, "Test connection failed");
        return ESP_FAIL;
    }
}

static const char *prov_html_page = \
"<!DOCTYPE html>" \
"<html lang=\"en\">" \
"<head>" \
"  <meta charset=\"UTF-8\">" \
"  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" \
"  <title>Smart Lock Setup</title>" \
"  <style>" \
"    body { font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif; max-width: 420px; margin: 40px auto; padding: 0 20px; color: #333; }" \
"    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }" \
"    p { color: #666; margin-top: 0; }" \
"    label { display: block; margin-top: 16px; font-weight: 500; }" \
"    input { width: 100%%; padding: 10px; margin-top: 6px; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; box-sizing: border-box; }" \
"    button { margin-top: 20px; width: 100%%; padding: 12px; background: #2563eb; color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }" \
"    button:disabled { background: #94a3b8; cursor: not-allowed; }" \
"    .status { margin-top: 16px; padding: 10px; border-radius: 6px; font-size: 0.9rem; }" \
"    .error { background: #fee2e2; color: #991b1b; }" \
"    .success { background: #dcfce7; color: #166534; }" \
"    .info { background: #e0f2fe; color: #075985; }" \
"  </style>" \
"</head>" \
"<body>" \
"  <h1>Smart Lock Setup</h1>" \
"  <p>Enter your Wi-Fi network details and the setup code printed on the device label.</p>" \
"  <form id=\"setupForm\">" \
"    <label for=\"setupCode\">Setup Code</label>" \
"    <input type=\"text\" id=\"setupCode\" name=\"setup_code\" required autocomplete=\"off\">" \
"    <label for=\"ssid\">Network Name (SSID)</label>" \
"    <input type=\"text\" id=\"ssid\" name=\"ssid\" required autocomplete=\"off\">" \
"    <label for=\"password\">Network Password</label>" \
"    <input type=\"password\" id=\"password\" name=\"password\" required>" \
"    <button type=\"submit\" id=\"submitBtn\">Connect and Save</button>" \
"  </form>" \
"  <div id=\"status\" class=\"status info\" style=\"display:none;\"></div>" \
"  <script>" \
"    const form = document.getElementById('setupForm');" \
"    const status = document.getElementById('status');" \
"    const submitBtn = document.getElementById('submitBtn');" \
"    function showStatus(msg, type) {" \
"      status.textContent = msg;" \
"      status.className = 'status ' + type;" \
"      status.style.display = 'block';" \
"    }" \
"    form.addEventListener('submit', async (e) => {" \
"      e.preventDefault();" \
"      submitBtn.disabled = true;" \
"      showStatus('Testing connection...', 'info');" \
"      try {" \
"        const res = await fetch('/setup', {" \
"          method: 'POST'," \
"          headers: { 'Content-Type': 'application/json' }," \
"          body: JSON.stringify({" \
"            setup_code: document.getElementById('setupCode').value," \
"            ssid: document.getElementById('ssid').value," \
"            password: document.getElementById('password').value" \
"          })" \
"        });" \
"        const data = await res.json();" \
"        if (res.ok) {" \
"          showStatus('Success! The device is connecting to your network and will restart.', 'success');" \
"          submitBtn.disabled = true;" \
"        } else {" \
"          showStatus(data.error || 'Setup failed', 'error');" \
"          submitBtn.disabled = false;" \
"        }" \
"      } catch (err) {" \
"        showStatus('Network error: ' + err.message, 'error');" \
"        submitBtn.disabled = false;" \
"      }" \
"    });" \
"  </script>" \
"</body>" \
"</html>";

static esp_err_t prov_get_handler(httpd_req_t *req)
{
    httpd_resp_set_status(req, "200 OK");
    httpd_resp_set_type(req, "text/html");
    httpd_resp_send(req, prov_html_page, strlen(prov_html_page));
    return ESP_OK;
}

static esp_err_t prov_post_handler(httpd_req_t *req)
{
    char buf[512];
    int ret, remaining = req->content_len;

    if (remaining >= (int)sizeof(buf)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "payload too large");
        return ESP_FAIL;
    }

    ret = httpd_req_recv(req, buf, remaining);
    if (ret <= 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "failed to receive body");
        return ESP_FAIL;
    }
    buf[ret] = '\0';

    char setup_code[64] = {0};
    char ssid[64] = {0};
    char password[128] = {0};

    char *p = strstr(buf, "\"setup_code\":\"");
    if (p) {
        p += strlen("\"setup_code\":\"");
        char *end = strchr(p, '\"');
        if (end) {
            size_t len = end - p;
            if (len >= sizeof(setup_code)) len = sizeof(setup_code) - 1;
            strncpy(setup_code, p, len);
            setup_code[len] = '\0';
        }
    }

    p = strstr(buf, "\"ssid\":\"");
    if (p) {
        p += strlen("\"ssid\":\"");
        char *end = strchr(p, '\"');
        if (end) {
            size_t len = end - p;
            if (len >= sizeof(ssid)) len = sizeof(ssid) - 1;
            strncpy(ssid, p, len);
            ssid[len] = '\0';
        }
    }

    p = strstr(buf, "\"password\":\"");
    if (p) {
        p += strlen("\"password\":\"");
        char *end = strchr(p, '\"');
        if (end) {
            size_t len = end - p;
            if (len >= sizeof(password)) len = sizeof(password) - 1;
            strncpy(password, p, len);
            password[len] = '\0';
        }
    }

    if (setup_code[0] == '\0' || ssid[0] == '\0') {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "missing setup_code or ssid");
        return ESP_FAIL;
    }

    char stored_code[64] = {0};
    if (!load_setup_code(stored_code, sizeof(stored_code)) || strcmp(stored_code, setup_code) != 0) {
        ESP_LOGW(TAG, "Invalid setup code attempt");
        httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "invalid setup code");
        return ESP_FAIL;
    }

    esp_err_t test_result = test_sta_connection(ssid, password);

    if (test_result == ESP_OK) {
        save_wifi_credentials(ssid, password);
        ESP_LOGI(TAG, "Credentials saved, restarting");
        xEventGroupSetBits(prov_event_group, PROV_CRED_RECV_BIT);

        httpd_resp_set_status(req, "200 OK");
        httpd_resp_set_type(req, "application/json");
        httpd_resp_send(req, "{\"status\":\"success\"}", strlen("{\"status\":\"success\"}"));
    } else {
        ESP_LOGW(TAG, "Test connection failed for provided SSID");

        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_set_type(req, "application/json");
        httpd_resp_send(req, "{\"error\":\"Unable to connect using those Wi-Fi credentials\"}",
                         strlen("{\"error\":\"Unable to connect using those Wi-Fi credentials\"}"));
    }

    return ESP_OK;
}

static void start_provisioning(void)
{
    if (provisioning_active) {
        return;
    }

    provisioning_active = true;
    prov_event_group = xEventGroupCreate();

    ESP_LOGI(TAG, "Starting provisioning mode");

    if (instance_any_id) {
        esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, instance_any_id);
        instance_any_id = NULL;
    }
    if (instance_got_ip) {
        esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, instance_got_ip);
        instance_got_ip = NULL;
    }

    uint8_t mac[6];
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    char ap_ssid[64];
    snprintf(ap_ssid, sizeof(ap_ssid), "%s%02X%02X", WIFI_PROV_SSID_PREFIX, mac[4], mac[5]);

    char setup_code[32] = {0};
    if (!load_setup_code(setup_code, sizeof(setup_code)) || strlen(setup_code) < WIFI_PROV_AP_PASS_MIN) {
        if (!generate_setup_code(setup_code, sizeof(setup_code)) || !save_setup_code(setup_code)) {
            ESP_LOGE(TAG, "Failed to generate/save setup code, cannot start provisioning AP");
            provisioning_active = false;
            if (prov_event_group) {
                vEventGroupDelete(prov_event_group);
                prov_event_group = NULL;
            }
            return;
        }
        ESP_LOGI(TAG, "Generated new setup code for provisioning AP");
    } else {
        ESP_LOGI(TAG, "Using existing setup code");
    }

    wifi_config_t ap_config = {
        .ap = {
            .ssid = {0},
            .password = {0},
            .ssid_len = 0,
            .channel = 1,
            .authmode = WIFI_AUTH_WPA2_PSK,
            .max_connection = 4,
        },
    };

    strncpy((char *)ap_config.ap.ssid, ap_ssid, sizeof(ap_config.ap.ssid) - 1);
    ap_config.ap.ssid_len = strlen(ap_ssid);

    if (strlen(setup_code) >= WIFI_PROV_AP_PASS_MIN) {
        strncpy((char *)ap_config.ap.password, setup_code, sizeof(ap_config.ap.password) - 1);
    } else {
        ESP_LOGE(TAG, "Setup code too short, cannot start open AP");
        provisioning_active = false;
        if (prov_event_group) {
            vEventGroupDelete(prov_event_group);
            prov_event_group = NULL;
        }
        return;
    }

    esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    esp_err_t init_ret = esp_wifi_init(&cfg);
    if (init_ret != ESP_OK && init_ret != ESP_ERR_WIFI_MODE) {
        ESP_LOGE(TAG, "Failed to init WiFi for provisioning: %s", esp_err_to_name(init_ret));
        provisioning_active = false;
        if (prov_event_group) {
            vEventGroupDelete(prov_event_group);
            prov_event_group = NULL;
        }
        return;
    }

    esp_err_t ret = esp_wifi_set_mode(WIFI_MODE_APSTA);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to set APSTA mode: %s", esp_err_to_name(ret));
    }

    ret = esp_wifi_set_config(WIFI_IF_AP, &ap_config);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to set AP config: %s", esp_err_to_name(ret));
    }

    ret = esp_wifi_start();
    if (ret != ESP_OK && ret != ESP_ERR_WIFI_MODE) {
        ESP_LOGE(TAG, "Failed to start WiFi: %s", esp_err_to_name(ret));
    }

    ESP_LOGI(TAG, "Provisioning AP started: %s (authmode: %s)", ap_ssid,
             ap_config.ap.authmode == WIFI_AUTH_OPEN ? "OPEN" : "WPA2_PSK");

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.max_open_sockets = 4;

    httpd_uri_t get_uri = {
        .uri = "/",
        .method = HTTP_GET,
        .handler = prov_get_handler,
        .user_ctx = NULL
    };

    httpd_uri_t post_uri = {
        .uri = "/setup",
        .method = HTTP_POST,
        .handler = prov_post_handler,
        .user_ctx = NULL
    };

    if (httpd_start(&prov_httpd, &config) == ESP_OK) {
        httpd_register_uri_handler(prov_httpd, &get_uri);
        httpd_register_uri_handler(prov_httpd, &post_uri);
        ESP_LOGI(TAG, "Provisioning HTTP server started on port 80");
    } else {
        ESP_LOGE(TAG, "Failed to start provisioning HTTP server");
    }
}

static void stop_provisioning(void)
{
    if (!provisioning_active) {
        return;
    }

    provisioning_active = false;
    ESP_LOGI(TAG, "Stopping provisioning mode");

    if (prov_httpd) {
        httpd_stop(prov_httpd);
        prov_httpd = NULL;
    }

    if (prov_event_group) {
        vEventGroupDelete(prov_event_group);
        prov_event_group = NULL;
    }

    esp_wifi_stop();
    esp_wifi_deinit();
    if (instance_any_id) {
        esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, instance_any_id);
        instance_any_id = NULL;
    }
    if (instance_got_ip) {
        esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, instance_got_ip);
        instance_got_ip = NULL;
    }
    esp_event_loop_delete_default();
}

static void provisioning_task(void *pvParameters)
{
    (void)pvParameters;

    start_provisioning();

    EventBits_t bits = xEventGroupWaitBits(prov_event_group,
                                           PROV_CRED_RECV_BIT | PROV_TIMEOUT_BIT,
                                           pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(WIFI_PROV_TIMEOUT_MS));

    if (bits & PROV_CRED_RECV_BIT) {
        ESP_LOGI(TAG, "Provisioning successful, restarting");
    } else if (bits & PROV_TIMEOUT_BIT) {
        ESP_LOGW(TAG, "Provisioning timeout");
    } else {
        ESP_LOGW(TAG, "Provisioning exited without result");
    }

    stop_provisioning();
    ESP_LOGI(TAG, "Restarting after provisioning");
    esp_restart();
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
             "\"alarm\":%s,\"alarm_silenced\":%s,\"boot_count\":%lu,\"timestamp\":%lld}",
             g_device_id, lock_str[lock_state], mode_str[current_mode],
             pir_active ? "true" : "false",
             reed_active ? "true" : "false",
             fire_active ? "true" : "false",
             alarm_active ? "true" : "false",
             alarm_silenced ? "true" : "false",
             boot_count, (long long)now);

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
    char *nonce_str = strtok(NULL, "|");
    char *ts_str = strtok(NULL, "|");

    if (!command || !nonce_str || !ts_str) {
        return false;
    }

    if (strtok(NULL, "|")) {
        return false;
    }

    char *nonce_end;
    long long nonce_val = strtoll(nonce_str, &nonce_end, 10);
    if (*nonce_end != '\0') {
        return false;
    }

    char *ts_end;
    long ts = strtol(ts_str, &ts_end, 10);
    if (*ts_end != '\0') {
        return false;
    }

    time_t now;
    time(&now);
    long diff = labs((long)now - ts);
    if (diff > CMD_TIMESTAMP_WINDOW_SEC) {
        ESP_LOGW(TAG, "Command timestamp out of window: %ld sec", diff);
        return false;
    }

    if (is_nonce_seen(nonce_val)) {
        ESP_LOGW(TAG, "Command replay detected: nonce %lld already used", (long long)nonce_val);
        return false;
    }
    record_nonce(nonce_val);

    if (strcmp(command, "LOCK") != 0 &&
        strcmp(command, "UNLOCK") != 0 &&
        strcmp(command, "SILENCE") != 0 &&
        strcmp(command, "ARM") != 0 &&
        strcmp(command, "OTA") != 0 &&
        strcmp(command, "MODE_HOME") != 0 &&
        strcmp(command, "MODE_AWAY") != 0 &&
        strcmp(command, "MODE_NIGHT") != 0 &&
        strcmp(command, "START_PROVISIONING") != 0) {
        return false;
    }

    return true;
}

static void handle_command(const char *cmd)
{
    if (!validate_command(cmd)) {
        ESP_LOGW(TAG, "Invalid command rejected: %s", cmd);
        publish_command_ack(cmd, "rejected", "invalid command");
        return;
    }

    char cmd_copy[80];
    strncpy(cmd_copy, cmd, sizeof(cmd_copy) - 1);
    cmd_copy[sizeof(cmd_copy) - 1] = '\0';
    char *command = strtok(cmd_copy, "|");

    if (strcmp(command, "START_PROVISIONING") == 0) {
        ESP_LOGI(TAG, "Received START_PROVISIONING command");
        publish_command_ack(command, "ok", "entering provisioning");
        mqtt_app_stop();
        esp_wifi_stop();
        if (instance_any_id) {
            esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, instance_any_id);
            instance_any_id = NULL;
        }
        if (instance_got_ip) {
            esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, instance_got_ip);
            instance_got_ip = NULL;
        }
        xTaskCreate(provisioning_task, "prov_task", 8192, NULL, 4, NULL);
        return;
    }

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
    if (err != ESP_OK) {
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

    command_queue = xQueueCreate(10, sizeof(command_t));

    char sta_ssid[64] = {0};
    char sta_pass[128] = {0};
    bool has_creds = load_wifi_credentials(sta_ssid, sizeof(sta_ssid), sta_pass, sizeof(sta_pass));

    xTaskCreate(sensor_task, "sensor_task", 4096, NULL, 5, &sensor_task_handle);
    xTaskCreate(control_task, "control_task", 4096, NULL, 5, &control_task_handle);
    xTaskCreate(health_task, "health_task", 4096, NULL, 3, &health_task_handle);

    if (!has_creds) {
        ESP_LOGW(TAG, "No WiFi credentials found, entering provisioning mode");
        xTaskCreate(provisioning_task, "prov_task", 8192, NULL, 4, NULL);
        return;
    }

    wifi_init_sta(sta_ssid, sta_pass);

    EventBits_t bits = xEventGroupWaitBits(wifi_event_group,
                                           WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
                                           pdFALSE, pdFALSE, pdMS_TO_TICKS(WIFI_STA_SETTLE_MS));

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

    } else {
        ESP_LOGE(TAG, "WiFi connection failed after %d ms, entering provisioning mode", WIFI_STA_SETTLE_MS);
        esp_wifi_stop();
        xTaskCreate(provisioning_task, "prov_task", 8192, NULL, 4, NULL);
    }
}
