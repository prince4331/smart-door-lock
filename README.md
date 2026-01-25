# 🔐 IoT Smart Door Lock Security System

[![ESP32](https://img.shields.io/badge/ESP32-Compatible-blue.svg)](https://www.espressif.com/en/products/socs/esp32)
[![Arduino](https://img.shields.io/badge/Arduino-IDE-00979D.svg)](https://www.arduino.cc/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

An industry-grade IoT-based smart home security system with password-protected door control, real-time intrusion detection, fire detection, and remote monitoring capabilities.

---

## 🎯 Features

### 🔒 Security Features
- ✅ Password-protected door lock system
- ✅ PIR motion detection (intrusion alert)
- ✅ Magnetic door sensor (forced entry detection)
- ✅ Fire detection with immediate alarm
- ✅ Multiple wrong password attempt protection
- ✅ Visual status indication (LED indicators)
- ✅ Audible alarm system

### 🌐 IoT Features
- ✅ Real-time cloud connectivity
- ✅ Remote monitoring via dashboard
- ✅ Remote lock/unlock control
- ✅ Instant alert notifications
- ✅ Event logging and history
- ✅ Auto-reconnect WiFi capability

### 🎮 Operating Modes
1. **LOCKED MODE** - System armed, monitoring all sensors
2. **UNLOCKED MODE** - Door unlocked, sensors temporarily disabled
3. **ALARM MODE** - Active intrusion/fire alert state

---

## 🧩 Components Required

| Component | Quantity | Specification |
|-----------|----------|---------------|
| ESP32 Development Board | 1 | ESP32-WROOM-32 |
| 4×4 Matrix Keypad | 1 | Membrane type |
| Servo Motor | 1 | SG90 or MG90S (9g) |
| PIR Motion Sensor | 1 | HC-SR501 |
| Magnetic Reed Switch | 1 | Normally Open |
| Fire Sensor | 1 | KY-026 or similar (Digital Output) |
| Active Buzzer | 1 | 5V |
| Red LED | 1 | 5mm |
| Green LED | 1 | 5mm |
| Resistors | 2 | 220Ω (for LEDs) |
| Breadboard | 1 | Full size recommended |
| Jumper Wires | ~30 | Male-to-Male & Male-to-Female |
| Power Supply | 1 | 5V 2A adapter |

**Estimated Cost:** $25-35 USD

---

## 📋 Prerequisites

### Hardware
- ESP32 Development Board
- USB cable for programming
- All components listed above
- Computer with USB port

### Software
- [Arduino IDE](https://www.arduino.cc/en/software) (version 1.8.19 or newer)
- ESP32 Board Support
- Required Arduino Libraries (see Installation section)

---

## 🚀 Installation & Setup

### Step 1: Install Arduino IDE
1. Download and install Arduino IDE from [official website](https://www.arduino.cc/en/software)
2. Launch Arduino IDE

### Step 2: Install ESP32 Board Support
1. Open Arduino IDE
2. Go to **File → Preferences**
3. Add this URL to "Additional Board Manager URLs":
   ```
   https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   ```
4. Go to **Tools → Board → Boards Manager**
5. Search for "ESP32"
6. Install "**esp32 by Espressif Systems**"

### Step 3: Install Required Libraries
Go to **Sketch → Include Library → Manage Libraries** and install:

1. **ESP32Servo** by Kevin Harrington
   - Search: "ESP32Servo"
   - Install latest version

2. **Keypad** by Mark Stanley, Alexander Brevig
   - Search: "Keypad"
   - Install latest version

3. **HTTPClient** (Built-in with ESP32)
4. **WiFi** (Built-in with ESP32)

### Step 4: Hardware Assembly
1. Follow the detailed wiring instructions in [CIRCUIT_DIAGRAM.md](CIRCUIT_DIAGRAM.md)
2. Double-check all connections before powering on
3. Ensure servo has external power supply

### Step 5: Configure the Project
1. Download/clone this project
2. Open `SmartDoorLock.ino` in Arduino IDE
3. Open `config.h` file
4. Update the following settings:

```cpp
// WiFi Credentials
const char* WIFI_SSID = "Your_WiFi_Name";
const char* WIFI_PASSWORD = "Your_WiFi_Password";

// IoT Server URL
const char* SERVER_URL = "http://192.168.1.100:3000/api";

// Default Password (inside SmartDoorLock.ino)
const String correctPassword = "1234";  // Change to your desired password
```

### Step 6: Upload Code to ESP32
1. Connect ESP32 to computer via USB
2. Select board: **Tools → Board → ESP32 Arduino → ESP32 Dev Module**
3. Select port: **Tools → Port → (Your ESP32 COM Port)**
4. Click **Upload** button (→)
5. Wait for "Done uploading" message

### Step 7: Monitor Serial Output
1. Open Serial Monitor: **Tools → Serial Monitor**
2. Set baud rate to: **115200**
3. You should see system initialization messages

---

## 🎮 How to Use

### Basic Operation

#### 🔓 Unlocking the Door
1. Enter your password using the keypad (default: `1234`)
2. Press `#` to submit
3. Green LED turns ON
4. Servo unlocks the door
5. System enters UNLOCKED mode for 10 seconds
6. Door automatically locks after timeout

#### 🔒 Locking the Door
- Press `A` for manual lock
- Door auto-locks after 10 seconds in unlocked mode
- Door locks automatically when alarm is silenced

#### Password Entry
- Enter digits: `0-9`
- Submit password: Press `#`
- Clear password: Press `*`

#### 🚨 Alarm Control
- Press `B` to silence alarm (during alarm mode)

### Keypad Functions

| Key | Function |
|-----|----------|
| `0-9` | Enter password digits |
| `#` | Submit password |
| `*` | Clear password |
| `A` | Manual lock |
| `B` | Silence alarm |
| `C` | Reserved |
| `D` | Reserved |

---

## 🌐 IoT Dashboard Integration

### Server Setup Options

#### Option 1: Local Node.js Server (Recommended for Testing)
See [SERVER_SETUP.md](SERVER_SETUP.md) for complete server implementation

#### Option 2: Firebase
```cpp
// In config.h, set:
const char* SERVER_URL = "https://your-project.firebaseio.com/smartlock";
```

#### Option 3: ThingsBoard
```cpp
// In config.h, set:
const char* SERVER_URL = "https://demo.thingsboard.io/api/v1/YOUR_ACCESS_TOKEN";
```

#### Option 4: Custom Cloud Server
Deploy your custom REST API and update `SERVER_URL`

### API Endpoints

The ESP32 communicates with the server using these endpoints:

**POST `/update`** - Send system status
```json
{
  "mode": "LOCKED",
  "locked": true,
  "doorOpen": false,
  "pirStatus": false,
  "fireDetected": false,
  "alarmActive": false,
  "timestamp": 123456
}
```

**POST `/alert`** - Send alarm alerts
```json
{
  "alert": "MOTION",
  "timestamp": 123456
}
```

**GET `/command`** - Receive commands from server
Response: `"LOCK"`, `"UNLOCK"`, `"SILENCE"`, `"STATUS"`

---

## 🔧 Configuration Options

Edit `config.h` to customize:

```cpp
// Password Settings
#define DEFAULT_PASSWORD "1234"
#define MAX_WRONG_ATTEMPTS 3

// Timing Settings (milliseconds)
#define SENSOR_CHECK_INTERVAL 500       // Sensor polling rate
#define IOT_UPDATE_INTERVAL 2000        // Data upload rate
#define ALARM_DURATION 30000            // Alarm timeout
#define UNLOCK_DURATION 10000           // Auto-lock timeout

// Servo Settings
#define SERVO_LOCK_ANGLE 0              // Locked position
#define SERVO_UNLOCK_ANGLE 90           // Unlocked position
```

---

## 🎓 System Logic Flow

```
┌─────────────────────────────────────────────┐
│           SYSTEM BOOT UP                    │
│  - Initialize hardware                      │
│  - Connect to WiFi                          │
│  - Set LOCKED mode                          │
└────────────────┬────────────────────────────┘
                 │
                 v
         ┌───────────────┐
         │  LOCKED MODE  │ ←──────────────┐
         │  - Red LED ON │                 │
         │  - Monitoring │                 │
         └───────┬───────┘                 │
                 │                         │
      ┌──────────┴──────────┐             │
      │                     │             │
      v                     v             │
┌──────────┐        ┌──────────────┐     │
│ Correct  │        │   Intrusion  │     │
│ Password │        │   Detected   │     │
└────┬─────┘        └──────┬───────┘     │
     │                     │             │
     v                     v             │
┌──────────────┐    ┌──────────────┐     │
│ UNLOCKED     │    │ ALARM MODE   │     │
│ - Green LED  │    │ - Buzzer ON  │     │
│ - Door Open  │    │ - LED Blink  │     │
│ - 10s Timer  │    │ - IoT Alert  │     │
└──────┬───────┘    └──────┬───────┘     │
       │                   │             │
       │                   │ Silence (B) │
       └───────────────────┴─────────────┘
```

---

## 🚨 Alarm Triggers

The system triggers alarm in these scenarios:

| Trigger | Condition | Mode Required |
|---------|-----------|---------------|
| **Motion Detection** | PIR sensor detects movement | LOCKED |
| **Forced Entry** | Door opened without password | LOCKED |
| **Fire Detection** | Fire sensor activated | ANY MODE |
| **Wrong Password** | 3 consecutive wrong attempts | ANY MODE |

---

## 🐛 Troubleshooting

### Problem: ESP32 won't connect to WiFi
**Solutions:**
- Check SSID and password in `config.h`
- Ensure WiFi is 2.4GHz (ESP32 doesn't support 5GHz)
- Move ESP32 closer to router
- Check serial monitor for connection status

### Problem: Servo not moving
**Solutions:**
- Verify servo connection to GPIO 13
- Use external 5V power supply for servo
- Check servo power wires (Red=5V, Brown=GND, Orange=Signal)
- Test servo angle values (0 and 90)

### Problem: Keypad not responding
**Solutions:**
- Verify all 8 keypad connections (4 rows + 4 columns)
- Check pin numbers match code
- Test individual keys and check serial monitor
- Ensure proper keypad library is installed

### Problem: PIR sensor always triggered
**Solutions:**
- Wait 30-60 seconds after power on (calibration period)
- Adjust sensitivity potentiometer on PIR module
- Check PIR is not facing heat sources or moving objects
- Verify PIR connection to GPIO 25

### Problem: Fire sensor false alarms
**Solutions:**
- Adjust sensitivity potentiometer on fire sensor
- Ensure sensor is not exposed to direct sunlight
- Keep away from heat sources
- Test with actual fire source (carefully)

### Problem: IoT updates not working
**Solutions:**
- Verify WiFi connection
- Check SERVER_URL is correct
- Ensure server is running and accessible
- Check serial monitor for HTTP error codes
- Test server URL in web browser

---

## 📊 Serial Monitor Commands

When the system is running, you can monitor these messages:

```
=== IoT Smart Door Lock System ===
Initializing...
✓ Servo initialized (LOCKED)
Connecting to WiFi: YourWiFi
✓ WiFi Connected
IP Address: 192.168.1.100
✓ System Ready
================================

Key pressed: 1
Key pressed: 2
Key pressed: 3
Key pressed: 4
Key pressed: #
Checking password... ✓ CORRECT
🔓 UNLOCKING DOOR
Mode: UNLOCKED

👤 MOTION DETECTED!
🚨 ALARM TRIGGERED: MOTION
Mode: ALARM
✓ Alert sent to server
```

---

## 🔒 Security Recommendations

### For Production Use:
1. **Change default password** - Never use "1234" in real deployment
2. **Use HTTPS** - Encrypt server communication
3. **Implement authentication** - Add API keys or tokens
4. **Add encryption** - Encrypt password transmission
5. **Log events** - Maintain security audit logs
6. **Physical security** - Secure ESP32 inside locked enclosure
7. **Emergency access** - Have backup mechanical override
8. **Regular updates** - Keep firmware updated

---

## 📸 Expected Behavior

### Normal Operation (LOCKED)
- 🔴 Red LED: **ON** (steady)
- 🟢 Green LED: **OFF**
- 🔊 Buzzer: **SILENT**
- 🚪 Servo: **0° (locked)**

### Unlocked State
- 🔴 Red LED: **OFF**
- 🟢 Green LED: **ON** (steady)
- 🔊 Buzzer: **2 beeps confirmation**
- 🚪 Servo: **90° (unlocked)**

### Alarm State
- 🔴 Red LED: **BLINKING** (fast)
- 🟢 Green LED: **OFF**
- 🔊 Buzzer: **SIREN** (pulsing)
- 🚪 Servo: **0° (locked)**

---

## 🎓 Learning Resources

### ESP32 Resources
- [ESP32 Official Documentation](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/)
- [ESP32 Arduino Core](https://github.com/espressif/arduino-esp32)

### Arduino Resources
- [Arduino Language Reference](https://www.arduino.cc/reference/en/)
- [Arduino Forum](https://forum.arduino.cc/)

### IoT Platforms
- [Firebase Documentation](https://firebase.google.com/docs)
- [ThingsBoard Documentation](https://thingsboard.io/docs/)

---

## 📈 Future Enhancements

Potential improvements for this project:
- [ ] RFID card access
- [ ] Fingerprint sensor integration
- [ ] Mobile app (Android/iOS)
- [ ] Face recognition using ESP32-CAM
- [ ] Voice control integration
- [ ] Multiple user passwords
- [ ] Scheduling (auto-lock times)
- [ ] Battery backup system
- [ ] SD card logging
- [ ] Email/SMS notifications

---

## 📄 Project Files

```
IOT Project/
├── SmartDoorLock/
│   ├── SmartDoorLock.ino    # Main Arduino code
│   └── config.h              # Configuration file
├── CIRCUIT_DIAGRAM.md        # Wiring instructions
├── README.md                 # This file
└── SERVER_SETUP.md          # Optional server guide
```

---

## 🤝 Contributing

This is an educational project. Feel free to:
- Report issues
- Suggest improvements
- Fork and enhance
- Share your implementations

---

## 📝 License

This project is open-source and available for educational purposes.

---

## 👨‍💻 Project Information

**Course:** IoT (Internet of Things)  
**Project Type:** Smart Home Security System  
**Difficulty Level:** Intermediate  
**Estimated Build Time:** 4-6 hours  
**Programming Language:** C++ (Arduino)  
**Platform:** ESP32

---

## 📞 Support

If you encounter issues:
1. Check the [Troubleshooting](#-troubleshooting) section
2. Verify all connections per [CIRCUIT_DIAGRAM.md](CIRCUIT_DIAGRAM.md)
3. Review serial monitor output at 115200 baud
4. Ensure all libraries are correctly installed

---

## ⭐ Acknowledgments

- ESP32 Community
- Arduino Community
- Espressif Systems

---

**🎉 Happy Building! Good luck with your IoT course project!**
