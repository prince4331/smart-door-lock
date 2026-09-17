# Upgrade Roadmap — Smart Door Lock

Audit date: 2026-09-16
Baseline commit: `01d91cf` (branch `audit/full-codebase-baseline-20260916`)

**This roadmap is documentation only, except where a status column says
otherwise.** It is derived from `AUDIT_REPORT.md` and
`FEATURE_COMPLETENESS_MATRIX.md`.

Phases are ordered by risk: earlier phases remove active exposure; later
phases add capability. Do not skip Phase 0.

Status legend: **DONE** = implemented on branch `fix/phase-0-security-containment`
and covered by `server/test/security.test.mjs` or `server/test/verify-phase0.mjs`.
Anything unmarked remains open.

A corrective review pass on 2026-09-17 closed the remaining gaps in the Phase 0
items below: the persisted camera snapshot is no longer a static asset
(0.7), the environment file is resolved, loaded once, and validated before any
service is created (0.3, 0.8), duplicate `express.json()` / `express.static()`
mounts were collapsed, and every runtime test artifact now lands in a per-run
temporary directory. No item outside Phase 0 was started.

---

## Phase 0 — Immediate security containment

Goal: remove live exposure and close the open-door paths. No architecture
changes; purely containment.

| # | Action | Addresses | Effort | Status |
|---|--------|-----------|--------|--------|
| 0.1 | Rotate Wi-Fi password, MQTT broker account, Telegram bot token, and the default PIN on every device | SEC-01, SEC-02 | Owner action, out of band | **Open — owner action, cannot be done in code** |
| 0.2 | Keep `firmware/include/app_config.h` and camera credentials out of source control via the `.gitignore` rule added by this audit; onboard via `app_config_example.h` | SEC-01 | Done in baseline | **DONE in baseline** |
| 0.3 | Make `authenticateAccessToken` fail closed when `DASH_TOKEN` is unset | SEC-03 | Small | **DONE — and the corrective review moved the gate ahead of service creation: the env file is resolved, loaded once, then validated, and the process exits before the listener, MQTT, camera, Telegram or database is touched** |
| 0.4 | Add authentication to `/api/state`, `/api/events`, `/api/stream`, and the camera proxy routes; remove them from the rate-limit `skip` list | SEC-04 | Small | **DONE** |
| 0.5 | Require `https://` plus a camera token for `CAM_SNAPSHOT_URL` / `CAM_STREAM_URL` | SEC-07 | Small | **PARTIAL — https:// enforced at startup; camera token required on upload** |
| 0.6 | Decide canonical repository; treat `iotlabesp` history as exposed and rotate accordingly | GOV-01, GOV-02 | Decision | **Remotes normalized; history-exposure decision still open (see AUDIT_REPORT SEC-01)** |
| 0.7 | Serve persisted camera media only through an authenticated route, never from the public static root | SEC-09 | Small | **DONE — corrective review removed the tracked `public/cam/latest.jpg` from source control and the static mount; the legacy path is a hard 404 and the snapshot is served only by authenticated `GET /api/cam/latest`** |
| 0.8 | Enforce a minimum token length so a short or guessable token cannot pass startup validation | SEC-03 | Small | **DONE** |

Phase 0 additionally delivered, beyond the original list:

- Separate mandatory `CAM_UPLOAD_TOKEN` for `POST /api/cam/upload`, which the
  dashboard token cannot satisfy (SEC-02 separation).
- 401 for every missing/invalid credential, never 403, so the UI can
  distinguish "log in again" from "you may not do this".
- Constant-time token comparison.
- Dashboard replaced the headerless `EventSource` stream with a `fetch()`-based
  SSE client sending `Authorization: Bearer`, plus bounded exponential backoff
  and a 401 → login-state transition (UI-02, 5.1).
- `DISABLE_RATE_LIMIT` is now honoured only in development/test; the limiter
  always runs otherwise (API-03, pulled forward from Phase 4.5).
- 62 automated regression assertions in `server/test/security.test.mjs`, plus
  dashboard and live-startup probes in `server/test/`. The corrective review
  added coverage for the startup configuration gate, camera-media privacy, and
  the fail-closed paths around the relocated snapshot.
- A full acceptance verifier, `server/test/verify-phase0.mjs`, runs the whole
  Phase 0 checklist in one pass: dependency integrity and `npm audit`, syntax
  of every shipped module, `npm test`, fail-closed startup with a missing
  token, a healthy startup that must keep listening, the HTTP auth matrix,
  camera-media probes, the dashboard probe, a secret scan of tracked files,
  and a baseline-diff clean-tree gate that fails the suite itself if any run
  leaves the working tree dirty.
- Fail-closed startup that loads the environment file exactly once, then
  validates the effective configuration, and exits naming the missing
  variable before the listener, MQTT, camera, Telegram or database is
  created. The documented `cp .env.example .env && npm start` workflow now
  works, and process-env values still take precedence over the file.
- Every runtime artifact — database, camera storage, generated env files — is
  written to a per-run temporary directory removed on teardown, so neither
  the test suite nor the verification harness can leave the working tree
  dirty. The verifier hard-fails if it does.
- Dependency advisories remediated with `npm audit fix` (no `--force`), 11
  packages changed, 1 removed, 0 remaining (GOV-05, pulled forward from 1.5).
- Unused `API_KEY` machine-to-machine path and its dead `authenticateApiKey`
  middleware were removed, along with the now-unreferenced `API_KEY` entry in
  `server/.env.example`. No route depended on them.
- Middleware de-duplicated and re-ordered: security headers/CORS → request
  parsing → public static dashboard assets → rate limiting → `/api/`
  authentication → API routes → error handler. `express.json()` and
  `express.static()` had each been mounted twice.
- The persisted camera snapshot was removed from the public static root
  entirely (`public/cam/latest.jpg` is no longer tracked; the directory is
  gone). It is written to `server/data/cam/` — untracked, outside the web
  root — and served only by authenticated `GET /api/cam/latest`. The legacy
  `/cam/latest.jpg` path returns a hard 404. The dashboard loads it via a
  blob/object URL, so no token is ever placed in a URL.
- Repository normalized in this phase: `server/.git` nested repository moved
  out of the tree, remotes reduced to the canonical
  `github.com/prince4331/smart-door-lock`, and the branch
  `fix/phase-0-security-containment` is the only branch carrying these
  changes. Never merged into `main`; review only.
- Corrective review pass (2026-09-17): `express.json()` and
  `express.static()` are each mounted exactly once, in the documented order;
  `dotenv.config()` is called exactly once; the camera pane in the dashboard
  fetches through the authenticated route and renders via a revoked blob
  object URL; the tracked `public/cam/latest.jpg` was removed from source
  control (its history exposure is a recommendation to rotate, not a new
  incident — see AUDIT_REPORT SEC-09).

Exit criteria: no credential readable from any branch; no unauthenticated
`/api/*` response other than a health probe; control endpoints fail closed.

**Status:** the code-side exit criteria are met. The remaining blocker is 0.1,
credential rotation, which is an owner action outside the repository.

---

## Phase 1 — Build and runtime stabilization

Goal: make the codebase reproducibly buildable so later fixes are verifiable.

| # | Action | Addresses | Effort |
|---|--------|-----------|--------|
| 1.1 | Install an ESP-IDF (and/or PlatformIO) toolchain and build both firmware projects | REL-05, GOV-04 | Medium |
| 1.2 | Resolve the `app_config.h` bootstrap: fresh clone must compile by copying the template | REL-05 | Small |
| 1.3 | Remove dead `ca_cert.h` or wire it in; explicitly attach the CA bundle and verify broker TLS | REL-05 | Small |
| 1.4 | Add `LICENSE`, `CIRCUIT_DIAGRAM.md`, `SERVER_SETUP.md` or drop the README references | GOV-03 | Small |
| 1.5 | Commit a dependency lockfile and run `npm audit fix` | GOV-05 | Small | **DONE — lockfile committed, `npm audit fix` applied, 0 advisories remain** |
| 1.6 | Decide the fate of `server/.git` (plain subdirectory vs. separate repo) | GOV-01 | Decision | **DONE — `server/.git` backed up out of the tree and removed from the working path; commits now land in the canonical repo** |

Exit criteria: both firmware projects compile; backend installs and boots
from a clean clone; dependency advisories triaged.

---

## Phase 2 — Authentication and device security

Goal: replace shared static secrets with real identity.

| # | Action | Addresses | Effort |
|---|--------|-----------|--------|
| 2.1 | User accounts with hashed passwords, login, sessions/JWT, refresh and revocation | SEC-08 | Large |
| 2.2 | Roles (admin/viewer) enforced server-side at every resource boundary; drop client-side `VIEWER_MODE` gating | SEC-08, UI-01 | Medium |
| 2.3 | Per-device credentials/certificates at provisioning; per-device topics; revocation list | SEC-02 | Large |
| 2.4 | Command HMAC signing with device keys; nonce ledger in NVS/RTC; reject duplicates | SEC-06 | Medium |
| 2.5 | Constant-time PIN comparison and hashed, salted PIN storage | SEC-05, REL-03 | Medium |
| 2.6 | Brute-force lockout with escalating backoff on both PIN and token; alert on lockout | REL-03, API-03 | Medium |
| 2.7 | Secure pairing, device removal, and ownership transfer | SEC-02 | Medium |
| 2.8 | Wi-Fi provisioning without hardcoded credentials | SEC-01 | Medium |

Exit criteria: no shared fleet secret; every command is signed and
non-replayable; users and roles are enforced on the server.

---

## Phase 3 — Firmware reliability and hardware safety

Goal: the lock stays safe and recoverable under fault.

| # | Action | addresses | Effort |
|---|--------|-----------|--------|
| 3.1 | Power-fail-safe NVS state: two-slot rolling write with checksum; default to locked on read-back failure | REL-01 | Medium |
| 3.2 | Task watchdog registration for critical tasks; panic/recovery policy | REL-02 | Medium |
| 3.3 | Brownout and power-loss handling policy; documented boot default state | REL-02 | Medium |
| 3.4 | OTA: configure a signed `OTA_URL`, add anti-rollback | REL-02 | Medium |
| 3.5 | Servo repeated-actuation rate limit and max-duty guard | REL-04 | Small |
| 3.6 | Network-loss behavior: offline access rules, queued commands, explicit degraded mode | Matrix | Medium |
| 3.7 | Factory reset path; erase provisioning on reset | Matrix | Medium |

Exit criteria: power-cycle and fault-injection tests leave the lock in a
known safe state; OTA is signed with rollback protection.

---

## Phase 4 — Backend/API completion

Goal: a trustworthy control and data plane.

| # | Action | Addresses | Effort |
|---|--------|-----------|--------|
| 4.1 | Command idempotency: record issued command IDs, dedupe retries | API-01 | Medium |
| 4.2 | Replace lowdb with a real database; add schema, migrations, transactions, retention, backup | API-02 | Large |
| 4.3 | Append-only signed audit trail | SEC-08 | Medium |
| 4.4 | Tighten CORS to the dashboard origin; remove duplicate static mount | API-04 | Small |
| 4.5 | Separate read-path rate limiting; disallow `DISABLE_RATE_LIMIT` in production | API-03 | Small | **PARTIAL — `DISABLE_RATE_LIMIT` is now dev/test-only; separate read-path limits still open** |
| 4.6 | Request validation and length limits across all endpoints; SSE auth on connect | SEC-04 | Medium | **PARTIAL — SSE is authenticated on connect; general length limits still open** |
| 4.7 | Timezone-aware timestamps; notification delivery retries | Matrix | Medium |

Exit criteria: duplicate commands are deduped; state store is durable and
backed up; audit trail is tamper-evident.

---

## Phase 5 — Dashboard/mobile completion

Goal: a UI that reports the truth and fails visibly.

| # | Action | Addresses | Effort |
|---|--------|-----------|--------|
| 5.1 | Offline banner, SSE reconnection with backoff, command retry queue | UI-02 | Medium | **PARTIAL — SSE reconnect with bounded backoff + 401 handling shipped in Phase 0** |
| 5.2 | Explicit loading/empty/error states, including stale-camera indicator | UI-02, UI-03 | Medium |
| 5.3 | Server-side role enforcement reflected in the UI; remove client-only gating | UI-01 | Medium |
| 5.4 | Accidental-unlock prevention (server-side confirm/dedupe), duress/emergency-access UX | UI-01, Matrix | Medium |
| 5.5 | XSS and safe-rendering tests; accessibility and responsive pass | Matrix | Medium |
| 5.6 | Mobile application (none exists today) or documented PWA support | Matrix | Large |

Exit criteria: every screen has defined loading/empty/error/offline states;
authorization is never client-side only.

---

## Phase 6 — Testing, deployment, and production readiness

Goal: changes are gated by automated checks.

| # | Action | Addresses | Effort |
|---|--------|-----------|--------|
| 6.1 | Unit tests for command validation, auth middleware, idempotency, replay rejection | GOV-04 | Medium | **PARTIAL — command validation and auth middleware are covered; idempotency/replay still open** |
| 6.2 | Integration tests: API → MQTT → firmware command path against a broker test container | GOV-04 | Medium |
| 6.3 | CI workflow (lint, test, `npm audit`, firmware build on both targets) | GOV-04 | Medium |
| 6.4 | Hardware-in-the-loop or simulator harness for lock state transitions | GOV-04 | Large |
| 6.5 | Per-environment configs and secret manager; no `.env` in production images | SEC-01 | Medium |
| 6.6 | Observability: structured logs, metrics, tracing, alerting | Matrix | Medium |
| 6.7 | Backup/restore runbook and restore drill for the state store | API-02 | Medium |
| 6.8 | Release process: signed firmware, staged rollout, rollback plan | REL-02 | Medium |

Exit criteria: CI gates every merge; a restore drill and a rollback drill
have both been executed successfully.

---

## Suggested first step

Start Phase 0 item 0.1 (credential rotation) and items 0.3–0.4 (fail-closed
auth + authenticate read endpoints). Items 0.3 and 0.4 are small code changes
that remove the two open-door paths demonstrated during this audit, and they
should land before any feature work.
