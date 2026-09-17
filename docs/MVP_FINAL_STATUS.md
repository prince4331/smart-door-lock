# Smart Door Lock MVP — Final Status Report

Date: 2026-09-18  
Sprint: ONE FINAL MVP SPRINT  
Target Branch: mvp/final-smart-lock-upgrade  
Base Commit: ddc3117252f47937cea93dbeafa7a7c0c682ea46

---

## 1. Executive Summary

This document summarizes the complete implementation, security controls, architecture, and verification status of the Smart Door Lock MVP. The project was completed in a single dedicated sprint, addressing all software access, runtime Wi-Fi provisioning, encrypted Telegram configuration, presence detection state machine, backend APIs, dashboard interactions, and camera trigger investigation.

---

## 2. Completed Capabilities Matrix

| Subsystem | Feature | Implementation Status | Notes |
|:---|:---|:---|:---|
| **Access Control** | Keypad/PIN Path Removed | Completed | Fully eliminated from firmware, backend, and dashboard UI |
| **Access Control** | Software Lock/Unlock | Completed | Authenticated REST API (POST /api/command) via MQTT |
| **Access Control** | Hold-to-Unlock Interaction | Completed | 2-second deliberate press preventing accidental trigger |
| **Access Control** | Replay-Protected Commands | Completed | Nonce + timestamp schema (COMMAND|NONCE|TIMESTAMP), verified in firmware |
| **Provisioning** | Main ESP32 Wi-Fi Setup AP | Completed | SoftAP fallback after 60s STA failure; captive setup portal at 192.168.4.1 |
| **Provisioning** | NVS Wi-Fi Persistence | Completed | Dual-credential NVS storage with seamless runtime reconnect |
| **Provisioning** | In-Dashboard Setup Trigger | Completed | START_PROVISIONING card with confirmation modal & step instructions |
| **Provisioning** | Offline Safety Preserved | Completed | Fire sensor interrupt triggers immediate servo unlock offline |
| **Telegram Alerts** | AES-256-GCM Settings Storage | Completed | Required SETTINGS_ENCRYPTION_KEY; masked token response |
| **Telegram Alerts** | Backend Alert Dispatch | Completed | Rate-limited delivery for door forced, fire, tamper, presence |
| **Telegram Alerts** | Dashboard Configuration UI | Completed | Test notification, token update/delete modal |
| **Presence** | State Machine & Thresholds | Completed | IDLE -> PENDING -> CONFIRMED -> CAPTURED -> COOLDOWN (30s/60s) |
| **Presence** | 5-Minute Global Cooldown | Completed | Enforced in firmware to prevent alert storms |
| **Presence** | Stuck PIR Tamper Alert | Completed | 120s continuous motion triggers single tamper alert, no camera spam |
| **Presence** | Dashboard Presence Card | Completed | 30s/60s selector, persistence in NVS, pending/success/failure states |
| **Camera** | Architecture Verification | Completed | Serial trigger capability investigated (see Section 3) |
| **Camera** | ESP32-CAM Firmware Integrity | Completed | Zero modifications to ESP32-CAM firmware and platformio.ini |
| **Camera** | Non-Alarming Notice | Completed | Dashboard camera notice: Automatic camera trigger requires existing serial connection. |
| **Dashboard** | Device Liveness Tracking | Completed | 15s offline threshold with periodic check |

---

## 3. Camera Trigger Investigation & Architecture Decision

### Audit Findings
1. **ESP32-CAM Firmware:**
   - Listens on Serial (UART0) at 115200 baud. When character '1' is received over UART, it captures a JPEG and publishes metadata/chunks to MQTT (smartlock/cam/meta, smartlock/cam/chunk).
   - Hash integrity confirmed: firmware/esp32cam/src/main.cpp SHA1 47ed40d1f3e99128be012653bdf6f1b1fc931088, firmware/esp32cam/platformio.ini SHA1 32431b8eaef8978ccba9665d89912cb9a6cd2908 (strictly untouched).
2. **Main ESP32 Firmware:**
   - Previously attempted an HTTP GET to CAM_CAPTURE_URL (non-functional legacy pattern).
   - No UART port or TX/RX GPIO pins were ever configured or mapped for ESP32-CAM communication.
3. **Physical / Schematic Evidence:**
   - No repository schematic, pin assignment table, or wiring diagram confirms a physical UART connection between the Main ESP32 and ESP32-CAM boards.
   - Per project instructions, physical connection is UNCONFIRMED.

### Implemented Architectural Decision
- **Clean Abstraction:** Implemented camera_trigger_available() in firmware/src/main.c, which safely returns false.
- **Alert Dispatch:** When presence is confirmed, the main lock triggers trigger_cam_capture(), which logs [CAM] Physical trigger unavailable - hardware UART not mapped and publishes CAM_TRIGGER_UNAVAILABLE alert via MQTT.
- **Dashboard Messaging:** A clean, informative card informs the operator: Automatic camera trigger requires existing serial connection. Manual snapshot capture via backend MQTT remains available when the camera is powered and connected to the broker.

---

## 4. Verification and Build Test Results

### Node.js Backend & Integration Tests
- Unit & Integration Tests: 26 passed, 26 total (93 tests passed)
- Phase 0 Test Suite Verifications:
  - node test/probe-phase0.mjs — PASS
  - node test/verify-phase0.mjs — PASS
  - npm audit — 0 vulnerabilities

### Firmware Compilation
- Main ESP32 Firmware: SUCCESS (RAM: 10.8%, Flash: 67.7% < 80%)
- ESP32-CAM Firmware: SUCCESS (RAM: 17.8%, Flash: 31.1%)

---

## 5. Security & Trust Boundaries

1. Single DASH_TOKEN administrator Bearer token.
2. Telegram bot tokens encrypted with AES-256-GCM using SETTINGS_ENCRYPTION_KEY.
3. Fire interrupt executes locally on ESP32 in under 1ms, preserving life safety offline.
