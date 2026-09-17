// Phase 0 security regression tests.
//
// Imports the Express app directly. On import the module detects that it is
// not the entrypoint and uses an inert MQTT stub, so no broker connection is
// ever opened. Placeholder tokens are generated per run; no real credential
// is read from disk or printed.
//
// Run with: npm test
import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const DASH_TOKEN = crypto.randomBytes(32).toString("hex");
const CAM_UPLOAD_TOKEN = crypto.randomBytes(32).toString("hex");
const API_KEY = crypto.randomBytes(48).toString("hex");

const DB_PATH = path.join(import.meta.dirname, "..", "data.test.db");

const env = {
  ...process.env,
  NODE_ENV: "test",
  DASH_TOKEN,
  CAM_UPLOAD_TOKEN,
  API_KEY,
  DB_PATH,
  MQTT_BROKER: "mqtt://127.0.0.1:18830",   // nothing is listening; never contacted
  MQTT_USERNAME: "",
  MQTT_PASSWORD: "",
  TG_BOT_TOKEN: "",
  TG_CHAT_ID: "",
  DISABLE_RATE_LIMIT: "1",
  PORT: "0",
};

// Placeholder credentials are injected before the app module is imported, so
// no real secret from the developer environment can reach the code under test.
Object.assign(process.env, env);
delete process.env.CAM_TOKEN;

const { app, validateServerConfig, validateConfig, getMqttPublished, clearMqttPublished, closeTestRuntime } =
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

function request(target, { method = "GET", bearer, camToken, legacyToken, body, ctype } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(target, baseUrl);
    const headers = {};
    if (bearer) headers["Authorization"] = "Bearer " + bearer;
    if (camToken) headers["x-cam-token"] = camToken;
    if (legacyToken) headers["X-Access-Token"] = legacyToken;
    if (ctype) headers["Content-Type"] = ctype;
    const req = http.request(url, { method, headers }, (res) => {
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

before(async () => {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  await listen();
});

afterEach(() => clearMqttPublished());

// Close the listening socket and release the module's handles so the runner
// exits cleanly instead of hanging on a live server.
after(() => {
  closeTestRuntime();
  if (server) server.close();
});

describe("startup configuration validation", () => {
  test("validateConfig accepts valid, non-empty tokens", () => {
    assert.deepEqual(validateConfig({ dashToken: DASH_TOKEN, camUploadToken: CAM_UPLOAD_TOKEN }), []);
  });

  test("validateConfig rejects a missing DASH_TOKEN", () => {
    const errors = validateConfig({ dashToken: "", camUploadToken: CAM_UPLOAD_TOKEN });
    assert.ok(errors.some((e) => e.includes("DASH_TOKEN")), "missing DASH_TOKEN must be reported");
  });

  test("validateConfig rejects a whitespace-only DASH_TOKEN", () => {
    const errors = validateConfig({ dashToken: "   ", camUploadToken: CAM_UPLOAD_TOKEN });
    assert.notDeepEqual(errors, []);
    assert.ok(errors.some((e) => e.includes("DASH_TOKEN")));
  });

  test("validateConfig rejects a missing CAM_UPLOAD_TOKEN", () => {
    const errors = validateConfig({ dashToken: DASH_TOKEN, camUploadToken: "" });
    assert.ok(errors.some((e) => e.includes("CAM_UPLOAD_TOKEN")), "missing CAM_UPLOAD_TOKEN must be reported");
  });

  test("validateConfig rejects a plain-http camera snapshot URL", () => {
    const errors = validateConfig({
      dashToken: DASH_TOKEN, camUploadToken: CAM_UPLOAD_TOKEN,
      camSnapshotUrl: "http://camera.local/snap",
    });
    assert.ok(errors.some((e) => e.includes("CAM_SNAPSHOT_URL")));
  });

  test("validateConfig rejects a plain-http camera stream URL", () => {
    const errors = validateConfig({
      dashToken: DASH_TOKEN, camUploadToken: CAM_UPLOAD_TOKEN,
      camStreamUrl: "http://camera.local/stream",
    });
    assert.ok(errors.some((e) => e.includes("CAM_STREAM_URL")));
  });

  test("validateConfig accepts an unset camera URL", () => {
    assert.deepEqual(validateConfig({
      dashToken: DASH_TOKEN, camUploadToken: CAM_UPLOAD_TOKEN,
      camSnapshotUrl: undefined, camStreamUrl: undefined,
    }), []);
  });

  test("validateServerConfig reports no errors with the active test environment", () => {
    assert.deepEqual(validateServerConfig(), []);
  });
});

describe("public routes", () => {
  test("health probe is reachable without a token", async () => {
    const res = await request("/api/health");
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.status, "ok");
  });

  test("dashboard static assets are served without a token", async () => {
    const res = await request("/index.html");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("<!DOCTYPE html>"));
  });
});

describe("read endpoints require a token (SEC-04)", () => {
  for (const route of ["/api/state", "/api/events", "/api/cam/status"]) {
    test(`${route} rejects an anonymous request with 401`, async () => {
      const res = await request(route);
      assert.equal(res.status, 401);
    });
  }

  test("/api/stream rejects an anonymous request with 401", async () => {
    const res = await request("/api/stream");
    assert.equal(res.status, 401);
  });
});

describe("invalid credentials return 401, never 403 (SEC-03)", () => {
  for (const route of ["/api/state", "/api/events", "/api/cam/status", "/api/stream"]) {
    test(`${route} returns 401 for a wrong token`, async () => {
      const res = await request(route, { bearer: "not-the-right-token" });
      assert.equal(res.status, 401);
    });
  }

  test("a malformed Authorization header returns 401", async () => {
    const res = await request("/api/state");
    assert.equal(res.status, 401);
  });

  test("a wrong token type is rejected", async () => {
    const res = await request("/api/state", { bearer: "Basic " + DASH_TOKEN });
    assert.equal(res.status, 401);
  });

  test("an empty Bearer value is rejected", async () => {
    const res = await request("/api/state", { bearer: "" });
    assert.equal(res.status, 401);
  });
});

describe("control endpoints require a token (SEC-03)", () => {
  test("POST /api/command rejects an anonymous request", async () => {
    const res = await request("/api/command", {
      method: "POST", ctype: "application/json", body: JSON.stringify({ command: "LOCK" }),
    });
    assert.equal(res.status, 401);
  });

  test("POST /api/pin rejects an anonymous request", async () => {
    const res = await request("/api/pin", {
      method: "POST", ctype: "application/json", body: JSON.stringify({ pin: "1234" }),
    });
    assert.equal(res.status, 401);
  });
});

describe("camera upload uses a separate, mandatory device token", () => {
  test("an anonymous upload is rejected", async () => {
    const res = await request("/api/cam/upload", {
      method: "POST", ctype: "image/jpeg", body: "jpeg-bytes",
    });
    assert.equal(res.status, 401);
  });

  test("the dashboard token cannot upload", async () => {
    const res = await request("/api/cam/upload", {
      method: "POST", bearer: DASH_TOKEN, ctype: "image/jpeg", body: "jpeg-bytes",
    });
    assert.equal(res.status, 401);
  });

  test("the legacy x-cam-token device credential is accepted", async () => {
    const res = await request("/api/cam/upload", {
      method: "POST", camToken: CAM_UPLOAD_TOKEN, ctype: "image/jpeg", body: "jpeg-bytes",
    });
    assert.equal(res.status, 200);
  });

  test("the device credential is accepted as a Bearer token", async () => {
    const res = await request("/api/cam/upload", {
      method: "POST", bearer: CAM_UPLOAD_TOKEN, ctype: "image/jpeg", body: "jpeg-bytes",
    });
    assert.equal(res.status, 200);
  });
});

describe("authorised requests succeed", () => {
  test("Bearer token is accepted on a read endpoint", async () => {
    const res = await request("/api/state", { bearer: DASH_TOKEN });
    assert.equal(res.status, 200);
  });

  test("legacy X-Access-Token header is accepted", async () => {
    const res = await request("/api/state", { legacyToken: DASH_TOKEN });
    assert.equal(res.status, 200);
  });

  test("events are returned for an authorised request", async () => {
    const res = await request("/api/events?limit=10", { bearer: DASH_TOKEN });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(JSON.parse(res.body)));
  });

  test("a valid command publishes to the command topic", async () => {
    const res = await request("/api/command", {
      method: "POST", bearer: DASH_TOKEN, ctype: "application/json",
      body: JSON.stringify({ command: "LOCK" }),
    });
    assert.equal(res.status, 200);
    const published = getMqttPublished();
    assert.equal(published.length, 1);
    assert.match(published[0].payload, /^LOCK\|/);
  });

  test("a valid PIN publishes a SET_PIN command", async () => {
    const res = await request("/api/pin", {
      method: "POST", bearer: DASH_TOKEN, ctype: "application/json",
      body: JSON.stringify({ pin: "123456" }),
    });
    assert.equal(res.status, 200);
    const published = getMqttPublished();
    assert.equal(published.length, 1);
    assert.match(published[0].payload, /^SET_PIN:123456\|/);
  });
});

describe("command validation still applies after a valid token", () => {
  test("an unknown command is rejected with 400", async () => {
    const res = await request("/api/command", {
      method: "POST", bearer: DASH_TOKEN, ctype: "application/json",
      body: JSON.stringify({ command: "DELETE" }),
    });
    assert.equal(res.status, 400);
  });

  test("a malformed PIN is rejected with 400", async () => {
    const res = await request("/api/pin", {
      method: "POST", bearer: DASH_TOKEN, ctype: "application/json",
      body: JSON.stringify({ pin: "12" }),
    });
    assert.equal(res.status, 400);
  });
});

describe("SSE stream is authenticated on connect", () => {
  test("an authorised connection receives streamed frames", async () => {
    const url = new URL("/api/stream", baseUrl);
    const res = await new Promise((resolve, reject) => {
      const req = http.request(url, { headers: { Authorization: "Bearer " + DASH_TOKEN } }, (r) => {
        let data = "";
        r.on("data", (c) => (data += c));
        setTimeout(() => {
          r.destroy();
          req.socket.destroy();
          resolve({ status: r.statusCode, body: data });
        }, 250);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(res.status, 200);
  });
});
