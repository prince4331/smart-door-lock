# ESP32-CAM Wi-Fi Uploader

This firmware captures JPEG frames and uploads them over Wi-Fi to the server API.

## Configure
Edit `firmware/esp32cam/src/main.cpp`:
- `WIFI_SSID` / `WIFI_PASS`
- `SERVER_URL` (example: `http://192.168.0.10:8080/api/cam/upload`)
- `CAM_TOKEN` (optional; must match `CAM_TOKEN` in `server/.env`)
- `CAPTURE_INTERVAL_MS`

## Build and Flash
```bash
cd firmware/esp32cam
python -m platformio run --target upload --upload-port COMx
python -m platformio device monitor --port COMx -b 115200
```

## Server
Ensure the server is running:
```bash
cd server
node src/index.js
```

Endpoints on ESP32-CAM:
- `/stream` for MJPEG live feed
- `/capture` for single JPEG snapshot

The latest image is saved to `server/public/cam/latest.jpg` and shown on the dashboard.
