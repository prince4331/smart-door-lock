# Audit Report — Smart Door Lock

Audit date: 2026-09-16
Baseline commit: `b0893d7` — branch `audit/full-codebase-baseline-20260916`
Target repository: `github.com/prince4331/smart-door-lock`

Scope: full system — ESP32 lock firmware, ESP32-CAM firmware, Node/Express
backend, browser dashboard, repository structure, and secret hygiene.

Severity scale used here:

- **Critical** — actively leaks a credential or allows unauthorized lock
  control. Remediate before any further feature work.
- **High** — security or safety defect that could cause unauthorized access,
  lock failure, or data loss in realistic conditions.
- **Medium** — correctness/reliability defect or missing control likely to
  matter in production.
- **Low** — quality, maintainability, or minor hygiene issue.

Secret values are never reproduced below. Every secret-bearing line is
described by file and line and marked for rotation.

---

## Integration strategy (Phase 3)

The workspace root was already a Git repository, so no `git init` was needed.
Two facts drove the strategy:

1. Local `master` is a fast-forward descendant of `origin`
   (`github.com/prince4331/iotlabesp`), and local tracked files match that
   remote's `master` tree exactly.
2. Local history and the `smart` remote's history (`smart-door-lock`, default
   branch `main`) share **no common ancestor** — `git merge-base` fails
   between them. The local `server/` subtree is, however, byte-identical in
   file set to `smart-door-lock`'s tree, and the `server/` directory is itself
   a nested working clone of that repository.

Because the histories are unrelated, per the task's rule C the two versions
were **not** force-merged and `main` was not rewritten. Instead:

- A new branch `audit/full-codebase-baseline-20260916` was created from
  local `master`.
- The baseline commit added the complete local project (firmware, diagrams,
  sanitized templates, gitignore hardening) and removed the
  secret-bearing `app_config.h` from tracking.
- The branch was pushed normally (no `--force`) to `smart`.
- `main` on `smart-door-lock` was left untouched at `a8337b1`.
- The nested `server/.git` repository was left in place and untouched; only
  the root `.gitignore` was extended to exclude it.

---

## Critical findings

### SEC-01 — Live credentials committed to a public repository

- **Severity:** Critical
- **Component:** Firmware config, camera firmware
- **Evidence:**
  - `firmware/include/app_config.h:3-7` defines `WIFI_STA_SSID`,
    `WIFI_STA_PASS`, `MQTT_BROKER_URI`, `MQTT_USERNAME`, `MQTT_PASSWORD`.
  - `firmware/include/app_config.h:9` defines a default PIN via
    `DEFAULT_LOCK_PASSWORD` used as the fallback unlock code.
  - `firmware/esp32cam/src/main.cpp:11-25` defines `ssid`, `password`,
    `mqtt_host`, `mqtt_user`, `mqtt_pass`, `tg_bot_token`, `tg_chat_id`.
  - These files are committed in the `origin` remote (`iotlabesp`),
    confirmed public. This audit removed them from the baseline branch and
    replaced them with placeholders.
- **Actual impact:** Anyone can read the Wi-Fi credentials, the MQTT broker
  hostname and account, and the Telegram bot token. With the MQTT credentials
  an attacker can publish to `smartlock/command` and, subject to the 300 s
  timestamp window (SEC-06), unlock the door. The Telegram token allows
  reading alert photos and impersonating the bot. The committed default PIN
  is a universal unlock code for any device still using it.
- **Root cause:** No separation between configuration templates and live
  secrets; `.gitignore` did not exclude `app_config.h`; camera firmware
  inlines credentials as string constants.
- **Recommended correction:** Rotate ALL of the following immediately —
  Wi-Fi password, MQTT broker account, Telegram bot token (revoke via
  BotFather), and the default PIN (change on every device). Then keep
  `firmware/include/app_config.h` and the camera credentials out of source
  control via the `.gitignore` rule added by this audit, and use the added
  `app_config_example.h` / `app_config_local.example.h` templates. Note that
  removing a file from a later commit does **not** remove it from history:
  the values remain in `origin` (`iotlabesp`) history and must be rotated
  regardless.
- **Verification method:** `git log -p --all -- firmware/include/app_config.h`
  on the `origin` remote; `git ls-files` on the audit branch (absent);
  `git check-ignore firmware/include/app_config.h` (ignored).
- **Dependencies:** Rotation is an out-of-band action only the device owner
  can perform. It is the single most urgent item.
- **Additional exposure (pre-existing, not introduced by this audit):**
  `server/render.yaml:13-15` also hardcodes the MQTT broker host and the
  MQTT username. These values have been public on `smart-door-lock`'s `main`
  since the original `01ac2bf` commit. The corresponding `MQTT_PASSWORD` and
  `DASH_TOKEN` are correctly marked `sync: false` and are not in the file.
  Because the broker host plus account name are exposed, the rotated MQTT
  account should use a new username as well as a new password.

### SEC-02 — Shared device credentials across the whole fleet

- **Severity:** Critical
- **Component:** Device provisioning / MQTT
- **Evidence:** `firmware/include/app_config.h` carries one MQTT
  username/password pair compiled into every device; `server/.env` holds the
  same broker account. There is no per-device identity, key, or certificate.
- **Actual impact:** One leaked credential compromises every device. There is
  no way to revoke a single device, and no device attestation or ownership
  concept exists.
- **Root cause:** No device-identity layer was ever implemented.
- **Recommended correction:** Introduce a unique credential (or client
  certificate) per device at provisioning, plus per-device topics and a
  per-device credential record on the server so a device can be revoked
  individually.
- **Verification method:** Grep for MQTT credential symbols; confirm a single
  static pair.
- **Dependencies:** Requires a provisioning flow (Phase 2 of the roadmap).

### SEC-03 — `authenticateAccessToken` silently disables auth when token unset

- **Severity:** Critical
- **Component:** Backend auth middleware
- **Evidence:** `server/src/index.js:408`
  `if (!DASH_TOKEN) return next(); // Skip if not configured`
- **Actual impact:** If the `DASH_TOKEN` environment variable is empty or
  absent in any deployment, **every control endpoint becomes
  unauthenticated** — `POST /api/command` accepts an unlock command with no
  token at all. A misconfigured or partially started deployment silently
  becomes an open door rather than failing closed.
- **Root cause:** Development convenience defaulting to permissive behavior
  in a security-critical path.
- **Recommended correction:** Fail closed — refuse to start, or reject all
  control requests, when `DASH_TOKEN` is not configured.
- **Verification method:** Start the server with `DASH_TOKEN` unset and issue
  `POST /api/command` (reproduced during this audit).
- **Dependencies:** None.

### SEC-04 — Read and streaming endpoints are unauthenticated

- **Severity:** High
- **Component:** Backend REST + SSE
- **Evidence:**
  - `server/src/index.js:458` `app.get("/api/state", ...)` — no middleware.
  - `server/src/index.js:472` `app.get("/api/events", ...)` — no middleware.
  - `server/src/index.js:564` `app.get("/api/stream", ...)` — SSE, no
    middleware.
  - `server/src/index.js:499-511` `/api/cam/*` — no middleware other than the
    optional camera token on upload.
  - The rate limiter's `skip` list (`:439-443`) explicitly bypasses
    `/api/health`, `/api/state`, `/api/cam/status`, and `/api/stream`, so
    these endpoints are both unauthenticated and rate-limit-free.
- **Actual impact:** **Verified at runtime during this audit:** with a valid
  `DASH_TOKEN` configured, `GET /api/state` returned the full live lock state
  (locked/alarm/door/uptime/rssi/heap) with **no token and no header**. The
  SSE stream likewise carries every state change, alert, and camera event to
  any anonymous client. An attacker learns door state, presence patterns, and
  event history, and can stream camera-derived events indefinitely.
- **Root cause:** Auth middleware was applied per-route only to write/control
  routes, and the limiter `skip` list widened the gap.
- **Recommended correction:** Apply authentication to all `/api/*` endpoints
  except a genuine health probe; remove the unauthenticated paths from the
  rate-limit skip list (or keep a narrow health bypass only).
- **Verification method:** `curl` probes with and without the token against
  a locally started server (executed during this audit; results in the build
  table of the final report).
- **Dependencies:** None.

### SEC-05 — PIN compare uses non-constant-time `strcmp`

- **Severity:** High
- **Component:** Firmware authentication
- **Evidence:** `firmware/src/main.c:555-620` — `handle_command()` compares
  the keypad PIN and the `SET_PIN` command using `strcmp` against the stored
  PIN. The command set itself is compared with `strcmp` at `:539-550`.
- **Actual impact:** A local or network observer able to time repeated PIN
  attempts can shorten brute force via timing leakage. Note the server-side
  token comparisons *do* use `crypto.timingSafeEqual`
  (`server/src/index.js:399`, `:419`), so this gap is firmware-only.
- **Root cause:** Convenience of `strcmp`; no constant-time helper available
  in the firmware layer.
- **Recommended correction:** Compare digests (e.g. SHA-256 of the PIN with a
  per-device salt) rather than the raw PIN, and/or use a constant-time
  comparison loop.
- **Verification method:** Static review of `handle_command`.
- **Dependencies:** None, but coordinate with the NVS storage change in
  REL-03.

### SEC-06 — Command replay is possible inside the 300 s window

- **Severity:** High
- **Component:** Firmware command validation
- **Evidence:** `firmware/src/main.c:516-553` `validate_command()` parses
  `<command>|<nonce>|<timestamp>` and rejects timestamps outside
  `CMD_TIMESTAMP_WINDOW_SEC` (300 s, `app_config.h`), but the nonce is
  **never stored or checked**, so it provides uniqueness in form only.
  Server-side, the nonce is generated with `Date.now()*1000 + random*1000`
  and is not recorded either (`server/src/index.js:549`).
- **Actual impact:** Any captured command (e.g. from the public broker
  credentials in SEC-01/SEC-02) can be replayed repeatedly for up to 300
  seconds, and any *new* unauthorized command forged in that window is
  accepted. Combined with SEC-01 this is a remotely reachable unlock.
- **Root cause:** Replay protection was implemented as a freshness check
  only; no nonce ledger or HMAC signature exists.
- **Recommended correction:** Add per-command HMAC signing with a device key,
  track consumed nonces in NVS/RTC memory, and reject duplicates. Shortening
  the window alone does not fix replay.
- **Verification method:** Read `validate_command`; confirm no nonce store.
- **Dependencies:** Device-key work in roadmap Phase 2.

### SEC-07 — Plain HTTP transport between camera and backend

- **Severity:** Medium
- **Component:** Camera integration
- **Evidence:** `server/src/index.js:117` `fetch(CAM_SNAPSHOT_URL)` and
  `:139` `client.get(CAM_STREAM_URL)` use plain HTTP; `pipeCameraStream`
  (`:130-151`) supports https but only when the URL says so. Camera firmware
  connects to Telegram over TLS but the snapshot fetch is unauthenticated
  plain HTTP.
- **Actual impact:** Camera snapshots and the MJPEG stream can be observed or
  injected on-path; `/api/cam/stream` also proxies an unauthenticated
  upstream to any client (see SEC-04).
- **Root cause:** No TLS or token enforcement on the camera HTTP endpoints.
- **Recommended correction:** Require `https://` and a shared camera token
  for snapshot/stream URLs, and authenticate the proxy route.
- **Verification method:** Inspect `fetchCameraSnapshot` /
  `pipeCameraStream`.
- **Dependencies:** SEC-04 fix.

### SEC-08 — No user accounts, roles, or audit-trail integrity

- **Severity:** Medium
- **Component:** Backend / authorization
- **Evidence:** A single static `DASH_TOKEN` gates control
  (`server/src/index.js:407-424`); there are no users, sessions, refresh
  tokens, or per-door permissions. Events are stored in a mutable JSON file
  (`db.data.events`, `:241-274`) with no integrity protection, so any write
  access can alter the audit trail.
- **Actual impact:** No accountability, no revocation of an individual user,
  no admin/guest separation, no guarantee the event history is trustworthy
  after an incident.
- **Root cause:** Single-user hobby architecture.
- **Recommended correction:** Add user accounts with hashed passwords, roles
  (admin/viewer), per-door authorization, and append-only signed event
  records.
- **Recommended:** roadmap Phase 2.
- **Verification method:** Absence of any auth schema or user table.
- **Dependencies:** SEC-03/SEC-04 first.

---

## Firmware reliability and hardware safety

### REL-01 — NVS lock-state persistence relies on best-effort writes

- **Severity:** Medium
- **Component:** Firmware state persistence
- **Evidence:** `firmware/src/main.c` writes the lock state to NVS on each
  change using `nvs_set_*` / `nvs_commit`. There is no power-fail-safe
  two-copy/rolling scheme and no CRC/checksum guard on read-back.
- **Actual impact:** A power loss exactly during a write, or NVS corruption,
  can leave the persisted lock state inconsistent with the physical lock.
- **Recommended correction:** Use a two-slot rolling write with a checksum
  and validate on boot; default to the physically safe (locked) state when
  read-back fails.
- **Verification method:** Review of NVS read/write paths.

### REL-02 — No watchdog or crash-recovery policy documented in firmware

- **Severity:** Medium
- **Component:** Firmware availability
- **Evidence:** No `esp_task_wdt_init` / watchdog registration, and no panic
  handler beyond the ESP-IDF default. OTA is present
  (`#include "esp_https_ota.h"`) but `OTA_URL` in `app_config.h` is empty, so
  the update path is effectively unconfigured.
- **Actual impact:** A hung task (e.g. a blocking MQTT or servo call) leaves
  the lock unattended indefinitely; there is no guaranteed recovery.
- **Recommended correction:** Register the critical tasks with the task
  watchdog, keep the OTA URL configured and signed, and add rollback policy.
- **Verification method:** Grep for `wdt` in `firmware/` — none found.

### REL-03 — Keypad lockout and NVS PIN storage need review

- **Severity:** Medium
- **Component:** Firmware authentication
- **Evidence:** `app_config.h` defines `WRONG_ATTEMPTS_MAX 3` and
  `KEYPAD_LOCKOUT_MS 30s`, implemented in the sensor/keypad task. The PIN is
  stored in NVS under `NVS_KEY_PASSWORD`. The lockout is time-based only;
  there is no exponential backoff, no admin alert on lockout, and the PIN is
  stored and compared in plaintext (SEC-05).
- **Actual impact:** A persistent local attacker can brute-force at 3
  attempts per 30 s with no escalation or alerting.
- **Recommended correction:** Escalating backoff, alert on repeated lockout,
  hashed PIN storage.
- **Verification method:** Review of keypad task and NVS keys.

### REL-04 — Servo PWM driver has no independent safety clamp

- **Severity:** Low
- **Component:** Lock actuation
- **Evidence:** `firmware/src/servo_control.c` drives the servo via LEDC PWM.
  Actuation is initiated from `handle_command` and the sensor task. There is
  no repeated-actuation rate limit or mechanical-fault feedback (no
  end-stop/encoder input), so a command storm or a stuck reed switch could
  cycle the servo continuously (heating/wear).
- **Actual impact:** Physical wear or battery drain under fault conditions.
- **Recommended correction:** Add a minimum interval between actuations and
  a max-duty guard.
- **Verification method:** Review of `servo_control.c` and its callers.
- **Note:** Per the audit ground rules, **no actuation logic or pin assignment
  was modified**.

### REL-05 — Dead code and include-path drift

- **Severity:** Low
- **Component:** Firmware maintainability
- **Evidence:**
  - `firmware/include/ca_cert.h` declares a root certificate but is not
    `#include`d by `main.c` or `servo_control.c` — dead.
  - `main.c` includes `esp_crt_bundle.h` but there is no evidence
    `esp_crt_bundle_attach()` is called, so TLS validation on the MQTT
    connection cannot be confirmed as enabled from the source.
  - `servo_control.c` includes `app_config.h`, which is now untracked after
    SEC-01 remediation, so a fresh clone will not compile until the template
    is copied to `app_config.h`.
- **Actual impact:** A fresh clone will not build; TLS validation may be
  silently absent.
- **Recommended correction:** Explicitly call `esp_crt_bundle_attach()` or
  include `ca_cert.h` and verify the broker CA; document the
  `app_config.h` bootstrap step in the README.
- **Verification method:** `grep -rn "ca_cert" firmware/` (no consumer);
  include-path analysis described in `CODEBASE_INVENTORY.md`.

---

## Backend, API, and data

### API-01 — No command idempotency; duplicate unlocks double-actuate

- **Severity:** Medium
- **Component:** Backend command path
- **Evidence:** `server/src/index.js:548-560` — each `POST /api/command`
  generates a fresh nonce and publishes immediately. The server keeps no
  record of issued commands, so a retried request (or a double-click)
  publishes twice and the device actuates twice.
- **Actual impact:** Duplicate lock/unlock cycles; the dashboard's own
  retry logic can amplify this.
- **Recommended correction:** Record issued command IDs and reject
  duplicates; return the existing ACK for a repeat.
- **Verification method:** Read of the command handler; no idempotency store
  exists.

### API-02 — `data.db` / `data.json` file store has no transactional safety

- **Severity:** Medium
- **Component:** Backend persistence
- **Evidence:** lowdb `db.write()` is called on every event
  (`:243`, `:254`, `:272`). Concurrent SSE broadcasts plus writes share one
  file with no locking; events are capped at 500 by array slicing.
- **Actual impact:** Under load the store can lose events or corrupt the
  JSON; there is no backup or retention policy.
- **Recommended correction:** Add write locking or move to a real database;
  add retention and backup.
- **Verification method:** Read of MQTT message handlers.

### API-03 — Rate limiting present but bypassed on the most exposed paths

- **Severity:** Medium
- **Component:** Backend availability
- **Evidence:** `server/src/index.js:431-445` — limiter applies to `/api/*`
  but `skip` excludes `/api/health`, `/api/state`, `/api/cam/status`,
  `/api/stream`. `DISABLE_RATE_LIMIT=1` disables it entirely.
- **Actual impact:** Brute-forcing the access token is only throttled on
  control endpoints; the unauthenticated read paths can be hammered.
- **Recommended correction:** Keep rate limiting on auth endpoints, apply a
  separate read-path limiter, and do not allow total disablement in
  production.
- **Verification method:** Read of limiter config plus runtime probes.

### API-04 — CORS and static path allow broad origins

- **Severity:** Low
- **Component:** Backend transport security
- **Evidence:** `server/src/index.js:427-428` mounts `express.json()` and a
  static path; the CORS configuration that follows allows a broad origin set.
  `express.static` is mounted **twice** (`:428` and `:576`).
- **Actual impact:** A malicious site could issue cross-origin requests to
  the dashboard backend if a browser session holds the token.
- **Recommended correction:** Restrict CORS to the known dashboard origin;
  remove the duplicate static mount.
- **Verification method:** Read of middleware ordering.

---

## Dashboard

### UI-01 — Viewer mode and token gating are advisory, not enforced

- **Severity:** Medium
- **Component:** Dashboard authorization
- **Evidence:** `server/public/index.html:1057` and `:1113` — command
  requests are skipped only `if (VIEWER_MODE || !ACCESS_TOKEN)`. The token is
  stored in `sessionStorage` (`:571`, `:586`), and `VIEWER_MODE` is a
  client-side flag (`:523`, `:602`).
- **Actual impact:** UI gating is trivially bypassed; since the server does
  not protect read endpoints (SEC-04), viewer mode provides no real
  separation. There is no role concept in the UI.
- **Recommended correction:** Enforce roles server-side; never rely on
  client-side flags for authorization.
- **Verification method:** Read of dashboard script.

### UI-02 — No offline / empty / error states; token never cleared on failure

- **Severity:** Low
- **Component:** Dashboard UX robustness
- **Evidence:** `index.html:594`, `:604`, `:608` clear the token only in
  narrow paths. On SSE disconnect (`:1160`) there is no exponential backoff
  or queued command; a lock/unlock tap during a drop can be lost or doubled
  (cf. API-01).
- **Actual impact:** Users may believe a command succeeded when it did not,
  or re-tap and double-actuate.
- **Recommended correction:** Add explicit offline banner, retry queue, and
  clear "sent vs. acknowledged" UI states.
- **Verification method:** Read of dashboard script and SSE handler.

### UI-03 — Camera pane has no error/offline recovery

- **Severity:** Low
- **Component:** Dashboard camera UX
- **Evidence:** `index.html:560-564` (`camStream`, `camPlaceholder`,
  `camSpinner`, `camError`, `camStatus`) exist but the stream error path
  shows no retry or stale-image indicator.
- **Recommended correction:** Add retry with backoff and a "stale snapshot"
  timestamp.
- **Verification method:** Read of camera pane code.

---

## Repository hygiene and governance

### GOV-01 — Nested Git repository inside `server/` was not ignored

- **Severity:** Medium
- **Component:** Repository structure
- **Evidence:** `server/.git/` existed before this audit and
  `git check-ignore server/.git/HEAD` returned nothing (not ignored). A
  `git add .` at the project root would have committed the nested
  repository's objects and history.
- **Actual impact:** Risk of accidentally embedding one repository inside
  another, breaking tooling and leaking the nested repo's refs.
- **Recommended correction:** This audit added `server/.git/` to the root
  `.gitignore`. Prefer converting `server/` to a normal subdirectory
  (removing its `.git`) or moving it to its own repo, once the team confirms
  no local commits exist only in the nested repo.
- **Verification method:** `git check-ignore -v server/.git/HEAD` now
  reports ignored; the nested repo itself was left untouched.
- **Dependencies:** User decision (see blockers).

### GOV-02 — Two remotes with unrelated histories

- **Severity:** Medium
- **Component:** Repository structure
- **Evidence:** `origin` → `iotlabesp` (default `master`) contains the full
  tree **including committed credentials** (SEC-01). `smart` →
  `smart-door-lock` (default `main`) contained only the server subtree and
  shares no ancestor with local history. The local `server/` subtree matches
  `smart-door-lock`'s tree exactly (verified by file-set diff), and
  `smart-door-lock` also has a `master` branch identical to its `main`.
- **Actual impact:** Two sources of truth for the same project; pushing to
  the wrong remote leaks or splits history.
- **Recommended correction:** Choose one canonical repository. Retire the
  other after confirming the audit branch is merged. Until then, push only
  to `smart` on audit branches.
- **Verification method:** `git ls-remote`, `git merge-base` (fails),
  file-set diff.
- **Dependencies:** User decision (see blockers).

### GOV-03 — README references files that do not exist

- **Severity:** Low
- **Component:** Documentation
- **Evidence:** `README.md` references `LICENSE` and `CIRCUIT_DIAGRAM.md`,
  neither of which exists in the workspace. `README.md` also describes
  app-style control and setup steps (`SERVER_SETUP.md`) that are absent.
- **Recommended correction:** Add the missing files or remove the stale
  references.
- **Verification method:** `ls` of referenced paths.

### GOV-04 — Zero tests and no CI anywhere in the project

- **Severity:** Medium
- **Component:** Quality / release readiness
- **Evidence:** No test files, no `test` script in `package.json`, no
  `.github/` workflows, no hardware-in-the-loop harness.
- **Actual impact:** No regression protection; the auth bypass (SEC-04) and
  replay gap (SEC-06) would not be caught by any current check.
- **Recommended correction:** Add unit tests for the command/auth paths and
  a CI workflow; see roadmap Phase 6.
- **Verification method:** File search for test patterns (none found).

### GOV-05 — Known-vulnerable dependencies

- **Severity:** Medium
- **Component:** Backend supply chain
- **Evidence:** `npm ci` reports 7 vulnerabilities in the dependency tree
  (installed from the existing lockfile during this audit).
- **Actual impact:** Depends on the specific advisories; unexamined
  dependency risk.
- **Recommended correction:** Run `npm audit fix` and review remaining
  advisories.
- **Verification method:** `npm audit` output captured during Phase 4.
- **Note:** The lockfile was generated locally by `npm ci` and is **not**
  committed by this audit.

---

## Build and verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Backend dependency install | `npm ci` (in `server/`) | PASS — 7 vulns (GOV-05) |
| Backend syntax | `node --check src/index.js` | PASS |
| Backend startup | `node src/index.js` | PASS — boots, prints listening port |
| Health endpoint | `GET /api/health` (port 3999) | PASS — HTTP 200 |
| Auth on control endpoint | `POST /api/command` without token | PASS — 401 (token was configured) |
| Auth on read endpoint | `GET /api/state` without token | **FAIL — 200 returned, no token** (SEC-04) |
| SSE auth | `GET /api/stream` | NOT PROTECTED (SEC-04) |
| Lock firmware build | ESP-IDF / PlatformIO | NOT RUN — no toolchain installed |
| Camera firmware build | PlatformIO | NOT RUN — no toolchain installed |
| Pushed-tree secret scan | `git grep` over the pushed branch | PASS for files this audit touched; `server/render.yaml:13-15` retains pre-existing broker host/username (see SEC-01 note) |
| Firmware static balance | brace/paren/bracket depth | PASS — balanced |
| Firmware include consistency | header resolution analysis | PARTIAL — `ca_cert.h` unused, `app_config.h` now untracked (REL-05) |
| Unit/integration tests | none present | NOT PRESENT |
| Frontend build | no bundler present | NOT PRESENT |

All runtime probes used a locally started server on port 3999 with
example/placeholder credentials. No production database, broker, or
hardware was contacted or mutated, and no real door-lock hardware was
actuated. The test server was shut down after probing.

---

## Blockers requiring user input

1. **Credential rotation (SEC-01/SEC-02).** The Wi-Fi password, MQTT broker
   account, Telegram bot token, and default PIN must be rotated out of band.
   Removing `app_config.h` from the baseline branch does not purge it from
   `origin` (`iotlabesp`) history, where it remains publicly readable. This
   cannot be done by the audit and is the top priority.
2. **Repository consolidation decision (GOV-01/GOV-02).** Which repository is
   canonical — `iotlabesp` (holds full history, also the leaked secrets) or
   `smart-door-lock`? Should `server/.git` be removed to make `server/` a
   plain subdirectory? The audit branch is left unmerged pending this.
3. **Merge of the audit branch into `main`.** Not performed, by design,
   because local and `smart` histories share no ancestor. Confirm before
   merging.
4. **Firmware build verification.** No ESP-IDF/PlatformIO toolchain is
   installed in this environment, so firmware compiles were not verified.
   Confirm whether a toolchain should be installed for Phase 1 of the
   roadmap.
