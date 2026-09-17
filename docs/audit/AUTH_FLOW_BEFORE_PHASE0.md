# Authentication flow — pre-Phase-0 baseline

> **Historical record.** This describes the vulnerable baseline. The Phase 0
> implementation changed everything below — see the "After Phase 0" table at
> the end of this document, and `AUDIT_REPORT.md` → "Phase 0 status".

Recorded 2026-09-16 from branch `fix/phase-0-security-containment` at
`01d91cf` (before any Phase 0 change). This document is the Step 4
inspection record; it describes the vulnerable baseline, not the fix.

## 1. How the dashboard receives and stores the token

- `server/public/index.html:522` declares `let ACCESS_TOKEN = null`.
- `submitToken()` (`:579-589`) reads the value from `#tokenInput`, trims it,
  stores it in `sessionStorage` under key `dashAccessToken` (`:586`), hides
  the login overlay, and calls `initializeDashboard()`.
- `loadStoredToken()` (`:570-577`) runs on page start and restores the token
  from `sessionStorage` so a refresh keeps the session.
- `skipLogin()` (`:591-599`) sets `VIEWER_MODE = true`, clears the token, and
  still calls `initializeDashboard()`. This is the client-only "viewer mode"
  the audit flagged (UI-01) — it is advisory, not security.

## 2. Which REST calls send the token

| Call | Header | Header name | Location |
|------|--------|-------------|----------|
| `POST /api/command` | yes (conditional) | `X-Access-Token` | `index.html:1087` |
| `POST /api/pin` | yes | `X-Access-Token` | `index.html:1124` |
| `GET /api/state` | no | — | `index.html:649` |
| `GET /api/events` | no | — | `index.html:722` |
| `GET /api/cam/status` | no | — | `index.html:702` |
| `GET /api/health` | no | — | `index.html:632` |
| `/cam/latest.jpg?ts=...` | no | — | `index.html:697` (static, not `/api/*`) |

In the baseline **only the two write endpoints send a token at all.**

## 3. How `authenticateAccessToken` works

`server/src/index.js:407-424`:

1. `if (!DASH_TOKEN) return next();` — **fail-open** (audit SEC-03). If the
   env var is unset, every protected route is anonymous.
2. Reads `req.headers["x-access-token"]` only. No `Authorization: Bearer`
   support.
3. Missing token → `401`.
4. `crypto.timingSafeEqual` against `DASH_TOKEN` with a length pre-check →
   `401` on mismatch.

A separate `authenticateApiKey` (`:387-404`) guards the firmware path using
`x-api-key` / `?api_key=`, and returns **403** on a wrong key — a
status-code inconsistency the fix corrects so an invalid credential is
always 401.

## 4. Route inventory (as found)

Authenticated in the baseline:

- `POST /api/command` — `authenticateAccessToken` (control)
- `POST /api/pin` — `authenticateAccessToken` (control)

Public (unauthenticated) in the baseline:

- `GET /api/health`
- `GET /api/state` — live lock/door/alarm state
- `GET /api/events` — full event history
- `GET /api/stream` — SSE stream of every state/event/alert/camera message
- `GET /api/cam/status`
- `GET /api/cam/stream` — proxies the camera MJPEG upstream
- `GET /api/cam/capture` — triggers a snapshot fetch
- `GET /api/cam/snapshot` — serves `public/cam/latest.jpg`
- `GET /api/cam/upload` — **device endpoint**; checked against `CAM_TOKEN`
  via `x-cam-token` only when `CAM_TOKEN` is set, otherwise anonymous
- Static `/cam/latest.jpg` and `express.static` (public assets by design)

## 5. How the dashboard opens SSE

`index.html:1159-1201` `connectSSE()`:

- `new EventSource('/api/stream')` — the native API cannot attach a header,
  so the connection is anonymous.
- `es.onmessage` parses each frame and dispatches on `msg.type`:
  `state`, `alert`, `event`, `metrics`, `command_ack`, `cam`.
- `es.onerror` marks the UI disconnected, closes after 500 ms, and retries
  `connectSSE` after a fixed 2000 ms — no backoff, no 401 handling, so an
  expired token would loop forever.

## 6. Which paths the rate limiter skips

`server/src/index.js` limiter `skip` list:

- `/api/health`
- `/api/state`
- `/api/stream`
- `/api/cam/status`

The limiter is applied as `app.use("/api/", limiter)` and is disabled
entirely when `DISABLE_RATE_LIMIT=1`.

## 7. Camera routes in detail

- `pipeCameraStream()` (`:130-151`) proxies `CAM_STREAM_URL` over http/https
  and pipes the response through; 503 if unconfigured, 502 on upstream error.
- `fetchCameraSnapshot()` (`:113-128`) GETs `CAM_SNAPSHOT_URL`, writes the
  buffer to `public/cam/latest.jpg`, and broadcasts a `cam` SSE event.
- `/api/cam/capture` calls the snapshot fetch and returns the result.
- `/api/cam/upload` accepts base64 chunks; the device token check is
  `if (CAM_TOKEN && header !== CAM_TOKEN) return 401` — i.e. **optional**.

## 8. Whether any endpoint is used directly by ESP32-CAM firmware

**No.** The ESP32-CAM firmware (`firmware/esp32cam/src/main.cpp`) does not
call any HTTP endpoint of this server. Grep for `api/cam`, `x-cam-token`,
`CAM_TOKEN`, `http://`, `https://`, and `upload` in that file returned no
matches. The camera talks to the server exclusively over MQTT
(`smartlock/cam/meta`, `smartlock/cam/chunk`) and to Telegram over HTTPS.

Consequence for the fix: `/api/cam/upload` is a **device-to-server route in
design only**. It is safe to require `CAM_UPLOAD_TOKEN` there without
breaking any firmware path, because no firmware uses it. Camera chunk
reassembly happens in the MQTT message handler, not over HTTP.

## 9. Implementation plan (from actual code)

1. Extract the Express app into a testable module so tests can import it
   with MQTT/Telegram stubbed. Keep `app.listen` in the entrypoint only.
2. Startup validation: `DASH_TOKEN` mandatory (non-empty after trim); exit
   non-zero before `mqtt.connect()` and before `app.listen()` if it is
   missing. Validate before creating any external connection.
3. Replace `authenticateApiKey`'s 403-on-wrong-key with 401 so an invalid
   credential is always 401; keep 403 for a valid identity lacking a
   permission.
4. Add Bearer support: accept `Authorization: Bearer <token>` and fall back
   to `X-Access-Token` so the dashboard can migrate without breaking other
   clients.
5. Apply authentication as grouped middleware to everything under `/api/`
   except `/api/health`, so protection cannot be forgotten on new routes.
6. Keep `/api/cam/upload` on its own device token (`CAM_UPLOAD_TOKEN`),
   required when the route is enabled, fail-closed.
7. Narrow the rate-limit `skip` list to `/api/health` only; make
   `DISABLE_RATE_LIMIT` a no-op outside `NODE_ENV=test`/development.
8. Dashboard: replace `EventSource` with a `fetch()` streaming client that
   sends `Authorization: Bearer <token>`, parses SSE frames, closes before
   reconnect, stops on 401, and backs off exponentially.
9. Dashboard: send the token on `/api/state`, `/api/events`,
   `/api/cam/status`, `/api/command`, `/api/pin`; on 401 return to login.
10. Tests: Node's built-in test runner, app imported with MQTT stubbed,
    placeholder tokens generated per run.

---

## 10. After Phase 0 — corrective review pass (2026-09-17)

Every item in the plan above landed on `fix/phase-0-security-containment`.
This table is the delta against the baseline described in sections 1–9; it is
the authoritative "current state" companion to this historical record.

| # | Baseline behaviour (this document) | After Phase 0 |
|---|------------------------------------|---------------|
| 1 | Token stored in `sessionStorage`; client-only `VIEWER_MODE` gating | Unchanged on the client. Server-side `/api/*` auth makes `VIEWER_MODE` cosmetic only — still flagged UI-01 until Phase 2.2 lands |
| 2 | Only `/api/command` and `/api/pin` sent a token; reads were anonymous | Every `/api/*` route except `/api/health` requires `Authorization: Bearer` (or `X-Access-Token`), including `/api/state`, `/api/events`, `/api/stream`, and all camera routes |
| 3 | `if (!DASH_TOKEN) return next()` — fail-open; no Bearer support | Fail-closed: `DASH_TOKEN` and `CAM_UPLOAD_TOKEN` mandatory, minimum 16 characters, validated **before** the listener, MQTT, camera, or Telegram is created. Bearer supported. 401 for every missing/invalid credential, never 403. Constant-time compare. `authenticateApiKey` and the `API_KEY` path removed entirely |
| 4 | `/api/state`, `/api/events`, `/api/stream`, `/api/cam/*` public | All authenticated. `/api/health` is the sole anonymous route |
| 5 | `new EventSource('/api/stream')` — anonymous, fixed 2000 ms retry, no 401 handling | `fetch()`-based SSE client sending `Authorization: Bearer`; bounded exponential backoff; 401 transitions the UI back to login state |
| 6 | Limiter skipped `/api/health`, `/api/state`, `/api/stream`, `/api/cam/status`; `DISABLE_RATE_LIMIT=1` disabled it anywhere | `skip` narrowed to `/api/health`; `DISABLE_RATE_LIMIT` honoured only when `NODE_ENV` is `development` or `test` — the limiter always runs in production |
| 7 | `fetchCameraSnapshot()` wrote to `public/cam/latest.jpg`, served anonymously by `express.static`; `/api/cam/snapshot` served it too | Snapshot persisted to `server/data/cam/latest.jpg` — **outside** the public root, untracked. Served only by authenticated `GET /api/cam/latest` with path-traversal defence and `Cache-Control: no-store, private`. The legacy `/cam/latest.jpg` path returns a hard 404, anonymous **and** authenticated. `/api/cam/snapshot` is gone |
| 8 | `/api/cam/upload` checked `CAM_TOKEN` only when set — optional, fail-open | Separate mandatory `CAM_UPLOAD_TOKEN`; the dashboard token is not accepted on that route and the device token is not accepted on dashboard routes (SEC-02 separation) |
| 9 | Dashboard loaded the image as a plain `<img src="/cam/latest.jpg">` static asset | `fetch()` with `Authorization: Bearer` → `res.blob()` → `URL.createObjectURL`, revoking the previous object URL on every refresh and on logout. No token ever appears in a URL |
| — | Configuration: `dotenv.config()` called twice, validation before it, so `cp .env.example .env && npm start` failed unless the shell exported the variables | The intended env file is resolved (honouring `DOTENV_CONFIG_PATH`, absolute paths handled correctly on Windows), `dotenv.config()` runs **exactly once**, the effective configuration is validated, and the process exits naming the missing variable before any service starts. Process-env values still take precedence over the file |
| — | Middleware mounted twice: `express.json()` and `express.static()` each duplicated | Each mounted once, in order: security headers/CORS → request parsing → public static dashboard assets → rate limiting → `/api/` authentication → API routes → error handler |
| — | Tests overwrote the tracked JPEG and left the worktree dirty | Every runtime artifact — database, camera storage, generated env files — goes to a per-run temporary directory removed on teardown. 62 assertions in `server/test/security.test.mjs`, plus `probe-phase0.mjs`, `dashboard-phase0.mjs` (15 checks), and the full `verify-phase0.mjs` acceptance suite, which fails itself if the working tree is left dirty |

**Still open, deliberately not claimed as fixed:** SEC-01 (committed credentials
in history — owner-side rotation only), SEC-02 (shared fleet secrets — Phase
2), and the replay/idempotency gaps (SEC-06, API-01 — Phase 2.4 / Phase 4.1).
See `UPGRADE_ROADMAP.md` for the full plan.
