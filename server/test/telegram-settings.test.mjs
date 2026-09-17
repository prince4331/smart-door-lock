// Phase 3 Telegram settings tests.
//
// Imports the Express app directly. On import the module detects that it is
// not the entrypoint and uses an inert MQTT stub, so no broker connection is
// ever opened. Placeholder tokens are generated per run; no real credential
// is read from disk or printed.
//
// All runtime artifacts — the database, the camera snapshot directory and any
// generated .env for the startup tests — live in a per-run temporary
// directory removed on teardown, so a test never leaves the working tree
// dirty and never writes to a developer's real data.
//
// Run with: npm test
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

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "smartlock-test-"));
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

const imported = await import("../src/index.js");
const {
  app,
  validateConfig,
  validateServerConfig,
  getMqttPublished,
  clearMqttPublished,
  closeTestRuntime,
  db,
  sendTelegramMessage,
  sendTelegramPhoto,
} = imported;

const telegramSettings = await import("../src/telegram-settings.js");
const { TELEGRAM_KEY, DISABLED_KEY } = telegramSettings;

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

describe("SETTINGS_ENCRYPTION_KEY validation", () => {
  test("validateConfig rejects missing SETTINGS_ENCRYPTION_KEY", () => {
    const errors = validateConfig({
      dashToken: DASH_TOKEN,
      camUploadToken: CAM_UPLOAD_TOKEN,
      settingsEncryptionKey: "",
    });
    assert.ok(errors.some((e) => e.includes("SETTINGS_ENCRYPTION_KEY")));
  });

  test("validateConfig rejects invalid SETTINGS_ENCRYPTION_KEY", () => {
    const errors = validateConfig({
      dashToken: DASH_TOKEN,
      camUploadToken: CAM_UPLOAD_TOKEN,
      settingsEncryptionKey: "short",
    });
    assert.ok(errors.some((e) => e.includes("SETTINGS_ENCRYPTION_KEY")));
  });

  test("validateConfig accepts valid hex SETTINGS_ENCRYPTION_KEY", () => {
    const key = crypto.randomBytes(32).toString("hex");
    const errors = validateConfig({
      dashToken: DASH_TOKEN,
      camUploadToken: CAM_UPLOAD_TOKEN,
      settingsEncryptionKey: key,
    });
    assert.ok(!errors.some((e) => e.includes("SETTINGS_ENCRYPTION_KEY")));
  });
});

describe("telegram settings API unauthenticated", () => {
  test("GET /api/settings/telegram rejects anonymous", async () => {
    const res = await request("/api/settings/telegram");
    assert.equal(res.status, 401);
  });

  test("PUT /api/settings/telegram rejects anonymous", async () => {
    const res = await request("/api/settings/telegram", {
      method: "PUT",
      ctype: "application/json",
      body: JSON.stringify({ bot_token: "123:abc", chat_id: "123" }),
    });
    assert.equal(res.status, 401);
  });

  test("DELETE /api/settings/telegram rejects anonymous", async () => {
    const res = await request("/api/settings/telegram", { method: "DELETE" });
    assert.equal(res.status, 401);
  });

  test("POST /api/settings/telegram/test rejects anonymous", async () => {
    const res = await request("/api/settings/telegram/test", { method: "POST" });
    assert.equal(res.status, 401);
  });
});

describe("telegram settings PUT validation", () => {
  test("invalid bot_token returns 400", async () => {
    const res = await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: "short", chat_id: "123" }),
    });
    assert.equal(res.status, 400);
  });

  test("invalid chat_id returns 400", async () => {
    const res = await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: "123456789:ABCDEFghijklmnop", chat_id: "" }),
    });
    assert.equal(res.status, 400);
  });
});

describe("telegram settings roundtrip", () => {
  test("valid PUT stores encrypted settings and GET returns masked token", async () => {
    const botToken = crypto.randomBytes(16).toString("hex") + ":TEST";
    const chatId = "-1001234567890";

    const putRes = await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: botToken, chat_id: chatId }),
    });
    assert.equal(putRes.status, 200);
    const putData = JSON.parse(putRes.body);
    assert.equal(putData.configured, true);
    assert.equal(putData.source, "dashboard");
    assert.ok(putData.bot_token_masked.includes("••"));
    assert.equal(putData.chat_id, chatId);

    const getRes = await request("/api/settings/telegram", {
      headers: authHeaders(),
    });
    assert.equal(getRes.status, 200);
    const getData = JSON.parse(getRes.body);
    assert.equal(getData.configured, true);
    assert.equal(getData.source, "dashboard");
    assert.ok(getData.bot_token_masked.includes("••"));
    assert.equal(getData.chat_id, chatId);
  });

  test("database does not contain raw bot token", async () => {
    const botToken = "secret-bot-token:" + crypto.randomBytes(8).toString("hex");
    const chatId = "123456";

    await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: botToken, chat_id: chatId }),
    });

    const rawDb = fs.readFileSync(DB_PATH, "utf8");
    assert.ok(!rawDb.includes(botToken), "raw bot token must not appear in data.db");
  });

  test("DELETE disables Telegram and prevents fallback to env", async () => {
    const delRes = await request("/api/settings/telegram", {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(delRes.status, 200);

    const getRes = await request("/api/settings/telegram", {
      headers: authHeaders(),
    });
    assert.equal(getRes.status, 200);
    const data = JSON.parse(getRes.body);
    assert.equal(data.configured, false);
    assert.equal(data.disabled, true);
  });

  test("PUT after DELETE reenables Telegram", async () => {
    const botToken = "new-bot-token:" + crypto.randomBytes(8).toString("hex");
    const chatId = "789012";

    const putRes = await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: botToken, chat_id: chatId }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await request("/api/settings/telegram", {
      headers: authHeaders(),
    });
    const data = JSON.parse(getRes.body);
    assert.equal(data.configured, true);
    assert.equal(data.source, "dashboard");
  });
});

describe("legacy environment fallback", () => {
  test("no dashboard config and env vars present returns source none", async () => {
    db.data.settings = {};
    await db.write();

    const getRes = await request("/api/settings/telegram", {
      headers: authHeaders(),
    });
    assert.equal(getRes.status, 200);
    const data = JSON.parse(getRes.body);
    assert.equal(data.source, "none");
  });
});

describe("telegram settings test endpoint", () => {
  test("test endpoint with mocked successful Telegram response", async () => {
    const botToken = "test-bot-token:" + crypto.randomBytes(8).toString("hex");
    const chatId = "123456";

    await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: botToken, chat_id: chatId }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    });

    try {
      const res = await request("/api/settings/telegram/test", {
        method: "POST",
        headers: authHeaders(),
      });
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.ok, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("test endpoint with Telegram API rejection returns sanitized error", async () => {
    const botToken = "test-bot-token:" + crypto.randomBytes(8).toString("hex");
    const chatId = "123456";

    await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: botToken, chat_id: chatId }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: false, description: "Bad token" }),
    });

    try {
      const res = await request("/api/settings/telegram/test", {
        method: "POST",
        headers: authHeaders(),
      });
      assert.equal(res.status, 400);
      const data = JSON.parse(res.body);
      assert.equal(data.ok, false);
      assert.ok(data.error.includes("Telegram rejected"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("runtime Telegram senders", () => {
  test("dashboard-configured message delivery uses decrypted dashboard token", async () => {
    const botToken = "runtime-bot-token:" + crypto.randomBytes(8).toString("hex");
    const chatId = "-1009999999999";

    await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: botToken, chat_id: chatId }),
    });

    let capturedUrl = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      const { sendTelegramMessage } = await import("../src/index.js");
      await sendTelegramMessage("test message");
      assert.ok(capturedUrl.includes(botToken), "fetch must use the dashboard bot token");
      assert.ok(capturedUrl.includes("/sendMessage"), "must call sendMessage");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("disabled Telegram prevents message delivery", async () => {
    db.data.settings = {};
    db.data.settings[DISABLED_KEY] = true;
    await db.write();

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      await sendTelegramMessage("test message");
      assert.equal(fetchCalled, false, "fetch must not be called when disabled");
    } finally {
      globalThis.fetch = originalFetch;
      db.data.settings = {};
      await db.write();
    }
  });

  test("disabled Telegram prevents photo delivery", async () => {
    db.data.settings = {};
    db.data.settings[DISABLED_KEY] = true;
    await db.write();

    fs.writeFileSync(path.join(CAM_DIR, "latest.jpg"), "fake-jpeg");

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      await sendTelegramPhoto("camera capture");
      assert.equal(fetchCalled, false, "fetch must not be called when disabled");
    } finally {
      globalThis.fetch = originalFetch;
      db.data.settings = {};
      await db.write();
    }
  });

  test("legacy environment fallback works when no dashboard config exists", async () => {
    db.data.settings = {};
    await db.write();

    process.env.TG_BOT_TOKEN = "legacy-bot-token:" + crypto.randomBytes(8).toString("hex");
    process.env.TG_CHAT_ID = "123456";

    let capturedUrl = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      await sendTelegramMessage("legacy test");
      assert.ok(capturedUrl.includes(process.env.TG_BOT_TOKEN), "must use legacy token");
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TG_BOT_TOKEN;
      delete process.env.TG_CHAT_ID;
    }
  });

  test("corrupted dashboard config does not fall back to legacy env", async () => {
    const legacyToken = "legacy-bot-token:" + crypto.randomBytes(8).toString("hex");
    process.env.TG_BOT_TOKEN = legacyToken;
    process.env.TG_CHAT_ID = "123456";

    db.data.settings = {
      [TELEGRAM_KEY]: {
        version: 1,
        algorithm: "aes-256-gcm",
        iv: crypto.randomBytes(12).toString("base64"),
        ciphertext: "corrupted ciphertext",
        auth_tag: crypto.randomBytes(16).toString("base64"),
        updated_at: Date.now(),
      },
    };
    await db.write();

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    try {
      await sendTelegramMessage("should not send");
      assert.equal(fetchCalled, false, "must not call fetch with corrupted dashboard config");
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TG_BOT_TOKEN;
      delete process.env.TG_CHAT_ID;
      db.data.settings = {};
      await db.write();
    }
  });

  test("Telegram API rejection does not throw into caller", async () => {
    const botToken = "reject-bot-token:" + crypto.randomBytes(8).toString("hex");
    const chatId = "123456";

    await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: botToken, chat_id: chatId }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: false, description: "Forbidden" }),
    });

    try {
      await sendTelegramMessage("rejection test");
      assert.ok(true, "sender must not throw on Telegram rejection");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("network failure does not throw into caller", async () => {
    const botToken = "network-fail-bot-token:" + crypto.randomBytes(8).toString("hex");
    const chatId = "123456";

    await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: botToken, chat_id: chatId }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    try {
      await sendTelegramMessage("network failure test");
      assert.ok(true, "sender must not throw on network failure");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("corrupted dashboard PUT behavior", () => {
  test("PUT with blank token on corrupted dashboard config returns 409", async () => {
    db.data.settings = {
      [TELEGRAM_KEY]: {
        version: 1,
        algorithm: "aes-256-gcm",
        iv: crypto.randomBytes(12).toString("base64"),
        ciphertext: "corrupted ciphertext",
        auth_tag: crypto.randomBytes(16).toString("base64"),
        updated_at: Date.now(),
      },
    };
    await db.write();

    const res = await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ chat_id: "123456" }),
    });
    assert.equal(res.status, 409);
    const data = JSON.parse(res.body);
    assert.ok(data.error.includes("unreadable"), "must indicate corruption");
  });

  test("PUT with explicit new token replaces corrupted dashboard config", async () => {
    const newToken = "replacement-bot-token:" + crypto.randomBytes(8).toString("hex");
    const newChatId = "789012";

    const res = await request("/api/settings/telegram", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ bot_token: newToken, chat_id: newChatId }),
    });
    assert.equal(res.status, 200);

    const getRes = await request("/api/settings/telegram", {
      headers: authHeaders(),
    });
    const data = JSON.parse(getRes.body);
    assert.equal(data.configured, true);
    assert.equal(data.source, "dashboard");
    assert.equal(data.chat_id, newChatId);
  });
});
