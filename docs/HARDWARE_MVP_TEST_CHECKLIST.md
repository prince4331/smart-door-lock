# Hardware MVP Test Checklist — Smart Door Lock

Date: 2026-09-18  
Branch: mvp/final-smart-lock-upgrade  
Scope: Physical hardware bench validation

---

## 1. Pre-Flashing Checklist

- [ ] USB-to-UART / ESP-PROG programmer ready and set to 3.3V logic level.
- [ ] PlatformIO CLI or IDE installed.
- [ ] Main ESP32 board and ESP32-CAM board identified.
- [ ] Backup any existing NVS flash partitions if preserving test keys: esptool.py read_flash ...
- [ ] Confirm pp_config.h is prepared from pp_config_example.h with local MQTT host and credentials.

---

## 2. Boot & Wi-Fi Provisioning Flow

### 2.1 First Boot / Missing Credentials
- [ ] Erase NVS: pio run -t erase (or flash empty NVS partition).
- [ ] Flash firmware: pio run -t upload.
- [ ] Open serial monitor at 115200 baud.
- [ ] Verify device attempts STA connection and times out after 60s.
- [ ] Verify SoftAP starts with SSID SmartLock-Setup-XXXXXX and IP 192.168.4.1.
- [ ] Connect mobile phone or test laptop to the SoftAP SSID.
- [ ] Open browser to http://192.168.4.1.
- [ ] Enter target Wi-Fi credentials and submit.
- [ ] Verify device connects to target Wi-Fi network and stores credentials in NVS.
- [ ] Verify device reboots or transitions to STA mode, successfully connecting to MQTT broker.

### 2.2 Dashboard-Triggered Provisioning
- [ ] Ensure device is online and registered on dashboard.
- [ ] Click Start Wi-Fi Setup on the Wi-Fi Provisioning card.
- [ ] Confirm action in modal dialog.
- [ ] Verify device enters SoftAP mode upon receiving START_PROVISIONING command.

---

## 3. Access Control & Servo Operations

### 3.1 Software Lock/Unlock
- [ ] From dashboard, click Lock.
- [ ] Verify MQTT message smartlock/command is dispatched with replay nonce.
- [ ] Observe servo rotates to locked position (0° / configured locked angle).
- [ ] Verify smartlock/command_ack publishes status LOCKED.
- [ ] Test hold-to-unlock: hold unlock button for 2 seconds.
- [ ] Observe servo rotates to unlocked position (90° / configured unlocked angle).
- [ ] Verify smartlock/command_ack publishes status UNLOCKED.

### 3.2 Replay Attack Prevention
- [ ] Capture an authenticated unlock MQTT payload.
- [ ] Replay the identical payload to smartlock/command.
- [ ] Verify main ESP32 rejects the command with ERR_REPLAY_DETECTED and servo does not move.

---

## 4. Local Safety Invariants (Offline Bench Test)

- [ ] Disconnect Wi-Fi access point or MQTT broker while device is locked.
- [ ] Verify dashboard reports device offline within 15 seconds.
- [ ] Trigger physical flame/fire sensor (simulate HIGH/LOW level on fire GPIO).
- [ ] Verify servo IMMEDIATELY unlocks (< 1 ms response) without network dependency.
- [ ] Verify red LED / alarm buzzer activates locally.
- [ ] Reconnect network; verify alarm state is published to broker upon reconnect.

---

## 5. Persistent Motion & Presence State Machine

### 5.1 30-Second Presence Threshold
- [ ] In dashboard Presence Detection card, select 30 seconds and click Save.
- [ ] Verify backend responds 200 OK and publishes SET_PRESENCE_30 to MQTT.
- [ ] Trigger PIR motion sensor continuously or intermittently (within 15s grace window).
- [ ] Verify state transitions: IDLE -> PENDING (after first motion).
- [ ] Keep motion active for 30 seconds.
- [ ] Verify state transitions to CONFIRMED, then CAPTURED -> COOLDOWN.
- [ ] Verify smartlock/alert receives PRESENCE_CONFIRMED and CAM_TRIGGER_UNAVAILABLE (or camera trigger if wired).
- [ ] Verify 5-minute cooldown starts: further motion within 5 minutes must NOT trigger new alerts.

### 5.2 60-Second Presence Threshold
- [ ] Select 60 seconds on dashboard and click Save.
- [ ] Verify SET_PRESENCE_60 is published and NVS stores 60.
- [ ] Reboot device; verify device boots with 60-second threshold restored from NVS.
- [ ] Verify presence requires full 60 seconds of motion before confirming.

### 5.3 Stuck PIR Fault / Tamper Protection
- [ ] Hold PIR pin permanently HIGH for 120 seconds.
- [ ] Verify a single tamper alert STUCK_PIR_TAMPER is emitted.
- [ ] Confirm no repeating camera capture or alert flood occurs while held HIGH.

---

## 6. Telegram Alert Delivery

- [ ] Open Settings modal in dashboard; enter valid Telegram Bot Token and Chat ID.
- [ ] Click Send Test Message; verify test message arrives on Telegram.
- [ ] Trigger door forced entry (reed switch opens while locked).
- [ ] Verify high-priority Telegram alert is received.
- [ ] Trigger fire sensor; verify fire alert is received on Telegram.

---

## 7. Camera Companion Verification

- [ ] Power ESP32-CAM companion module.
- [ ] Check serial monitor of ESP32-CAM; verify it joins Wi-Fi and connects to MQTT broker.
- [ ] Send test command to smartlock/cam/command with event ID.
- [ ] Verify ESP32-CAM captures image and publishes chunks to smartlock/cam/chunk.
- [ ] Verify backend reassembles JPEG and serves it at /api/cam/latest.
- [ ] Verify dashboard updates with latest camera snapshot.
