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

dotenv.config();

const PORT = process.env.PORT || 8080;
const MQTT_BROKER = process.env.MQTT_BROKER || "mqtt://localhost:1883";
const MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID || "smartlock-server";
const MQTT_USERNAME = process.env.MQTT_USERNAME || undefined;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || undefined;
const DB_PATH = process.env.DB_PATH || "./data.json";
const DASH_TOKEN = process.env.DASH_TOKEN;
const CAM_TOKEN = process.env.CAM_TOKEN || "";
const CAM_STREAM_URL = process.env.CAM_STREAM_URL || "";
const CAM_SNAPSHOT_URL = process.env.CAM_SNAPSHOT_URL || "";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

app.use(express.json());
app.use(morgan("dev"));

// Database setup (JSON file via lowdb)
const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, { state: null, events: [] });
await db.read();
db.data ||= { state: null, events: [] };
await db.write();

// MQTT client
const mqttOpts = {
  clientId: MQTT_CLIENT_ID,
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  keepalive: 30,
  reconnectPeriod: 2000,
};
const mqttClient = mqtt.connect(MQTT_BROKER, mqttOpts);

const MQTT_TOPIC_STATE = "smartlock/state";
const MQTT_TOPIC_ALERT = "smartlock/alert";
const MQTT_TOPIC_CMD = "smartlock/command";
const MQTT_TOPIC_METRIC = "smartlock/metric";
const MQTT_TOPIC_ACK = "smartlock/command_ack";

const sseClients = new Set();

const camDir = path.join(__dirname, "../public/cam");
const camLatestPath = path.join(camDir, "latest.jpg");
let camLastUpdate = 0;
fs.mkdirSync(camDir, { recursive: true });

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
  else if (upper.includes("REED") || upper.includes("DOOR")) mappedType = "door";
  else if (upper.includes("PIR") || upper.includes("MOTION") || upper.includes("ALARM") || upper.includes("CAM_CAPTURE")) mappedType = "intrusion";
  base.source_type = sourceType;
  base.type = mappedType;
  base.message = base.message || base.detail || String(sourceType);
  base.detail = base.detail || "";
  return base;
}

async function handleAlertSideEffects(alertPayload) {
  const src = String(alertPayload.source_type || "").toUpperCase();
  if (src.includes("CAM_CAPTURE")) {
    await fetchCameraSnapshot();
    await sendTelegramPhoto("Camera capture triggered by PIR dwell");
    return;
  }

  if (src.includes("FIRE")) {
    await fetchCameraSnapshot();
    await sendTelegramMessage("ALERT: Fire detected");
    await sendTelegramPhoto("Fire detected");
    return;
  }

  if (src.includes("ALARM") || src.includes("FORCED")) {
    await fetchCameraSnapshot();
    await sendTelegramMessage("ALERT: Intrusion detected");
    await sendTelegramPhoto("Intrusion detected");
    return;
  }

  if (src.includes("TAMPER")) {
    await sendTelegramMessage("ALERT: Tamper detected");
  }
}

mqttClient.on("connect", () => {
  console.log(`[MQTT] Connected to ${MQTT_BROKER}`);
  mqttClient.subscribe([MQTT_TOPIC_STATE, MQTT_TOPIC_ALERT, MQTT_TOPIC_METRIC, MQTT_TOPIC_ACK], { qos: 1 });
});

mqttClient.on("reconnect", () => console.log("[MQTT] Reconnecting"));

mqttClient.on("error", (err) => console.error("[MQTT] Error", err.message));

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
    db.data.events.unshift({ ts, topic, payload: alertPayload });
    db.data.events = db.data.events.slice(0, 500);
    await db.write();
    broadcast({ type: "alert", topic, ts, payload: alertPayload });
    handleAlertSideEffects(alertPayload);
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

// API Key authentication
const API_KEY = process.env.API_KEY;
const API_REQUIRED = API_KEY && API_KEY.length >= 32;

if (API_REQUIRED) {
  console.log("[AUTH] API key authentication enabled");
} else {
  console.warn("[WARN] No API_KEY set - authentication DISABLED (development only)");
}

function authenticateApiKey(req, res, next) {
  if (!API_REQUIRED) return next(); // Skip in dev mode
  
  const apiKey = req.headers["x-api-key"] || req.query.api_key;
  if (!apiKey) {
    return res.status(401).json({ error: "API key required" });
  }
  
  // Constant-time comparison to prevent timing attacks
  const expected = Buffer.from(API_KEY);
  const provided = Buffer.from(apiKey);
  if (expected.length !== provided.length || 
      !crypto.timingSafeEqual(expected, provided)) {
    console.warn(`[AUTH] Invalid API key attempt from ${req.ip}`);
    return res.status(403).json({ error: "Invalid API key" });
  }
  next();
}

// Access token authentication for control endpoints (dashboard)
function authenticateAccessToken(req, res, next) {
  if (!DASH_TOKEN) return next(); // Skip if not configured
  
  const token = req.headers["x-access-token"];
  if (!token) {
    return res.status(401).json({ error: "Access token required" });
  }
  
  // Constant-time comparison
  const expected = Buffer.from(DASH_TOKEN);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length || 
      !crypto.timingSafeEqual(expected, provided)) {
    console.warn(`[AUTH] Invalid access token attempt from ${req.ip}`);
    return res.status(401).json({ error: "Invalid access token" });
  }
  next();
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// Rate limiting (disabled for local dev to avoid dashboard polling issues)
if (process.env.DISABLE_RATE_LIMIT !== "1") {
  const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "20"),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
    // Health + high-frequency endpoints bypass
    skip: (req) =>
      req.path === "/api/health" ||
      req.path === "/api/state" ||
      req.path === "/api/cam/status" ||
      req.path === "/api/stream",
  });
  // Apply to all API routes
  app.use("/api", limiter);
}

app.get("/api/health", (_req, res) => {
  res.json({ 
    status: "ok", 
    mqtt: mqttClient.connected,
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

app.post("/api/pin", authenticateAccessToken, (req, res) => {
  const { pin } = req.body;
  if (!pin || typeof pin !== "string") {
    return res.status(400).json({ error: "pin required (string)" });
  }
  if (!/^[0-9]{4,10}$/.test(pin)) {
    return res.status(400).json({ error: "pin must be 4-10 digits" });
  }

  const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const timestamp = Math.floor(Date.now() / 1000);
  const signedCmd = `SET_PIN:${pin}|${nonce}|${timestamp}`;

  mqttClient.publish(MQTT_TOPIC_CMD, signedCmd, { qos: 1 }, (err) => {
    if (err) {
      console.error("[API] MQTT publish failed:", err);
      return res.status(500).json({ error: "mqtt publish failed" });
    }
    res.json({ sent: true });
  });
});

app.get("/api/cam/status", (_req, res) => {
  res.json({ last_update: camLastUpdate });
});

app.get("/api/cam/stream", (req, res) => {
  pipeCameraStream(req, res);
});

app.post("/api/cam/capture", async (_req, res) => {
  const ok = await fetchCameraSnapshot();
  if (!ok) return res.status(502).json({ error: "snapshot failed" });
  res.json({ ok: true, last_update: camLastUpdate });
});

app.post("/api/cam/upload", express.raw({ type: ["image/jpeg", "application/octet-stream"], limit: "3mb" }), (req, res) => {
  if (CAM_TOKEN && req.headers["x-cam-token"] !== CAM_TOKEN) {
    return res.status(401).json({ error: "invalid camera token" });
  }

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

app.post("/api/command", authenticateAccessToken, (req, res) => {
  const { command } = req.body;
  
  // Strict input validation
  if (!command || typeof command !== "string") {
    return res.status(400).json({ error: "command required (string)" });
  }
  if (command.length > 64) {
    return res.status(400).json({ error: "command too long" });
  }
  if (!["LOCK", "UNLOCK", "SILENCE", "ARM", "OTA", "MODE_HOME", "MODE_AWAY", "MODE_NIGHT"].includes(command)) {
    return res.status(400).json({ error: "invalid command. Allowed: LOCK, UNLOCK, SILENCE, ARM, OTA, MODE_HOME, MODE_AWAY, MODE_NIGHT" });
  }
  
  // Add nonce and timestamp for replay protection
  const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const timestamp = Math.floor(Date.now() / 1000);
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

// Server-sent events for live dashboard
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const client = { res };
  sseClients.add(client);
  req.on("close", () => sseClients.delete(client));
});

// Minimal static dashboard (placeholder)
app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const client of sseClients) {
    client.res.write(data);
  }
}
