import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import mqtt from "mqtt";
import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import https from "https";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fail-closed startup, in this order:
//   1. Resolve the environment file (DOTENV_CONFIG_PATH or the default .env).
//   2. Load it with dotenv exactly once. Values already in the process
//      environment win; the file only fills gaps, so an operator's explicit
//      empty value is never silently overwritten from disk.
//   3. Validate the effective configuration.
//   4. On failure, exit before the HTTP listener, MQTT, the camera, Telegram,
//      or the database are ever created.
//   5. On success, initialise those services.
//
// Validating before dotenv would break the documented
// `cp .env.example .env && npm start` workflow, because the tokens would not
// be visible yet. Validating only the process environment is what made that
// workflow fail.
//
// NODE_ENV=test is the harness contract: a test imports this module, so it
// must not terminate the process; the caller asserts on validateConfig()
// directly.
const IS_TEST = process.env.NODE_ENV === "test";

// An absolute path is honoured as-is; a relative one resolves against the
// server directory. On Windows, path.resolve() would otherwise re-anchor an
// already-absolute POSIX path under the cwd and the file would never load.
const rawEnvPath = typeof process.env.DOTENV_CONFIG_PATH === "string"
  ? process.env.DOTENV_CONFIG_PATH.trim()
  : "";
export const ENV_FILE_PATH = rawEnvPath && path.isAbsolute(rawEnvPath)
  ? rawEnvPath
  : path.resolve(__dirname, rawEnvPath || ".env");

if (!IS_TEST) {
  // dotenv does not overwrite variables that already exist in the process
  // environment, so the caller's environment takes precedence over the file.
  dotenv.config({ path: ENV_FILE_PATH });

  const configErrors = validateServerConfig();
  if (configErrors.length) {
    // Every error message names the variable it is about, so the operator can
    // see exactly what to set without reading the source.
    for (const msg of configErrors) console.error(`[CONFIG] ${msg}`);
    console.error(`[CONFIG] Refusing to start: ${configErrors.length} configuration problem(s) above must be resolved first.`);
    process.exit(1);
  }
}

export function validateConfig({ dashToken, camUploadToken, camSnapshotUrl, camStreamUrl }) {
  const errors = [];
  // Tokens must not be merely non-empty: a guessable short value offers no
  // protection, so a minimum length is enforced at startup as well as by the
  // dashboard generating 32 hex characters.
  const MIN_TOKEN_LEN = 16;
  if (!dashToken || !dashToken.trim()) {
    errors.push("DASH_TOKEN is missing, empty, or whitespace-only. Set it in the environment before starting the server.");
  } else if (dashToken.trim().length < MIN_TOKEN_LEN) {
    errors.push(`DASH_TOKEN must be at least ${MIN_TOKEN_LEN} characters. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
  }
  if (!camUploadToken || !camUploadToken.trim()) {
    errors.push("CAM_UPLOAD_TOKEN is missing or empty. It is required for POST /api/cam/upload (set CAM_UPLOAD_TOKEN, or the legacy CAM_TOKEN name).");
  } else if (camUploadToken.trim().length < MIN_TOKEN_LEN) {
    errors.push(`CAM_UPLOAD_TOKEN must be at least ${MIN_TOKEN_LEN} characters. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
  }
  if (camSnapshotUrl && !camSnapshotUrl.startsWith("https://")) {
    errors.push("CAM_SNAPSHOT_URL must use https:// when configured.");
  }
  if (camStreamUrl && !camStreamUrl.startsWith("https://")) {
    errors.push("CAM_STREAM_URL must use https:// when configured.");
  }
  return errors;
}

export function validateServerConfig() {
  return validateConfig({
    dashToken: process.env.DASH_TOKEN,
    camUploadToken: process.env.CAM_UPLOAD_TOKEN || process.env.CAM_TOKEN,
    camSnapshotUrl: process.env.CAM_SNAPSHOT_URL,
    camStreamUrl: process.env.CAM_STREAM_URL,
  });
}

let nonceGenerator = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);
export function generateNonce() {
  return nonceGenerator();
}
export function setNonceGenerator(fn) {
  nonceGenerator = fn || (() => Date.now() * 1000 + Math.floor(Math.random() * 1000));
}

const PORT = process.env.PORT || 8080;
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://localhost:1883";
const MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID || "smartlock-server";
const MQTT_USERNAME = process.env.MQTT_USERNAME || undefined;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || undefined;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../data.db");
const DASH_TOKEN = process.env.DASH_TOKEN || "";
const CAM_UPLOAD_TOKEN = process.env.CAM_UPLOAD_TOKEN || process.env.CAM_TOKEN || "";
const CAM_STREAM_URL = process.env.CAM_STREAM_URL || "";
const CAM_SNAPSHOT_URL = process.env.CAM_SNAPSHOT_URL || "";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";

// True when this module runs as the entrypoint rather than imported by a test.
// The entrypoint is the only path that connects to MQTT and binds the HTTP
// listener; an import always uses the inert stub below.
const IS_ENTRYPOINT = process.argv[1] && path.resolve(process.argv[1]) === __filename;

// Express app setup
const app = express();

// CORS configuration for Netlify frontend
app.use(cors({
  origin: [
    'https://696a55b7389c2038ee4771ec--smart-door-lock.netlify.app',
    'https://smart-door-lock.netlify.app',
    'http://localhost:8080'
  ],
  credentials: true
}));

// Body parsing, mounted once: every route that reads JSON or a raw image body
// sits after this point.
app.use(express.json());
app.use(morgan("dev"));

// Public static assets: the dashboard UI itself. Runtime camera snapshots are
// deliberately NOT served from here — they live outside this directory and are
// only reachable through the authenticated /api/cam/latest route below.
// Mounted exactly once; the ordering is: security headers/CORS, body parsing,
// public static assets, rate limiting, API authentication, API routes.
app.use(express.static(path.join(__dirname, "../public")));

// Database setup (JSON file via lowdb)
const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, { state: null, events: [] });
await db.read();
db.data ||= { state: null, events: [] };
await db.write();

const ENABLE_MQTT = IS_ENTRYPOINT && !IS_TEST;

// MQTT client. The real broker connection is only created when this module
// runs as the entrypoint; when imported by tests ENABLE_MQTT is false, so the
// stub below is used and no broker connection is ever opened.
const mqttOpts = {
  clientId: MQTT_CLIENT_ID,
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  keepalive: 30,
  reconnectPeriod: 2000,
};

const mqttPublished = [];

function createMqttClient() {
  if (!ENABLE_MQTT) {
    // Inert stand-in used when the module is imported (tests) rather than run
    // as the entrypoint: records published messages and succeeds the callback
    // instead of opening a network connection.
    return {
      connected: false,
      publish: (topic, payload, opts, cb) => {
        if (typeof opts === "function") cb = opts;
        mqttPublished.push({ topic, payload: payload.toString() });
        if (typeof cb === "function") cb(null);
      },
      on: () => {},
      once: () => {},
      end: () => {},
    };
  }
  return mqtt.connect(MQTT_BROKER, mqttOpts);
}

const mqttClient = createMqttClient();

const MQTT_TOPIC_STATE = "smartlock/state";
const MQTT_TOPIC_ALERT = "smartlock/alert";
const MQTT_TOPIC_CMD = "smartlock/command";
const MQTT_TOPIC_METRIC = "smartlock/metric";
const MQTT_TOPIC_ACK = "smartlock/command_ack";
const MQTT_TOPIC_CAM_META = "smartlock/cam/meta";
const MQTT_TOPIC_CAM_CHUNK = "smartlock/cam/chunk";

const sseClients = new Set();

const usedNonces = new Set();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes, matches firmware window

function pruneOldNonces() {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const nonce of usedNonces) {
    if (nonce < cutoff) {
      usedNonces.delete(nonce);
    }
  }
}

// Runtime camera media lives OUTSIDE the public static root, so a snapshot can
// never be fetched without a dashboard token. Only the authenticated
// /api/cam/latest route below serves it.
const camDir = path.resolve(
  process.env.CAM_STORAGE_DIR && process.env.CAM_STORAGE_DIR.trim()
    ? process.env.CAM_STORAGE_DIR.trim()
    : path.join(__dirname, "..", "data", "cam")
);
const camLatestPath = path.join(camDir, "latest.jpg");
let camLastUpdate = 0;
fs.mkdirSync(camDir, { recursive: true });

const camChunks = new Map();
const CAM_CHUNK_TTL_MS = 120000;

async function sendTelegramMessage(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
    });
  } catch (err) {
    console.warn("[TG] sendMessage failed:", err.message);
  }
}

async function sendTelegramPhoto(caption) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  if (!fs.existsSync(camLatestPath)) return;
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`;
  try {
    const form = new FormData();
    form.append("chat_id", TG_CHAT_ID);
    if (caption) form.append("caption", caption);
    const data = fs.readFileSync(camLatestPath);
    form.append("photo", new Blob([data], { type: "image/jpeg" }), "latest.jpg");
    await fetch(url, { method: "POST", body: form });
  } catch (err) {
    console.warn("[TG] sendPhoto failed:", err.message);
  }
}

async function fetchCameraSnapshot() {
  if (!CAM_SNAPSHOT_URL) return false;
  try {
    const res = await fetch(CAM_SNAPSHOT_URL, { method: "GET" });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(camLatestPath, buf);
    camLastUpdate = Date.now();
    broadcast({ type: "cam", ts: camLastUpdate, payload: { last_update: camLastUpdate } });
    return true;
  } catch (err) {
    console.warn("[CAM] snapshot failed:", err.message);
    return false;
  }
}

function pipeCameraStream(req, res) {
  if (!CAM_STREAM_URL) {
    res.status(503).end();
    return;
  }

  const isHttps = CAM_STREAM_URL.startsWith("https://");
  const client = isHttps ? https : http;

  const upstream = client.get(CAM_STREAM_URL, (upRes) => {
    res.writeHead(upRes.statusCode || 200, {
      "Content-Type": upRes.headers["content-type"] || "multipart/x-mixed-replace",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    upRes.pipe(res);
  });

  upstream.on("error", () => {
    res.status(502).end();
  });
}

function normalizeAlertPayload(data) {
  const base = typeof data === "object" && data !== null ? { ...data } : { raw: data };
  const sourceType = base.type || base.raw || "ALERT";
  const upper = String(sourceType).toUpperCase();
  let mappedType = "system";
  if (upper.includes("FIRE")) mappedType = "fire";
  else if (upper.includes("REED") || upper.includes("DOOR") || upper.includes("LOCK") || upper.includes("UNLOCK")) mappedType = "door";
  else if (upper.includes("PIR") || upper.includes("MOTION") || upper.includes("ALARM") || upper.includes("CAM_CAPTURE") || upper.includes("PIR_DWELL") || upper.includes("FORCED")) mappedType = "intrusion";
  base.source_type = sourceType;
  base.type = mappedType;
  base.message = base.message || base.detail || String(sourceType);
  if (String(base.message).toUpperCase() === "ALERT") {
    base.message = "System alert";
  }
  base.detail = base.detail || "";
  return base;
}

async function handleAlertSideEffects(alertPayload) {
  const src = String(alertPayload.source_type || "").toUpperCase();
  if (src.includes("CAM_CAPTURE")) {
    await sendTelegramMessage("Camera capture requested");
    return;
  }

  if (src.includes("FIRE")) {
    await sendTelegramMessage("ALERT: Fire detected");
    await sendTelegramPhoto("Fire detected");
    return;
  }

  if (src.includes("ALARM") || src.includes("FORCED")) {
    await sendTelegramMessage("ALERT: Intrusion detected");
    return;
  }

  if (src.includes("TAMPER")) {
    await sendTelegramMessage("ALERT: Tamper detected");
    return;
  }

  if (src.includes("UNLOCK")) {
    await sendTelegramMessage("Door unlocked");
    return;
  }

  if (src.includes("PIR_DWELL")) {
    await sendTelegramMessage("ALERT: PIR motion > 20s");
  }
}

// MQTT event wiring. Only the real client emits these; the test stub is inert.
if (ENABLE_MQTT) {
  mqttClient.on("connect", () => {
    console.log(`[MQTT] Connected to ${MQTT_BROKER}`);
    mqttClient.subscribe([MQTT_TOPIC_STATE, MQTT_TOPIC_ALERT, MQTT_TOPIC_METRIC, MQTT_TOPIC_ACK, MQTT_TOPIC_CAM_META, MQTT_TOPIC_CAM_CHUNK], { qos: 1 });
  });

  mqttClient.on("reconnect", () => console.log("[MQTT] Reconnecting"));

  mqttClient.on("error", (err) => console.error("[MQTT] Error", err.message));
}

mqttClient.on("message", async (topic, payload) => {
  const ts = Date.now();
  const text = payload.toString();
  const parsed = JSON.parseSafe(text);

  const normalized = normalizeAlertPayload;

  if (topic === MQTT_TOPIC_STATE) {
    const statePayload = typeof parsed === "object" && parsed !== null
      ? { ...parsed, last_seen: ts }
      : { raw: parsed, last_seen: ts };

    db.data.state = { ts, payload: statePayload };
    await db.write();
    broadcast({ type: "state", ts, payload: statePayload });
    return;
  }

  if (topic === MQTT_TOPIC_METRIC) {
    const metricPayload = typeof parsed === "object" && parsed !== null
      ? { ...parsed, last_seen: ts }
      : { raw: parsed, last_seen: ts };

    db.data.events.unshift({ ts, topic, payload: metricPayload });
    db.data.events = db.data.events.slice(0, 500);
    await db.write();
    broadcast({ type: "metrics", topic, ts, payload: metricPayload });
    return;
  }

  if (topic === MQTT_TOPIC_ACK) {
    const ackPayload = typeof parsed === "object" && parsed !== null
      ? { ...parsed, last_seen: ts }
      : { raw: parsed, last_seen: ts };
    db.data.events.unshift({ ts, topic, payload: ackPayload });
    db.data.events = db.data.events.slice(0, 500);
    await db.write();
    broadcast({ type: "command_ack", topic, ts, payload: ackPayload });
    return;
  }

  if (topic === MQTT_TOPIC_ALERT) {
    const alertPayload = normalized(parsed);
    alertPayload.last_seen = ts;
    // Ignore generic "ALERT" noise to prevent spammy system alerts
    if (String(alertPayload.source_type || "").toUpperCase() === "ALERT") {
      return;
    }
    if (String(alertPayload.source_type || "").toUpperCase().includes("CAM_CAPTURE")) {
      handleAlertSideEffects(alertPayload);
      return;
    }
    db.data.events.unshift({ ts, topic, payload: alertPayload });
    db.data.events = db.data.events.slice(0, 500);
    await db.write();
    broadcast({ type: "alert", topic, ts, payload: alertPayload });
    handleAlertSideEffects(alertPayload);
    return;
  }

  if (topic === MQTT_TOPIC_CAM_META) {
    if (typeof parsed !== "object" || parsed === null) return;
    const seq = Number(parsed.seq);
    const len = Number(parsed.len);
    const chunk = Number(parsed.chunk || 2048);
    if (!Number.isFinite(seq) || !Number.isFinite(len)) return;

    const total = Math.max(1, Math.ceil(len / chunk));
    camChunks.set(seq, {
      seq,
      len,
      total,
      received: 0,
      chunks: new Map(),
      ts: Date.now(),
    });
    return;
  }

  if (topic === MQTT_TOPIC_CAM_CHUNK) {
    if (!Buffer.isBuffer(payload) || payload.length < 8) return;
    const seq = payload.readUInt32BE(0);
    const idx = payload.readUInt16BE(4);
    const total = payload.readUInt16BE(6);
    const data = payload.subarray(8);

    let state = camChunks.get(seq);
    if (!state) {
      state = {
        seq,
        len: 0,
        total,
        received: 0,
        chunks: new Map(),
        ts: Date.now(),
      };
      camChunks.set(seq, state);
    }

    if (!state.chunks.has(idx)) {
      state.chunks.set(idx, data);
      state.received += 1;
      state.ts = Date.now();
    }

    if (state.total && state.received >= state.total) {
      const buffers = [];
      for (let i = 0; i < state.total; i++) {
        buffers.push(state.chunks.get(i) || Buffer.alloc(0));
      }
      const image = Buffer.concat(buffers);
      fs.writeFileSync(camLatestPath, image);
      camLastUpdate = Date.now();
      broadcast({ type: "cam", ts: camLastUpdate, payload: { last_update: camLastUpdate } });

      const camEvent = {
        type: "camera",
        message: "Camera capture",
        detail: `seq ${seq}`,
        last_seen: camLastUpdate,
      };
      db.data.events.unshift({ ts: camLastUpdate, topic: "smartlock/cam", payload: camEvent });
      db.data.events = db.data.events.slice(0, 500);
      await db.write();
      broadcast({ type: "event", topic: "smartlock/cam", ts: camLastUpdate, payload: camEvent });

      sendTelegramPhoto("Camera capture");
      camChunks.delete(seq);
    }

    // Cleanup old entries
    const now = Date.now();
    for (const [key, value] of camChunks.entries()) {
      if (now - value.ts > CAM_CHUNK_TTL_MS) {
        camChunks.delete(key);
      }
    }
    return;
  }

  const eventPayload = typeof parsed === "object" && parsed !== null
    ? { ...parsed, last_seen: ts }
    : { raw: parsed, last_seen: ts };

  db.data.events.unshift({ ts, topic, payload: eventPayload });
  db.data.events = db.data.events.slice(0, 500); // cap history
  await db.write();
  broadcast({ type: "event", topic, ts, payload: eventPayload });
});

// Safe JSON parse helper
JSON.parseSafe = (str) => {
  try {
    return JSON.parse(str);
  } catch (e) {
    return str;
  }
};

// Credential retrieval. `Authorization: Bearer <token>` is canonical; the
// legacy `X-Access-Token` header is still accepted so existing clients keep
// working. Submitted values are never logged.
function extractBearerToken(req) {
  const auth = req.headers["authorization"];
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  const legacy = req.headers["x-access-token"];
  if (legacy) return String(legacy).trim();
  return null;
}

// Constant-time comparison. Both lengths are passed through SHA-256 first so
// the comparison cost does not leak the expected token's length.
function tokenMatches(expected, provided) {
  if (!provided) return false;
  const exp = Buffer.from(expected);
  const prov = Buffer.from(provided);
  const expLen = crypto.createHash("sha256").update(exp).digest();
  const provLen = crypto.createHash("sha256").update(prov).digest();
  const lengthOk = crypto.timingSafeEqual(expLen, provLen) && exp.length === prov.length;
  return lengthOk && crypto.timingSafeEqual(exp, prov);
}

// Dashboard/owner access token. Fail-closed: DASH_TOKEN is validated at
// startup (validateServerConfig), so this middleware never admits a request
// when it is unset. Missing, malformed, or incorrect credentials return 401.
function authenticateAccessToken(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    console.warn(`[AUTH] Missing access token from ${req.ip}`);
    return res.status(401).json({ error: "Access token required" });
  }
  if (!tokenMatches(DASH_TOKEN, token)) {
    console.warn(`[AUTH] Invalid access token from ${req.ip}`);
    return res.status(401).json({ error: "Invalid access token" });
  }
  next();
}

// Camera device credential for POST /api/cam/upload. Separate from the
// dashboard token so a dashboard credential cannot be used to upload frames.
// Fail-closed: an upload without a valid device token is rejected.
function authenticateCamUpload(req, res, next) {
  const token = extractCamToken(req);
  if (!token) {
    console.warn(`[AUTH] Missing camera upload token from ${req.ip}`);
    return res.status(401).json({ error: "Camera upload token required" });
  }
  if (!tokenMatches(CAM_UPLOAD_TOKEN, token)) {
    console.warn(`[AUTH] Invalid camera upload token from ${req.ip}`);
    return res.status(401).json({ error: "Invalid camera upload token" });
  }
  next();
}

// Camera devices send the device credential in x-cam-token; the Authorization
// Bearer header is also accepted so device and dashboard share one scheme.
function extractCamToken(req) {
  const auth = req.headers["authorization"];
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  const header = req.headers["x-cam-token"];
  if (header) return String(header).trim();
  return null;
}

// Public static assets: the dashboard UI itself. Runtime camera snapshots are
// deliberately NOT served from here — they live outside this directory and are
// only reachable through the authenticated /api/cam/latest route below.
// Mounted exactly once; the ordering is: security headers/CORS, body parsing,
// public static assets, rate limiting, API authentication, API routes.
// The removed public camera asset. The static root no longer contains a
// cam/ directory, so this path resolves to nothing: the snapshot must only
// ever leave through the authenticated /api/cam/latest route.
app.get("/cam/latest.jpg", (_req, res) => res.status(404).end());

// Rate limiting. Only the health probe bypasses the limiter; protected read
// paths (/api/state, /api/events, /api/cam/status, /api/stream) no longer do.
// The limiter is never disabled in production: DISABLE_RATE_LIMIT is honoured
// only in development and test, where tests need to exceed the window quota.
const RATE_LIMIT_SKIP = ["/api/health"];
const rateLimitDisabled = process.env.DISABLE_RATE_LIMIT === "1" &&
  (process.env.NODE_ENV === "development" || IS_TEST);
if (process.env.DISABLE_RATE_LIMIT === "1" && !rateLimitDisabled) {
  console.warn("[WARN] DISABLE_RATE_LIMIT=1 ignored outside development/test; the rate limiter stays enabled.");
}
if (!rateLimitDisabled) {
  const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "20"),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
    skip: (req) => RATE_LIMIT_SKIP.includes(req.path),
  });
  // Apply to all API routes
  app.use("/api", limiter);
}

// Every route below this point requires the dashboard access token except the
// health probe. Applying the middleware to the whole router means a route
// added later cannot be left unprotected by accident.
app.use("/api/", (req, res, next) => {
  if (req.path === "/health") return next();
  if (req.path === "/cam/upload") return authenticateCamUpload(req, res, next);
  return authenticateAccessToken(req, res, next);
});

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    mqtt: ENABLE_MQTT ? mqttClient.connected : false,
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

app.get("/api/state", (_req, res) => {
  if (!db.data.state) {
    return res.json({
      locked: true,
      alarm: false,
      door: "CLOSED",
      uptime: 0,
      rssi: -100,
      heap_free: 0
    });
  }
  res.json(db.data.state.payload);
});

app.get("/api/events", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
  res.json(db.data.events.slice(0, limit));
});

app.get("/api/cam/status", (_req, res) => {
  res.json({ last_update: camLastUpdate });
});

// The persisted snapshot. Served only through this authenticated route: the
// file lives outside the public static root, and the legacy /cam/latest.jpg
// path below is removed rather than redirected. Cached never.
app.get("/api/cam/latest", (req, res) => {
  // Path-traversal defence in depth: only a file already resolved below the
  // storage root is ever sent.
  const root = fs.realpathSync(camDir);
  let resolved;
  try {
    resolved = fs.realpathSync(camLatestPath);
  } catch (e) {
    return res.status(404).json({ error: "no camera image available" });
  }
  if (resolved !== path.join(root, "latest.jpg")) {
    return res.status(404).json({ error: "no camera image available" });
  }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "no-store, private");
  res.sendFile(resolved, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "no camera image available" });
  });
});

app.get("/api/cam/stream", (req, res) => {
  pipeCameraStream(req, res);
});

app.post("/api/cam/capture", async (_req, res) => {
  const ok = await fetchCameraSnapshot();
  if (!ok) return res.status(502).json({ error: "snapshot failed" });
  res.json({ ok: true, last_update: camLastUpdate });
});

// Device-to-server upload. Uses its own mandatory token (CAM_UPLOAD_TOKEN,
// or the legacy CAM_TOKEN name) so a dashboard token cannot upload frames.
app.post("/api/cam/upload", express.raw({ type: ["image/jpeg", "application/octet-stream"], limit: "3mb" }), (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: "empty image" });
  }

  fs.writeFileSync(camLatestPath, req.body);
  camLastUpdate = Date.now();

  broadcast({
    type: "cam",
    ts: camLastUpdate,
    payload: { last_update: camLastUpdate }
  });

  res.json({ ok: true });
});

app.post("/api/command", (req, res) => {
  const { command } = req.body;

  // Strict input validation
  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "command required (string)" });
  }
  if (command.length > 64) {
    return res.status(400).json({ error: "command too long" });
  }
  if (!["LOCK", "UNLOCK", "SILENCE", "ARM", "OTA", "MODE_HOME", "MODE_AWAY", "MODE_NIGHT", "START_PROVISIONING"].includes(command)) {
    return res.status(400).json({ error: "invalid command. Allowed: LOCK, UNLOCK, SILENCE, ARM, OTA, MODE_HOME, MODE_AWAY, MODE_NIGHT, START_PROVISIONING" });
  }

  // Add nonce and timestamp for replay protection
  const nonce = generateNonce();
  const timestamp = Math.floor(Date.now() / 1000);

  pruneOldNonces();
  if (usedNonces.has(nonce)) {
    return res.status(409).json({ error: "duplicate command (replay detected)" });
  }
  usedNonces.add(nonce);

  const signedCmd = `${command}|${nonce}|${timestamp}`;

  mqttClient.publish(MQTT_TOPIC_CMD, signedCmd, { qos: 1 }, (err) => {
    if (err) {
      console.error("[API] MQTT publish failed:", err);
      return res.status(500).json({ error: "mqtt publish failed" });
    }
    console.log(`[API] Command sent: ${command} (nonce: ${nonce})`);
    res.json({ sent: true, command, nonce, timestamp });
  });
});

// Server-sent events for live dashboard. Authenticated above by the shared
// /api/ middleware, so the stream is established only with a valid token.
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const client = { res };
  sseClients.add(client);
  req.on("close", () => sseClients.delete(client));
});

// Error handling: mounted last, after every route. Keeps the failure surface
// uniform so a thrown handler cannot leak a stack trace to a client.
app.use((err, _req, res, _next) => {
  console.error("[API] unhandled error:", err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "internal error" });
});

// The HTTP listener starts only when this module runs as the entrypoint, and
// only after startup configuration validation has passed. Imported by tests,
// it stays silent.
if (IS_ENTRYPOINT) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const client of sseClients) {
    client.res.write(data);
  }
}

// Accessors for the regression tests. `mqttPublished` records what the inert
// MQTT stub was asked to send, so a test can assert that an authorised
// request really reached the publish step. `closeTestRuntime` drops the
// timers the imported module still holds, letting the runner exit.
export function getMqttPublished() {
  return mqttPublished;
}

export function clearMqttPublished() {
  mqttPublished.length = 0;
}

export function closeTestRuntime() {
  if (typeof mqttClient.end === "function") mqttClient.end();
}

export { app };
