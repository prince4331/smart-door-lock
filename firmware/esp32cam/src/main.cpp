#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>

#include "esp_camera.h"
#include "img_converters.h"


// Placeholder values only. Set real credentials in an untracked local copy.
const char *ssid = "YOUR_WIFI_SSID";
const char *password = "YOUR_WIFI_PASSWORD";


const char *mqtt_host = "YOUR_MQTT_HOST.example.com";
const uint16_t mqtt_port = 8883;
const char *mqtt_user = "YOUR_MQTT_USERNAME";
const char *mqtt_pass = "YOUR_MQTT_PASSWORD";

const char *topic_meta = "smartlock/cam/meta";
const char *topic_chunk = "smartlock/cam/chunk";


const char *tg_bot_token = "YOUR_TELEGRAM_BOT_TOKEN";
const char *tg_chat_id = "YOUR_TELEGRAM_CHAT_ID";


#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27

#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

#define FLASH_LED_GPIO 4


static WiFiClientSecure net;
static PubSubClient mqtt(net);
static uint32_t cam_seq = 0;

static const uint8_t CAM_TRIGGER_BYTE = '1';
static const size_t CHUNK_SIZE = 2048;
static const uint32_t CAM_TRIGGER_COOLDOWN_MS = 30000;
static uint32_t last_trigger_ms = 0;
static uint32_t trigger_window_start_ms = 0;
static uint8_t trigger_count = 0;
static const uint32_t TRIGGER_WINDOW_MS = 200;

static void flashInit() {
  pinMode(FLASH_LED_GPIO, OUTPUT);
  digitalWrite(FLASH_LED_GPIO, LOW);
}

static void flashOn() {
  digitalWrite(FLASH_LED_GPIO, HIGH);
}

static void flashOff() {
  digitalWrite(FLASH_LED_GPIO, LOW);
}

static void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(300);
  }
}

static void connectMqtt() {
  mqtt.setServer(mqtt_host, mqtt_port);
  net.setInsecure();

  uint32_t start = millis();
  while (!mqtt.connected() && (millis() - start) < 8000) {
    String clientId = "esp32cam-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    if (mqtt.connect(clientId.c_str(), mqtt_user, mqtt_pass)) {
      break;
    }
    delay(1000);
  }
}

static bool initCamera() {
  camera_config_t c;
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;

  c.pin_d0 = Y2_GPIO_NUM;
  c.pin_d1 = Y3_GPIO_NUM;
  c.pin_d2 = Y4_GPIO_NUM;
  c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM;
  c.pin_d5 = Y7_GPIO_NUM;
  c.pin_d6 = Y8_GPIO_NUM;
  c.pin_d7 = Y9_GPIO_NUM;

  c.pin_xclk = XCLK_GPIO_NUM;
  c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM;
  c.pin_href = HREF_GPIO_NUM;

  c.pin_sccb_sda = SIOD_GPIO_NUM;
  c.pin_sccb_scl = SIOC_GPIO_NUM;

  c.pin_pwdn = PWDN_GPIO_NUM;
  c.pin_reset = RESET_GPIO_NUM;

  c.xclk_freq_hz = 10000000;
  c.pixel_format = PIXFORMAT_RGB565;
  c.frame_size = FRAMESIZE_QVGA;
  c.fb_count = psramFound() ? 2 : 1;
  c.jpeg_quality = 12;

  esp_err_t err = esp_camera_init(&c);
  if (err != ESP_OK) {
    return false;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_gain_ctrl(s, 1);
    s->set_exposure_ctrl(s, 1);
    s->set_awb_gain(s, 1);
    s->set_whitebal(s, 1);
    s->set_brightness(s, 1);
    s->set_contrast(s, 0);
    s->set_saturation(s, 0);
  }

  return true;
}

static void publishImage(const uint8_t *jpg, size_t len) {
  if (!mqtt.connected()) {
    connectMqtt();
  }
  if (!mqtt.connected()) {
    return;
  }

  uint32_t seq = cam_seq++;
  uint16_t total = (uint16_t)((len + CHUNK_SIZE - 1) / CHUNK_SIZE);

  char meta[128];
  snprintf(meta, sizeof(meta), "{\"seq\":%lu,\"len\":%lu,\"chunk\":%u}",
           (unsigned long)seq, (unsigned long)len, (unsigned)CHUNK_SIZE);
  mqtt.publish(topic_meta, meta);

  uint8_t packet[8 + CHUNK_SIZE];
  for (uint16_t idx = 0; idx < total; idx++) {
    size_t offset = (size_t)idx * CHUNK_SIZE;
    size_t remaining = len - offset;
    size_t chunk_len = remaining > CHUNK_SIZE ? CHUNK_SIZE : remaining;

    packet[0] = (uint8_t)((seq >> 24) & 0xFF);
    packet[1] = (uint8_t)((seq >> 16) & 0xFF);
    packet[2] = (uint8_t)((seq >> 8) & 0xFF);
    packet[3] = (uint8_t)(seq & 0xFF);
    packet[4] = (uint8_t)((idx >> 8) & 0xFF);
    packet[5] = (uint8_t)(idx & 0xFF);
    packet[6] = (uint8_t)((total >> 8) & 0xFF);
    packet[7] = (uint8_t)(total & 0xFF);
    memcpy(packet + 8, jpg + offset, chunk_len);

    mqtt.publish(topic_chunk, packet, (unsigned int)(8 + chunk_len), false);
    mqtt.loop();
    delay(10);
  }
}

static void sendTelegramPhoto(const uint8_t *jpg, size_t len) {
  if (!tg_bot_token || !tg_bot_token[0] || !tg_chat_id || !tg_chat_id[0]) {
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();

  const char *host = "api.telegram.org";
  if (!client.connect(host, 443)) {
    return;
  }

  String url = String("/bot") + tg_bot_token + "/sendPhoto";
  const char *boundary = "----esp32cam-boundary";

  String part1 = String("--") + boundary + "\r\n" +
                 "Content-Disposition: form-data; name=\"chat_id\"\r\n\r\n" +
                 tg_chat_id + "\r\n";

  String part2 = String("--") + boundary + "\r\n" +
                 "Content-Disposition: form-data; name=\"photo\"; filename=\"cam.jpg\"\r\n" +
                 "Content-Type: image/jpeg\r\n\r\n";

  String part3 = String("\r\n--") + boundary + "--\r\n";

  size_t content_length = part1.length() + part2.length() + len + part3.length();

  client.print(String("POST ") + url + " HTTP/1.1\r\n");
  client.print(String("Host: ") + host + "\r\n");
  client.print("Connection: close\r\n");
  client.print(String("Content-Type: multipart/form-data; boundary=") + boundary + "\r\n");
  client.print(String("Content-Length: ") + content_length + "\r\n\r\n");

  client.print(part1);
  client.print(part2);
  client.write(jpg, len);
  client.print(part3);

  while (client.connected()) {
    while (client.available()) {
      client.read();
    }
    delay(5);
  }
  client.stop();
}

static void captureAndPublish() {
  flashOn();
  delay(120);

  for (int i = 0; i < 2; i++) {
    camera_fb_t *tmp = esp_camera_fb_get();
    if (tmp) {
      esp_camera_fb_return(tmp);
    }
    delay(30);
  }

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    flashOff();
    return;
  }

  uint8_t *jpg = nullptr;
  size_t jpg_len = 0;
  const int quality = 30;

  bool ok = fmt2jpg(fb->buf, fb->len, fb->width, fb->height, fb->format,
                    quality, &jpg, &jpg_len);
  esp_camera_fb_return(fb);
  flashOff();

  if (!ok || !jpg || jpg_len == 0) {
    if (jpg) free(jpg);
    return;
  }

  publishImage(jpg, jpg_len);
  sendTelegramPhoto(jpg, jpg_len);
  free(jpg);
}

void setup() {
  Serial.begin(115200);
  delay(1500);

  flashInit();

  if (!initCamera()) {
    while (true) delay(1000);
  }

  connectWiFi();
  connectMqtt();
}

void loop() {
  static uint32_t lastMqttAttempt = 0;
  if (!mqtt.connected() && millis() - lastMqttAttempt > 5000) {
    lastMqttAttempt = millis();
    connectMqtt();
  }
  mqtt.loop();

  if (Serial.available()) {
    int c = Serial.read();
    uint32_t now = millis();
    if (c == CAM_TRIGGER_BYTE && (now - last_trigger_ms) >= CAM_TRIGGER_COOLDOWN_MS) {
      last_trigger_ms = now;
      trigger_window_start_ms = 0;
      trigger_count = 0;
      captureAndPublish();
    }
  }
}
