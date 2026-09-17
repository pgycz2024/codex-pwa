// Run the exact sanitized package in a disposable installation, never a user unit.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { verifyReleaseManifest } from "./verify-release-manifest.mjs";
import { parseEnvironmentFile } from "./read-env.mjs";

const exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyReleaseRuntime(directory, { timeoutMs = 90_000, report = console.log } = {}) {
  // Reject an incomplete or tampered candidate before executing package code.
  const manifestFiles = await verifyReleaseManifest(directory);
  const scratch = await mkdtemp(join(tmpdir(), "pwa-package-runtime-"));
  const app = join(scratch, "installed app");
  const project = join(scratch, "project");
  const configHome = join(scratch, "configuration");
  const config = join(configHome, "codex-pwa");
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), timeoutMs);
  const onSignal = () => abort.abort();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  let child, closed, daemon, sockets, connection;
  const rpcMethods = [], responses = [];
  let unexpectedRpc = "";
  async function run(command, args, options = {}) {
    try {
      await exec(command, args, { cwd: app, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
        signal: abort.signal, ...options });
    } catch (error) {
      // Installer output includes disposable credentials; do not echo it.
      throw new Error(`Package runtime command failed: ${command} (${error.code || error.name}); output withheld`);
    }
  }
  async function until(read, description) {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      abort.signal.throwIfAborted();
      if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error("Packaged server exited during acceptance");
      const value = await read();
      if (value) return value;
      await delay(50, undefined, { signal: abort.signal });
    }
    throw new Error(`Package runtime timed out: ${description}`);
  }
  try {
    await cp(directory, app, { recursive: true });
    await mkdir(project, { mode: 0o700 });
    await run("npm", ["ci", "--offline", "--omit=dev", "--no-audit", "--no-fund"]);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEX_PWA_")));
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    await run("bash", ["scripts/install-user.sh", "--dry-run", "--yes", "--loopback-only", "--skip-daemon-bootstrap",
      "--port", String(port), "--root", project, "--instance-name", "Package acceptance"], {
      env: { ...inherited, XDG_CONFIG_HOME: configHome },
    });
    const settings = Object.fromEntries(parseEnvironmentFile(await readFile(join(config, "codex-pwa.env"), "utf8")));
    // Keep HOME/CODEX_HOME intact. Only the test bridge socket and PWA state are isolated.
    delete settings.CODEX_HOME;
    assert.equal(settings.CODEX_PWA_ROOTS, project);
    assert.equal(settings.CODEX_PWA_HOST, "127.0.0.1");
    const socketPath = join(scratch, "daemon.sock");
    daemon = createServer();
    sockets = new WebSocketServer({ server: daemon });
    sockets.on("connection", (socket) => {
      connection = socket;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (Object.hasOwn(message, "result")) { responses.push(message); return; }
        rpcMethods.push(message.method);
        const reply = (result) => socket.send(JSON.stringify({ id: message.id, result }));
        if (message.method === "initialize") reply({ userAgent: "package-acceptance/fixture" });
        else if (message.method === "initialized") return;
        else if (message.method === "thread/read") reply({ thread: { id: "package-task", cwd: project, status: { type: "idle" } } });
        else {
          unexpectedRpc = message.method;
          socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unexpected package test RPC" } }));
        }
      });
    });
    await new Promise((resolve, reject) => { daemon.once("error", reject); daemon.listen(socketPath, resolve); });
    child = spawn(process.execPath, ["--unhandled-rejections=strict", "server.mjs"], {
      cwd: app, stdio: ["ignore", "ignore", "ignore"], env: {
        ...inherited, ...settings, NODE_ENV: "production", CODEX_PWA_DAEMON_SOCKET: socketPath,
        CODEX_PWA_ROOTS_FILE: join(config, "roots.json"), CODEX_PWA_EVENT_REPLAY_FILE: join(config, "events.jsonl"),
        CODEX_PWA_TASK_RECOVERY_FILE: join(config, "recovery.json"), CODEX_PWA_PUSH_CONFIG_FILE: "",
        CODEX_PWA_PUSH_STORE_FILE: join(config, "push.json"),
      },
    });
    closed = once(child, "close");
    const base = `http://127.0.0.1:${port}`;
    const request = (path, options = {}) => fetch(`${base}${path}`, { ...options,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(4000)]) });
    const version = JSON.parse(await readFile(join(app, "package.json"), "utf8")).version;
    await until(async () => {
      let response;
      try { response = await request("/api/health"); } catch { return false; }
      const health = await response.json();
      assert.equal(health.version, version, "packaged runtime version");
      return response.ok && health.ok === true && health.bridge === "ready";
    }, "healthy packaged application");
    assert.ok(rpcMethods.includes("initialize"), "runtime must initialize the isolated daemon");
    assert.equal((await request("/api/status")).status, 401);
    const password = (await readFile(settings.CODEX_PWA_PASSWORD_FILE, "utf8")).trim();
    const username = (await readFile(settings.CODEX_PWA_USERNAME_FILE, "utf8")).trim();
    const login = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }) });
    assert.equal(login.status, 200);
    const session = await login.json();
    const cookie = login.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const headers = { cookie: cookie.split(";")[0], "content-type": "application/json" };
    const authenticated = (path, options = {}) => request(path, { ...options, headers: { ...headers, ...options.headers } });
    const devicesPath = `/api/auth/devices/${encodeURIComponent(session.id)}`;
    assert.equal((await authenticated(devicesPath, { method: "PATCH", body: JSON.stringify({ label: "test" }) })).status, 403);
    headers["X-Codex-PWA-CSRF"] = session.csrfToken;
    assert.equal((await authenticated(devicesPath, { method: "PATCH", body: JSON.stringify({ label: "test" }) })).status, 200);
    const status = await (await authenticated("/api/status")).json();
    assert.deepEqual(status.roots, [project]);
    assert.deepEqual(status.ownedThreads, []);
    await writeFile(join(project, "sample.txt"), "package acceptance\n");
    assert.equal(await (await authenticated(`/api/files/raw?path=${encodeURIComponent(join(project, "sample.txt"))}`)).text(), "package acceptance\n");
    assert.equal((await authenticated(`/api/files/list?path=${encodeURIComponent(scratch)}`)).status, 403);

    let assets = 0;
    async function verifyAssets(folder, prefix = "") {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        const url = `${prefix}/${encodeURIComponent(entry.name)}`;
        if (entry.isDirectory()) await verifyAssets(path, url);
        else {
          const response = await request(url);
          assert.equal(response.status, 200, url);
          assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(path)), url);
          if (url === "/sw.js") assert.equal(response.headers.get("cache-control"), "no-cache");
          assets += 1;
        }
      }
    }
    await verifyAssets(join(app, "public"));
    const sw = await readFile(join(app, "public/sw.js"), "utf8");
    const list = sw.match(/const ASSETS = (\[[\s\S]*?\]);/)?.[1];
    assert.ok(list, "Service Worker precache list must be statically verifiable");
    const precache = JSON.parse(list.replace(/,\s*\]/g, "]"));
    for (const path of precache) {
      assert.equal(new URL(path, base).origin, base, "precache assets must be same-origin");
      assert.equal((await request(path)).status, 200, `Service Worker installation asset: ${path}`);
    }
    for (const [url, path] of [["/vendor/pdfjs/build/pdf.mjs", "pdfjs-dist/build/pdf.mjs"],
      ["/vendor/pdfjs/build/pdf.worker.mjs", "pdfjs-dist/build/pdf.worker.mjs"]]) {
      const response = await request(url);
      assert.equal(response.status, 200, url);
      assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(join(app, "node_modules", path))), url);
    }
    connection.send(JSON.stringify({ id: 0, method: "item/commandExecution/requestApproval", params: { threadId: "package-task", command: "fixture only" } }));
    const pending = await until(async () => {
      const current = await (await authenticated("/api/status")).json();
      return current.pendingApprovals.find((item) => item.requestId === "0");
    }, "packaged approval protocol");
    const decision = (requestToken) => authenticated("/api/approvals/0", { method: "POST", body: JSON.stringify({ decision: "decline", requestToken }) });
    assert.equal((await decision("stale-identity")).status, 409);
    assert.equal(responses.length, 0);
    assert.equal((await decision(pending.requestToken)).status, 200);
    await until(() => responses.length === 1, "approval result received by isolated daemon");
    assert.deepEqual(responses[0], { id: 0, result: { decision: "decline" } });
    assert.equal(unexpectedRpc, "", "acceptance must not start, resume or write real tasks");
    assert.equal(await verifyReleaseManifest(directory), manifestFiles, "source package remains unchanged");
    const result = { version, manifestFiles, assets, precache: precache.length };
    report(`Release runtime verified: version ${version}, ${assets} public files, ${precache.length} precache URLs; login, CSRF, roots and approval identity passed.`);
    return result;
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await closed; } finally { clearTimeout(kill); }
    }
    if (sockets) { for (const socket of sockets.clients) socket.terminate(); await new Promise((resolve) => sockets.close(resolve)); }
    if (daemon?.listening) await new Promise((resolve) => daemon.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error("Usage: node scripts/verify-release-runtime.mjs STAGED_PACKAGE"); process.exitCode = 1; }
  else verifyReleaseRuntime(resolve(process.argv[2])).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
