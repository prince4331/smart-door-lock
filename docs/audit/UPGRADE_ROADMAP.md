# Upgrade Roadmap — Smart Door Lock

Audit date: 2026-09-17
Branch: `feature/software-access-provisioning-alerts`

This roadmap describes the requested architecture and the remaining verification and production work. “Implemented” below means present in the feature design; it does not claim a build, runtime, browser, or hardware pass.

## Phase 0 — Access and alert-flow replacement

Goal: remove the damaged keypad path and replace mismatched camera/Telegram flows without weakening the existing authentication boundary.

| # | Action | Status |
| --- | --- | --- |
| 0.1 | Remove keypad initialization, scanning, PIN comparison, failed-attempt logic, `SET_PIN`, and PIN UI/API | Implemented |
| 0.2 | Make the authenticated dashboard the only electronic unlock path, with deliberate hold-to-unlock and command states | Implemented |
| 0.3 | Add NVS/Preferences AP/STA provisioning to both firmwares with fixed `192.168.4.1` setup gateways and unique setup-code labels | Implemented |
| 0.4 | Keep Wi-Fi passwords out of MQTT and require a nearby phone for offline/new-location provisioning | Implemented |
| 0.5 | Replace UART/`CAM_CAPTURE_URL` triggering with `smartlock/cam/command` and MQTT image chunks | Implemented |
| 0.6 | Add persistent-motion selection (30/60 seconds), 15-second grace, five-minute cooldown, and one automatic capture per session | Implemented |
| 0.7 | Preserve immediate forced-entry capture and local fire auto-unlock | Implemented |
| 0.8 | Move Telegram settings and delivery to the backend with AES-256-GCM encryption and masked responses | Implemented |
| 0.9 | Remove production credentials from documentation/examples and rotate any credentials exposed in repository history | Open — owner action |

Exit criteria: no keypad/PIN access path, no direct camera Telegram path, no camera HTTP/UART trigger dependency, and no committed production credential. Verification evidence must be recorded separately.

## Phase 1 — Verification and stabilization

Goal: prove that the feature works across both firmware toolchains, the backend, the browser, and hardware.

| # | Action | Status |
| --- | --- | --- |
| 1.1 | Build the ESP-IDF lock firmware and PlatformIO ESP32-CAM firmware | Not verified |
| 1.2 | Exercise AP fallback, setup-code access, credential test-before-save, and 10-minute timeout on both devices | Not verified |
| 1.3 | Test MQTT command, ACK, presence-setting, camera-command, duplicate-event, and chunk-reassembly paths | Not verified |
| 1.4 | Test 29/30/60-second presence behavior, 15-second grace, five-minute cooldown, stuck PIR, and forced entry | Not verified |
| 1.5 | Run backend tests with Telegram fully mocked and verify encrypted settings, masked responses, and one delivery per event | Not verified |
| 1.6 | Run browser checks for authentication, hold-to-unlock states, offline states, and authenticated camera loading | Not verified |
| 1.7 | Run secret scanning and confirm no production credential is committed | Not verified |

Exit criteria: actual toolchain, runtime, browser, and hardware results are recorded; failures are fixed before release.

## Phase 2 — User identity and stronger access control

Goal: replace the single shared administrator token with accountable access.

| # | Action | Status |
| --- | --- | --- |
| 2.1 | Add user accounts, hashed credentials, sessions, refresh/revocation, and server-side authorization | Future |
| 2.2 | Add admin/viewer roles enforced at every backend resource boundary | Future |
| 2.3 | Add WebAuthn/passkeys after user accounts and sessions exist | Future |
| 2.4 | Add per-device credentials or certificates, topic ownership, and revocation | Future |

Exit criteria: dashboard access is attributable and revocable without rotating a shared fleet secret.

## Phase 3 — Command reliability and offline behavior

Goal: make remote operation predictable without implying offline unlock capability.

| # | Action | Status |
| --- | --- | --- |
| 3.1 | Add command IDs, idempotency, replay protection, and duplicate ACK handling | Future |
| 3.2 | Define explicit offline states for unlock, presence settings, provisioning requests, and camera commands | Future |
| 3.3 | Add bounded retry/queue behavior only where it cannot create an unsafe or misleading unlock | Future |
| 3.4 | Harden MQTT TLS, broker ACLs, and per-device topic authorization | Future |

Exit criteria: retries are safe, observable, and never presented as a successful unlock without device acknowledgement.

## Phase 4 — Operations and production readiness

Goal: make deployment, recovery, and alert delivery maintainable.

| # | Action | Status |
| --- | --- | --- |
| 4.1 | Add retention, backup, and restore procedures for state, events, and private camera media | Future |
| 4.2 | Add structured logs, delivery-status metrics, and sanitized alert diagnostics | Future |
| 4.3 | Separate environment-specific configuration and secret injection; keep `.env` out of production images | Future |
| 4.4 | Add signed firmware release, staged rollout, rollback, and credential-rotation runbooks | Future |

Exit criteria: an operator can deploy, rotate credentials, restore data, and diagnose Telegram or camera delivery without exposing secrets.

## Suggested next step

Rotate any previously exposed credentials, then collect the Phase 1 verification evidence. Do not mark a build, test, or hardware check as passed until its actual output is available.
