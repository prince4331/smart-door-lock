// Ad-hoc verification probe (not part of the test suite). Boots the real
// entrypoint with placeholder tokens and asserts the authentication behaviour
// of every route. Points at an unreachable loopback broker address so that no
// real broker is ever contacted: publish callbacks never fire, so the control
// endpoints that depend on them are expected to hang and are not asserted.
// All runtime artifacts land in a per-run temporary directory, so the probe
// never writes into the working tree.
// Run with: node test/probe-phase0.mjs
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DASH = crypto.randomBytes(32).toString("hex");
const CAM = crypto.randomBytes(32).toString("hex");

// Per-run scratch directory: database, camera storage and any generated env
// file all live here and are removed wholesale on exit.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "smartlock-probe-"));
const PROBE_DB = path.join(SCRATCH, "data.probe.db");
const PROBE_CAM = path.join(SCRATCH, "cam");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function req(port, path, { method = "GET", bearer, camToken, legacyToken, body, ctype, timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (bearer) headers["Authorization"] = "Bearer " + bearer;
    if (camToken) headers["x-cam-token"] = camToken;
    if (legacyToken) headers["X-Access-Token"] = legacyToken;
    if (ctype) headers["Content-Type"] = ctype;
    const r = http.request({ host: "127.0.0.1", port, path, method, headers, timeout }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d.slice(0, 60) }));
    });
    r.on("timeout", () => { r.destroy(); resolve({ status: "TIMEOUT", body: "" }); });
    r.on("error", (e) => resolve({ status: "ERR", body: e.message }));
    r.end(body);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let exitCode = 0;
function check(name, expected, got) {
  const ok = got.status === expected;
  if (!ok) exitCode = 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(30)} expected ${expected} got ${got.status}  ${got.body.replace(/\n/g, " ")}`);
}

const PORT = await freePort();
// An explicit environment: the real developer .env must never be read by the
// probe process, so only what is listed here is visible to the server.
const env = {
  PATH: process.env.PATH,
  SYSTEMROOT: process.env.SYSTEMROOT || "",
  DASH_TOKEN: DASH,
  CAM_UPLOAD_TOKEN: CAM,
  DB_PATH: PROBE_DB,
  CAM_STORAGE_DIR: PROBE_CAM,
  // Nothing is listening on this loopback address, so the client cannot
  // connect to any broker — production infrastructure is never contacted.
  MQTT_BROKER: "mqtt://127.0.0.1:18830",
  MQTT_USERNAME: "",
  MQTT_PASSWORD: "",
  TG_BOT_TOKEN: "",
  TG_CHAT_ID: "",
  NODE_ENV: "development",
  DISABLE_RATE_LIMIT: "1",
  PORT: String(PORT),
};

const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "src", "index.js")],
  { cwd: path.join(import.meta.dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
child.stdout.on("data", (c) => (serverLog += c.toString()));
child.stderr.on("data", (c) => (serverLog += c.toString()));

function killChild() {
  if (!child.killed) {
    try { child.kill("SIGKILL"); } catch (e) { /* already gone */ }
  }
}
process.on("exit", () => {
  killChild();
  // The whole scratch directory goes away, so no probe artifact can outlive
  // the run and pollute the working tree.
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});
process.on("SIGINT", () => { killChild(); process.exit(130); });

(async () => {
  await sleep(2500);
  if (!/Server running/.test(serverLog)) {
    console.log("SERVER DID NOT START. Log:\n" + serverLog);
    killChild();
    process.exit(1);
  }
  const B = (t) => ({ bearer: t });
  const P = (path, opts) => req(PORT, path, opts);

  console.log("\n== Public ==");
  await check("GET /api/health anonymous", 200, await P("/api/health"));
  await check("GET /index.html static", 200, await P("/index.html"));

  console.log("\n== Fail-closed read paths ==");
  await check("GET /api/state anonymous", 401, await P("/api/state"));
  await check("GET /api/state wrong token", 401, await P("/api/state", B("wrong")));
  await check("GET /api/events anonymous", 401, await P("/api/events"));
  await check("GET /api/cam/status anonymous", 401, await P("/api/cam/status"));
  await check("GET /api/stream anonymous", 401, await P("/api/stream", { timeout: 1500 }));

  console.log("\n== Bearer + legacy header accepted ==");
  await check("GET /api/state Bearer", 200, await P("/api/state", B(DASH)));
  await check("GET /api/state X-Access-Token", 200, await P("/api/state", { legacyToken: DASH }));
  await check("GET /api/events Bearer", 200, await P("/api/events?limit=5", B(DASH)));
  await check("GET /api/cam/status Bearer", 200, await P("/api/cam/status", B(DASH)));

  console.log("\n== Control endpoints reach the publish step ==");
  // These publish over MQTT, whose callback never fires without a broker, so
  // they time out. The assertion is that the request was authorised and
  // reached the handler, which a TIMEOUT demonstrates.
  await check("POST /api/command Bearer (authorised, no broker)", "TIMEOUT", await P("/api/command", { ...B(DASH), method: "POST", body: '{"command":"LOCK"}', ctype: "application/json" }));
  await check("POST /api/pin Bearer (authorised, no broker)", "TIMEOUT", await P("/api/pin", { ...B(DASH), method: "POST", body: '{"pin":"1234"}', ctype: "application/json" }));
  await check("POST /api/command anonymous", 401, await P("/api/command", { method: "POST", body: '{"command":"LOCK"}', ctype: "application/json" }));
  await check("POST /api/command invalid command", 400, await P("/api/command", { ...B(DASH), method: "POST", body: '{"command":"DELETE"}', ctype: "application/json" }));
  await check("POST /api/pin malformed pin", 400, await P("/api/pin", { ...B(DASH), method: "POST", body: '{"pin":"12"}', ctype: "application/json" }));

  console.log("\n== Camera upload: separate, mandatory device token ==");
  await check("POST /api/cam/upload anonymous", 401, await P("/api/cam/upload", { method: "POST", body: "abc", ctype: "image/jpeg" }));
  await check("POST /api/cam/upload dashboard token", 401, await P("/api/cam/upload", { ...B(DASH), method: "POST", body: "abc", ctype: "image/jpeg" }));
  await check("POST /api/cam/upload legacy x-cam-token", 200, await P("/api/cam/upload", { method: "POST", body: "abc", ctype: "image/jpeg", camToken: CAM }));
  await check("POST /api/cam/upload Bearer cam token", 200, await P("/api/cam/upload", { ...B(CAM), method: "POST", body: "abc", ctype: "image/jpeg" }));

  console.log("\n== Camera control (dashboard token) ==");
  await check("POST /api/cam/capture Bearer", 502, await P("/api/cam/capture", { ...B(DASH), method: "POST" }));

  console.log("\n== Persisted snapshot is not a public asset ==");
  // The snapshot route serves bytes only with a dashboard token, and the
  // legacy public path is gone rather than redirected. An upload ran above,
  // so a dashboard token reads the image back; an anonymous read cannot.
  await check("GET /api/cam/latest anonymous", 401, await P("/api/cam/latest"));
  await check("GET /api/cam/latest dashboard token", 200, await P("/api/cam/latest", B(DASH)));
  await check("GET /api/cam/latest camera device token", 401, await P("/api/cam/latest", B(CAM)));
  await check("GET /cam/latest.jpg removed public path", 404, await P("/cam/latest.jpg"));
  await check("GET /cam/latest.jpg with dashboard token", 404, await P("/cam/latest.jpg", B(DASH)));

  if (/Connected to mqtt:\/\//.test(serverLog)) {
    console.log("ERROR: the process connected to an MQTT broker. Test must not.");
    exitCode = 1;
  } else {
    console.log("\nNo MQTT broker connection was opened.");
  }
  killChild();
  console.log(exitCode ? "\nPROBE FAILED" : "\nPROBE PASSED");
  process.exit(exitCode);
})();
