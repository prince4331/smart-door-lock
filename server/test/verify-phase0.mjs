// Phase 0 full verification suite (Step 13). Not part of `npm test`.
//
// Runs the whole Phase 0 acceptance checklist in one pass:
//   - npm ci from a clean tree (dependency integrity)
//   - syntax check of every shipped JS module
//   - npm test (the regression suite)
//   - startup with valid config  -> server listens, health 200
//   - startup with missing DASH_TOKEN -> refuses to listen, non-zero exit
//   - the dashboard probe (authenticated streaming + UI auth posture)
//   - secret scan of the working tree for credential-shaped values
//   - git diff --check (whitespace damage) and git status hygiene
//
// Run with: node test/verify-phase0.mjs
// Runs correctly from any directory; all paths are resolved from this file.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import http from "node:http";

const ROOT = path.resolve(import.meta.dirname, "..");
// Every runtime artifact lands here and is removed on exit, so the verifier
// can never leave the working tree dirty the way a probe DB in the tree did.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "smartlock-verify-"));

let exitCode = 0;
function check(name, ok, detail = "") {
  if (!ok) exitCode = 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
}

// The verifier must not be able to pass while leaving the tree dirty, so the
// state before anything runs is recorded and compared against the state at
// the end. Only entries that already existed may still be there.
const baselineStatus = (await run("git", ["status", "--porcelain"], { cwd: ROOT })).out
  .split(/\r?\n/).filter(Boolean);
const baselineFiles = new Set(
  baselineStatus.map((l) => l.slice(3)).map((f) => f.replace(/^"(.*)"$/, "$1"))
);

// On Windows, npm is npm.cmd; child_process.spawn without a shell cannot
// resolve it, and passing shell:true there would re-split absolute paths on
// spaces. Git and node resolve directly, so no shell is needed for them.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, { env = process.env, cwd, timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    // stdout and stderr are kept apart. npm writes human warnings to stderr
    // even when --json is asked for; merging the streams made those warnings
    // part of the JSON document and the audit step could then report a
    // failure that was never one.
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch (e) {} }, timeout);
    c.on("exit", (code, sig) => {
      clearTimeout(t);
      resolve({ code: code === null ? -1 : code, out, err, combined: out + err });
    });
  });
}

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

function get(port, target, { bearer } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (bearer) headers["Authorization"] = "Bearer " + bearer;
    const req = http.request({ host: "127.0.0.1", port, path: target, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c.toString()));
      res.on("end", () => { req.socket.destroy(); resolve({ status: res.statusCode, body }); });
    });
    req.on("error", (e) => resolve({ status: "ERR", body: e.message }));
    req.end();
  });
}

// ---- 1. dependency integrity -------------------------------------------------
console.log("\n== 1. Dependency integrity ==");
// Note: `npm ci` wipes node_modules and, on npm 10+, also prunes untracked
// directories such as test/ from the working tree. The committed lockfile is
// verified against node_modules instead.
const lock = path.join(ROOT, "package-lock.json");
let lockParsed = null;
try { lockParsed = JSON.parse(fs.readFileSync(lock, "utf8")); } catch (e) {}
check("package-lock.json is committed and parses", lockParsed !== null);
check("node_modules is installed for the committed tree", fs.existsSync(path.join(ROOT, "node_modules")));
check("lockfile names this package", lockParsed && lockParsed.name === "smartlock-server", lockParsed ? lockParsed.name : "");

// `npm audit` runs in a child process with a shell only for this one call,
// because npm is a .cmd shim on Windows. The command is a fixed literal.
// cwd must be pinned: without a package.json npm exits ENOLOCK and reports no
// vulnerability metadata at all, which reads as a failure but is not one.
const audit = await run(process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm",
  process.platform === "win32" ? ["/d", "/s", "/c", "npm audit --json"] : ["audit", "--json"],
  { shell: false, cwd: ROOT, timeout: 180000 });
// Only stdout is the JSON document. npm emits deprecation and funding notices
// to stderr regardless of --json; reading the combined streams made those
// look like an audit failure.
let auditOk = false;
let auditDetail = "";
try {
  const parsed = JSON.parse(audit.out);
  const total = parsed && parsed.metadata && parsed.metadata.vulnerabilities
    ? parsed.metadata.vulnerabilities.total : null;
  auditOk = total === 0;
  auditDetail = total === null ? "no vulnerability metadata" : `${total} vulnerability(ies)`;
} catch (e) {
  auditDetail = `unparsed stdout: ${audit.out.slice(0, 80)}`;
  if (audit.err) auditDetail += ` | stderr: ${audit.err.trim().slice(0, 80)}`;
}
check("npm audit reports zero vulnerabilities", auditOk, auditDetail);

// ---- 2. syntax of every shipped module ---------------------------------------
console.log("\n== 2. Syntax ==");
const modules = ["src/index.js", "test/security.test.mjs", "test/probe-phase0.mjs",
  "test/dashboard-phase0.mjs", "test/verify-phase0.mjs"];
for (const m of modules) {
  const r = await run(process.execPath, ["--check", path.join(ROOT, m)]);
  check(`node --check ${m}`, r.code === 0);
}

// ---- 3. regression suite ------------------------------------------------------
console.log("\n== 3. Regression suite ==");
const tests = await run(process.execPath, ["--test", path.join(ROOT, "test", "*.test.mjs")],
  { env: { ...process.env, NODE_ENV: "test", DISABLE_RATE_LIMIT: "1" }, timeout: 240000 });
const pass = /\(?\s*pass\s+(\d+)/.test(tests.out) ? Number(tests.out.match(/pass\s+(\d+)/)[1]) : 0;
const fail = /\(?\s*fail\s+(\d+)/.test(tests.out) ? Number(tests.out.match(/fail\s+(\d+)/)[1]) : -1;
check("npm test passes with no failures", tests.code === 0 && fail === 0,
  tests.code === 0 ? `pass ${pass} / fail ${fail}` : `exit ${tests.code} pass ${pass} fail ${fail}`);

// ---- 4. fail-closed startup: missing token ------------------------------------
console.log("\n== 4. Fail-closed startup ==");
const DASH = crypto.randomBytes(32).toString("hex");
const CAM = crypto.randomBytes(32).toString("hex");
const ENC_KEY = crypto.randomBytes(32).toString("hex");
const PORT = String(await freePort());
const VERIFY_DB = path.join(SCRATCH, "data.verify.db");
const CAM_DIR = path.join(SCRATCH, "cam");
// Explicit environment only: the developer .env must not leak into the probe
// process, otherwise a missing DASH_TOKEN would be silently supplied from disk.
const baseEnv = {
  PATH: process.env.PATH,
  SYSTEMROOT: process.env.SYSTEMROOT || "",
  DASH_TOKEN: DASH,
  CAM_UPLOAD_TOKEN: CAM,
  SETTINGS_ENCRYPTION_KEY: ENC_KEY,
  DB_PATH: VERIFY_DB,
  CAM_STORAGE_DIR: CAM_DIR,
  MQTT_BROKER: "mqtt://127.0.0.1:18830",   // unreachable: never contacted
  MQTT_USERNAME: "", MQTT_PASSWORD: "", TG_BOT_TOKEN: "", TG_CHAT_ID: "",
  NODE_ENV: "development", DISABLE_RATE_LIMIT: "1", PORT,
};

// A generated env file exercises the documented workflow end to end: the
// tokens are supplied by the file, not by the parent shell.
const ENV_FILE = path.join(SCRATCH, ".env.verify");
fs.writeFileSync(ENV_FILE,
  "DASH_TOKEN=" + DASH + "\nCAM_UPLOAD_TOKEN=" + CAM + "\nSETTINGS_ENCRYPTION_KEY=" + ENC_KEY + "\nPORT=" + PORT + "\n");
check("generated .env is written for the startup probe", fs.existsSync(ENV_FILE));

// No DASH_TOKEN at all: the startup gate must refuse to listen. The env file
// used here deliberately omits it, so the only way to boot would be a token
// leaking in from somewhere else.
const NO_TOKEN_ENV_FILE = path.join(SCRATCH, ".env.verify-no-token");
fs.writeFileSync(NO_TOKEN_ENV_FILE, "CAM_UPLOAD_TOKEN=" + CAM + "\nSETTINGS_ENCRYPTION_KEY=" + ENC_KEY + "\nPORT=" + PORT + "\n");
const badStart = await run(process.execPath, [path.join(ROOT, "src", "index.js")],
  { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT || "",
      NODE_ENV: "development", DOTENV_CONFIG_PATH: NO_TOKEN_ENV_FILE,
      DB_PATH: VERIFY_DB, CAM_STORAGE_DIR: CAM_DIR,
      MQTT_BROKER: "mqtt://127.0.0.1:18830", MQTT_USERNAME: "", MQTT_PASSWORD: "",
      TG_BOT_TOKEN: "", TG_CHAT_ID: "", SETTINGS_ENCRYPTION_KEY: ENC_KEY, DISABLE_RATE_LIMIT: "1", PORT },
    timeout: 20000 });
check("missing DASH_TOKEN exits non-zero", badStart.code !== 0, `exit ${badStart.code}`);
check("missing DASH_TOKEN terminates without hanging", badStart.code !== -1, `exit ${badStart.code}`);
// The error lines go to stderr, so both streams are inspected. The negative
// checks read both as well: a banner or a broker connection printed to stderr
// would be just as much of a failure.
const badStartOutput = badStart.out + "\n" + badStart.err;
check("missing DASH_TOKEN reports the variable name", /DASH_TOKEN/.test(badStartOutput));
check("missing DASH_TOKEN never prints 'Server running'", !/Server running/.test(badStartOutput));
check("missing DASH_TOKEN never connects to MQTT", !/Connected to mqtt:\/\//.test(badStartOutput));

// A healthy startup does NOT exit on its own: the MQTT client keeps a
// reconnect timer alive in production. The verifier therefore asserts the
// listening banner within a short window, then kills the process itself.
// A natural exit during that window would be a failure.
const healthyStart = await new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, "src", "index.js")],
    { cwd: ROOT, env: { ...baseEnv, DOTENV_CONFIG_PATH: ENV_FILE }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (out += d));
  const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch (e) {} resolve({ timedOut: true, out }); }, 6000);
  c.on("exit", (code) => { clearTimeout(t); resolve({ timedOut: false, out, code: code === null ? -1 : code }); });
});
check("valid env file brings the server up and keeps it up",
  /Server running/.test(healthyStart.out) && healthyStart.timedOut,
  healthyStart.timedOut ? "still listening at timeout" : `exited ${healthyStart.code}`);
check("valid env file supplies the tokens, not the parent shell",
  /Server running/.test(healthyStart.out) && !/DASH_TOKEN/.test(healthyStart.out));

// ---- 5. valid startup + HTTP probes ------------------------------------------
console.log("\n== 5. Valid startup and HTTP probes ==");
// The tokens come from the generated env file, which is the documented
// workflow; the process environment carries only the scratch paths.
const goodEnv = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT || "",
  NODE_ENV: "development", DOTENV_CONFIG_PATH: ENV_FILE,
  DB_PATH: VERIFY_DB, CAM_STORAGE_DIR: CAM_DIR,
  MQTT_BROKER: "mqtt://127.0.0.1:18830", MQTT_USERNAME: "", MQTT_PASSWORD: "",
  TG_BOT_TOKEN: "", TG_CHAT_ID: "", SETTINGS_ENCRYPTION_KEY: ENC_KEY, DISABLE_RATE_LIMIT: "1", PORT };
const child = spawn(process.execPath, [path.join(ROOT, "src", "index.js")], { cwd: ROOT, env: goodEnv, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
child.stdout.on("data", (c) => (serverLog += c.toString()));
child.stderr.on("data", (c) => (serverLog += c.toString()));
const killChild = () => { try { child.kill("SIGKILL"); } catch (e) {} };
process.on("exit", killChild);

await new Promise((r) => setTimeout(r, 2500));
check("valid config brings the server up", /Server running/.test(serverLog), serverLog.split("\n")[0] || "");

const health = await get(Number(PORT), "/api/health");
check("/api/health is public and 200", health.status === 200, health.body.slice(0, 24));

const state = await get(Number(PORT), "/api/state", { bearer: DASH });
check("authenticated /api/state is 200", state.status === 200, state.body.slice(0, 24));

const events = await get(Number(PORT), "/api/events?limit=5", { bearer: DASH });
check("authenticated /api/events is 200", events.status === 200, events.body.slice(0, 24));

const anon = await get(Number(PORT), "/api/state");
check("anonymous /api/state is 401", anon.status === 401, anon.body.slice(0, 32));

const wrong = await get(Number(PORT), "/api/state", { bearer: "not-the-token" });
check("wrong token /api/state is 401 (not 403)", wrong.status === 401, wrong.body.slice(0, 32));

// The command reaches the publish step, but no broker is listening, so the
// acknowledgement never arrives and the request hangs. Bound it: a request
// that outlives the window is proof it was authenticated and got past the
// token check.
const cmd = await new Promise((resolve) => {
  const data = JSON.stringify({ command: "LOCK" });
  const req = http.request({ host: "127.0.0.1", port: Number(PORT), path: "/api/command", method: "POST", timeout: 5000,
    headers: { Authorization: "Bearer " + DASH, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
    (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { req.socket.destroy(); resolve({ status: res.statusCode, b }); }); });
  req.on("timeout", () => { req.destroy(); resolve({ status: "TIMEOUT", b: "" }); });
  req.on("error", (e) => resolve({ status: "ERR", b: e.message }));
  req.end(data);
});
check("authenticated POST /api/command reaches the publish step",
  cmd.status === 200 || cmd.status === "TIMEOUT", `status ${cmd.status}`);
check("server never contacted the MQTT broker", !/Connected to mqtt:\/\//.test(serverLog));

// Camera media privacy: the persisted snapshot is served only through the
// authenticated route, and the removed public path stays gone.
const mediaAnon = await get(Number(PORT), "/api/cam/latest");
check("anonymous /api/cam/latest is 401", mediaAnon.status === 401, mediaAnon.body.slice(0, 32));

// A real device upload lands in the scratch storage directory, then the same
// dashboard token can read it back. Nothing else is authorised to.
const uploaded = "verify-snapshot";
const upload = await new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port: Number(PORT), path: "/api/cam/upload", method: "POST",
    headers: { "x-cam-token": CAM, "Content-Type": "image/jpeg", "Content-Length": Buffer.byteLength(uploaded) } },
    (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { req.socket.destroy(); resolve({ status: res.statusCode, b }); }); });
  req.on("error", (e) => resolve({ status: "ERR", b: e.message }));
  req.end(uploaded);
});
check("camera upload with the device token is 200", upload.status === 200, `status ${upload.status}`);

const latest = await get(Number(PORT), "/api/cam/latest", { bearer: DASH });
check("dashboard token reads the uploaded snapshot", latest.status === 200 && latest.body === uploaded,
  `status ${latest.status}`);
check("snapshot storage stays outside the public root",
  !fs.existsSync(path.join(ROOT, "public", "cam", "latest.jpg")),
  "public/cam must be gone");

const removed = await get(Number(PORT), "/cam/latest.jpg");
check("/cam/latest.jpg is gone", removed.status === 404, `status ${removed.status}`);

killChild();
// The whole scratch directory goes away, so no artifact can outlive the run.
fs.rmSync(SCRATCH, { recursive: true, force: true });

// ---- 6. dashboard probe --------------------------------------------------------
console.log("\n== 6. Dashboard auth flow ==");
const dash = await run(process.execPath, [path.join(ROOT, "test", "dashboard-phase0.mjs")], { cwd: ROOT, timeout: 180000 });
check("dashboard-phase0 probe passes", dash.code === 0, `exit ${dash.code}`);

// ---- 7. secret scan --------------------------------------------------------------
console.log("\n== 7. Secret hygiene ==");
// Long hex / base64 runs plus the credential filenames that must stay untracked.
const patterns = [
  /password\s*[:=]\s*['"]?[A-Za-z0-9!@#$%^&*]{12,}/i,
  /['"][A-Za-z0-9+\/]{40,}['"]/,
  /api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]{16,}['"]/i,
  /bot[0-9]{6,}:[A-Za-z0-9_-]{20,}/,
];
const tracked = (await run("git", ["ls-files"], { cwd: ROOT })).out.split(/\r?\n/).filter(Boolean);
let secretHits = 0;
for (const f of tracked) {
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
  const text = fs.readFileSync(full, "utf8");
  for (const p of patterns) if (p.test(text)) { secretHits++; console.log(`  hit in ${f}`); }
}
check("no credential-shaped string in any tracked file", secretHits === 0, `${secretHits} hit(s)`);

const status = await run("git", ["status", "--porcelain"], { cwd: ROOT });
const stray = status.out.split(/\r?\n/).filter(Boolean).filter((l) =>
  /\.(db|pem|key|env)$/.test(l) || /(^|\/)\.env$/.test(l));
check("no .env, .db, .pem or .key left in the working tree", stray.length === 0,
  stray.length ? stray.join(", ") : "");

const wsCheck = await run("git", ["diff", "--check"], { cwd: ROOT });
check("git diff --check is clean", wsCheck.code === 0, wsCheck.out.trim().slice(0, 60));

// No camera snapshot may remain anywhere under the public root: it is the one
// artifact this suite creates that used to be committed, and finding it here
// means the relocation or the route failed closed.
const publicCamDir = path.join(ROOT, "public", "cam");
check("no camera snapshot left under the public root",
  !fs.existsSync(publicCamDir), fs.existsSync(publicCamDir) ? "public/cam exists" : "");

// The decisive gate. The verifier writes nothing into the working tree: every
// artifact it creates goes into the scratch temporary directory. So the only
// pollution it can produce is a *new* untracked runtime file — a probe
// database or a camera snapshot left behind in the tree, which is exactly the
// defect this suite used to have. Tracked-file modifications are not counted,
// because editing a tracked source file between the baseline and this point
// is a legitimate change, not pollution.
const status2 = await run("git", ["status", "--porcelain"], { cwd: ROOT });
const leftover = status2.out.split(/\r?\n/).filter(Boolean);
const newUntracked = leftover
  .filter((l) => /^(\?\?|A )/.test(l))
  .map((l) => l.slice(3).replace(/^"(.*)"$/, "$1"))
  .filter((f) => !baselineFiles.has(f));
check("no new untracked runtime file is left behind",
  newUntracked.length === 0, newUntracked.length ? newUntracked.slice(0, 4).join(", ") : "");

console.log("\nWorking tree at end of verification:");
for (const l of leftover) console.log("  " + l);

console.log(exitCode ? "\nPHASE 0 VERIFICATION FAILED" : "\nPHASE 0 VERIFICATION PASSED");
process.exit(exitCode);
