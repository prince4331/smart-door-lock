#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ===== User config =====
#define WIFI_SSID "UIU-STUDENT"
#define WIFI_PASS "12345678"
#define SERVER_URL "http://10.15.26.14:8080/api/cam/upload"
#define CAM_TOKEN ""
#define CAPTURE_INTERVAL_MS 5000

// ===== AI Thinker pin map =====
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27

#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

static unsigned long lastCapture = 0;
static unsigned long lastIpLog = 0;
static WebServer server(80);

static void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    Serial.print('.');
    delay(200);
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected, IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("RSSI: ");
    Serial.println(WiFi.RSSI());
  } else {
    Serial.println("WiFi connection failed");
  }
}

static bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 10;
    config.fb_count = 2;
  } else {
    config.frame_size = FRAMESIZE_QVGA;
    config.jpeg_quality = 12;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }
  Serial.println("Camera init OK");
  return true;
}

static void uploadFrame() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("Upload skipped: WiFi not connected");
      return;
    }
  }

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Upload skipped: no frame buffer");
    return;
  }

  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "image/jpeg");
  if (strlen(CAM_TOKEN) > 0) {
    http.addHeader("X-Cam-Token", CAM_TOKEN);
  }

  int code = http.POST(fb->buf, fb->len);
  Serial.print("Upload status: ");
  Serial.println(code);
  http.end();

  esp_camera_fb_return(fb);
}

static void handleCapture() {
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    server.send(500, "text/plain", "capture failed");
    return;
  }

  server.setContentLength(fb->len);
  server.send(200, "image/jpeg", "");
  WiFiClient client = server.client();
  client.write(fb->buf, fb->len);
  esp_camera_fb_return(fb);
}

static void handleStream() {
  WiFiClient client = server.client();
  const char *boundary = "frame";

  String header = "HTTP/1.1 200 OK\r\n";
  header += "Content-Type: multipart/x-mixed-replace; boundary=" + String(boundary) + "\r\n";
  header += "Cache-Control: no-cache\r\n";
  header += "Connection: close\r\n\r\n";
  client.print(header);

  while (client.connected()) {
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      delay(100);
      continue;
    }

    client.printf("--%s\r\n", boundary);
    client.print("Content-Type: image/jpeg\r\n");
    client.printf("Content-Length: %u\r\n\r\n", fb->len);
    client.write(fb->buf, fb->len);
    client.print("\r\n");
    esp_camera_fb_return(fb);
    delay(100);
  }
}

void setup() {
  // Disable brownout detector (common for ESP32-CAM power dips)
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("ESP32-CAM boot");
  connectWifi();
  if (!initCamera()) {
    Serial.println("Restarting in 5s...");
    delay(5000);
    ESP.restart();
  }
  lastCapture = millis();
  lastIpLog = millis();

  server.on("/capture", HTTP_GET, handleCapture);
  server.on("/stream", HTTP_GET, handleStream);
  server.begin();
}

void loop() {
  server.handleClient();

  if (WiFi.status() == WL_CONNECTED && millis() - lastIpLog >= 10000) {
    lastIpLog = millis();
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
  } else if (WiFi.status() != WL_CONNECTED && millis() - lastIpLog >= 5000) {
    lastIpLog = millis();
    Serial.print("WiFi status: ");
    Serial.println(WiFi.status());
  }

  if (CAPTURE_INTERVAL_MS > 0 && millis() - lastCapture >= CAPTURE_INTERVAL_MS) {
    lastCapture = millis();
    uploadFrame();
  }
  delay(50);
}
