import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const DASH_TOKEN = crypto.randomBytes(32).toString("hex");
const CAM_UPLOAD_TOKEN = crypto.randomBytes(32).toString("hex");
const ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "smartlock-presence-test-"));
const DB_PATH = path.join(SCRATCH, "data.test.db");
const CAM_DIR = path.join(SCRATCH, "cam");

const env = {
  PATH: process.env.PATH,
  SYSTEMROOT: process.env.SYSTEMROOT || "",
  NODE_ENV: "test",
  DASH_TOKEN,
  CAM_UPLOAD_TOKEN,
  DB_PATH,
  CAM_STORAGE_DIR: CAM_DIR,
  MQTT_BROKER: "mqtt://127.0.0.1:18830",
  MQTT_USERNAME: "",
  MQTT_PASSWORD: "",
  SETTINGS_ENCRYPTION_KEY: ENCRYPTION_KEY,
  DISABLE_RATE_LIMIT: "1",
  PORT: "0",
};

const savedEnv = { ...process.env };
Object.assign(process.env, env);
delete process.env.CAM_TOKEN;
delete process.env.API_KEY;
delete process.env.DOTENV_CONFIG_PATH;

const { app, db, getMqttPublished, clearMqttPublished, closeTestRuntime } =
  await import("../src/index.js");

let server = null;
let baseUrl = null;

function listen() {
  return new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

function request(target, { method = "GET", bearer, body, ctype, headers } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target, baseUrl);
    const reqHeaders = Object.assign({}, headers || {});
    if (bearer) reqHeaders["Authorization"] = `Bearer ${bearer}`;
    if (ctype) reqHeaders["Content-Type"] = ctype;
    const req = http.request(url, { method, headers: reqHeaders }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        req.socket.destroy();
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  if (DASH_TOKEN) headers["Authorization"] = `Bearer ${DASH_TOKEN}`;
  return headers;
}

before(async () => {
  await listen();
});

afterEach(() => clearMqttPublished());

after(() => {
  closeTestRuntime();
  if (server) server.close();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

describe("presence settings API authentication", () => {
  test("GET /api/settings/presence rejects anonymous request with 401", async () => {
    const res = await request("/api/settings/presence");
    assert.equal(res.status, 401);
  });

  test("PUT /api/settings/presence rejects anonymous request with 401", async () => {
    const res = await request("/api/settings/presence", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold_seconds: 60 }),
    });
    assert.equal(res.status, 401);
  });
});

describe("presence settings GET default and roundtrip", () => {
  test("GET /api/settings/presence returns default 30s threshold and 300s cooldown", async () => {
    db.data.settings = {};
    await db.write();

    const res = await request("/api/settings/presence", {
      headers: authHeaders(),
    });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.threshold_seconds, 30);
    assert.equal(data.cooldown_seconds, 300);
  });

  test("PUT /api/settings/presence with 60 updates settings and publishes SET_PRESENCE_60", async () => {
    const res = await request("/api/settings/presence", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ threshold_seconds: 60 }),
    });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.threshold_seconds, 60);
    assert.equal(data.command, "SET_PRESENCE_60");
    assert.ok(data.nonce);
    assert.ok(data.timestamp);

    const published = getMqttPublished();
    const cmdMsg = published.find((p) => p.topic === "smartlock/command");
    assert.ok(cmdMsg, "Must publish to smartlock/command");
    assert.match(cmdMsg.payload, /^SET_PRESENCE_60\|\d+\|\d+$/);

    const getRes = await request("/api/settings/presence", {
      headers: authHeaders(),
    });
    assert.equal(getRes.status, 200);
    const getData = JSON.parse(getRes.body);
    assert.equal(getData.threshold_seconds, 60);
    assert.equal(getData.cooldown_seconds, 300);
    assert.ok(getData.updated_at);
  });

  test("PUT /api/settings/presence with 30 updates settings and publishes SET_PRESENCE_30", async () => {
    const res = await request("/api/settings/presence", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ threshold_seconds: 30 }),
    });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
    assert.equal(data.threshold_seconds, 30);
    assert.equal(data.command, "SET_PRESENCE_30");

    const published = getMqttPublished();
    const cmdMsg = published.find((p) => p.topic === "smartlock/command");
    assert.ok(cmdMsg);
    assert.match(cmdMsg.payload, /^SET_PRESENCE_30\|\d+\|\d+$/);
  });
});

describe("presence settings validation", () => {
  test("PUT /api/settings/presence rejects non-allowlisted thresholds with 400", async () => {
    for (const invalid of [0, 15, 45, 90, 120, -30, "30", null, undefined]) {
      const res = await request("/api/settings/presence", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ threshold_seconds: invalid }),
      });
      assert.equal(res.status, 400, `Threshold ${invalid} must be rejected with 400`);
      const data = JSON.parse(res.body);
      assert.ok(data.error.includes("30 or 60"));
    }
  });
});

describe("command allowlist includes presence commands", () => {
  test("POST /api/command accepts SET_PRESENCE_30 and publishes secure command", async () => {
    const res = await request("/api/command", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ command: "SET_PRESENCE_30" }),
    });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.sent, true);
    assert.equal(data.command, "SET_PRESENCE_30");
    assert.ok(data.nonce);
    assert.ok(data.timestamp);

    const published = getMqttPublished();
    const cmdMsg = published.find((p) => p.topic === "smartlock/command");
    assert.ok(cmdMsg);
    assert.match(cmdMsg.payload, /^SET_PRESENCE_30\|\d+\|\d+$/);
  });

  test("POST /api/command accepts SET_PRESENCE_60 and publishes secure command", async () => {
    const res = await request("/api/command", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ command: "SET_PRESENCE_60" }),
    });
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.sent, true);
    assert.equal(data.command, "SET_PRESENCE_60");
    assert.ok(data.nonce);
    assert.ok(data.timestamp);
  });
});
