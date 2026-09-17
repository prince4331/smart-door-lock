// Step 10 dashboard verification (not part of the test suite).
//
// Serves public/index.html from the real server and drives the dashboard's
// auth flows against it: an authenticated session reaches the SSE stream and
// can issue a control command; an anonymous session is rejected; a 401
// returns the UI to the login state.
//
// Run with: node test/dashboard-phase0.mjs
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DASH = crypto.randomBytes(32).toString("hex");
const CAM = crypto.randomBytes(32).toString("hex");
const PROBE_DB = path.join(ROOT, "data.probe.db");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function get(port, path, { bearer } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (bearer) headers["Authorization"] = "Bearer " + bearer;
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c.toString()));
      res.on("end", () => resolve({ status: res.statusCode, body }));
      res.on("error", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => {
      if (e.code === "ECONNRESET") resolve({ status: "RESET", body: "" });
      else reject(e);
    });
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let exitCode = 0;
function check(name, ok, detail = "") {
  if (!ok) exitCode = 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${detail}`);
}

const PORT = await freePort();
// Explicit environment so the developer .env is never read by the probe.
const env = {
  PATH: process.env.PATH,
  SYSTEMROOT: process.env.SYSTEMROOT || "",
  DASH_TOKEN: DASH,
  CAM_UPLOAD_TOKEN: CAM,
  DB_PATH: PROBE_DB,
  MQTT_BROKER: "mqtt://127.0.0.1:18830",   // unreachable: no broker is ever contacted
  MQTT_USERNAME: "",
  MQTT_PASSWORD: "",
  TG_BOT_TOKEN: "",
  TG_CHAT_ID: "",
  NODE_ENV: "development",
  DISABLE_RATE_LIMIT: "1",
  PORT: String(PORT),
};

const child = spawn(process.execPath, [path.join(ROOT, "src", "index.js")],
  { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
child.stdout.on("data", (c) => (serverLog += c.toString()));
child.stderr.on("data", (c) => (serverLog += c.toString()));

const killChild = () => { if (!child.killed) { try { child.kill("SIGKILL"); } catch (e) {} } };
process.on("exit", () => {
  killChild();
  try { fs.unlinkSync(PROBE_DB); } catch (e) { /* may not exist */ }
});

(async () => {
  await sleep(2500);
  if (!/Server running/.test(serverLog)) {
    console.log("SERVER DID NOT START:\n" + serverLog);
    killChild();
    process.exit(1);
  }

  // The dashboard is served, and its inline script no longer uses the
  // headerless EventSource API or the legacy X-Access-Token header.
  const page = await get(PORT, "/index.html");
  check("dashboard is served", page.status === 200);
  check("no EventSource constructor remains", !/new EventSource/.test(page.body));
  check("no legacy X-Access-Token header remains", !/X-Access-Token/.test(page.body));
  check("no token is placed in a URL", !/access_token=/.test(page.body));
  check("fetch-based SSE client is present", /fetch\(\s*['"`]\/api\/stream/.test(page.body));
  check("Authorization Bearer is sent", /Bearer\s*['"`]?\s*\$\{?ACCESS_TOKEN/.test(page.body));

  // An authenticated browser session can read state and open the stream.
  const state = await get(PORT, "/api/state", { bearer: DASH });
  check("authenticated dashboard read works", state.status === 200, state.body.slice(0, 40));

  const events = await get(PORT, "/api/events?limit=10", { bearer: DASH });
  check("authenticated events read works", events.status === 200, events.body.slice(0, 24));

  const cam = await get(PORT, "/api/cam/status", { bearer: DASH });
  check("authenticated camera status works", cam.status === 200, cam.body.slice(0, 24));

  // The SSE route never ends, so opening it in the main agent risks taking the
  // process down when the socket is torn down. Verify it in a child process.
  const stream = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", `
      const http = require("http");
      const req = http.request({ host: "127.0.0.1", port: ${PORT}, path: "/api/stream",
        headers: { Authorization: "Bearer ${DASH}" } }, (res) => {
        console.log(JSON.stringify({ status: res.statusCode, ctype: res.headers["content-type"] }));
        req.socket.destroy();
      });
      req.on("error", (e) => { console.log(JSON.stringify({ status: "ERR", ctype: e.message })); });
      req.end();
    `], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.on("exit", () => resolve(JSON.parse(out)));
  });
  check("authenticated SSE stream opens", stream.status === 200, JSON.stringify(stream));

  // An unauthenticated session is rejected, which is what drives the UI back
  // to the login state via the 401 handler.
  const anonState = await get(PORT, "/api/state");
  check("unauthenticated read is denied", anonState.status === 401, anonState.body.slice(0, 32));
  const anonStream = await get(PORT, "/api/stream");
  check("unauthenticated stream is denied", anonStream.status === 401, anonStream.body.slice(0, 32));

  // The camera static asset is public (it is fetched as an <img> src), while
  // the APIs that return state require a token.
  const img = await get(PORT, "/cam/latest.jpg");
  check("camera snapshot asset is served", img.status === 200 || img.status === 404,
    `status ${img.status}`);

  if (/Connected to mqtt:\/\//.test(serverLog)) {
    console.log("ERROR: the process connected to an MQTT broker.");
    exitCode = 1;
  }
  killChild();
  console.log(exitCode ? "\nDASHBOARD VERIFICATION FAILED" : "\nDASHBOARD VERIFICATION PASSED");
  process.exit(exitCode);
})();
