// Opt-in integration acceptance; never invoked by `npm run check`.
// Starts only a uniquely named, temporary user unit. Requires an existing daemon.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const codex = process.env.CODEX_BIN || "codex";
const unit = `codex-pwa-acceptance-${randomUUID()}.service`;
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort.abort());
const deadline = setTimeout(() => abort.abort(), 180_000);
const checks = [];
let directory;
let linked = false;
let before;
let daemon;
let failure;

async function run(command, args, options = {}) {
  // Capture installer output: it includes a temporary password and must not be printed.
  try {
    return (await exec(command, args, {
      cwd: source, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      signal: abort.signal, ...options,
    })).stdout.trim();
  } catch (error) {
    throw new Error(`${command} failed (${error.code || error.name}); command output withheld`);
  }
}
const systemctl = (...args) => run("systemctl", ["--user", ...args]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pass = (name) => { checks.push(name); console.log(`PASS ${name}`); };

async function guardSnapshot(options = {}) {
  const socket = await stat(daemon.socketPath);
  const services = await run("systemctl", ["--user", "show", "codex-pwa.service", "codex-pwa-private.service",
    "-p", "Id", "-p", "MainPID", "-p", "ExecMainStartTimestampMonotonic", "-p", "ActiveState"], options);
  const configuration = {};
  const config = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "codex-pwa");
  for (const file of ["codex-pwa.env", "authorized-roots.json"]) {
    try { configuration[file] = sha256(await readFile(join(config, file))); }
    catch (error) { if (error.code !== "ENOENT") throw error; configuration[file] = null; }
  }
  return { services, socket: [socket.dev, socket.ino, socket.mtimeMs], configuration };
}

async function unusedPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

try {
  assert.equal(process.platform, "linux", "Linux user systemd is required");
  assert.ok(process.env.HOME, "A real user HOME is required");
  daemon = JSON.parse(await run(codex, ["app-server", "daemon", "version"]));
  assert.equal(daemon.status, "running", "Start the daemon separately before acceptance");
  before = await guardSnapshot();
  const cache = join(homedir(), ".cache");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  // PrivateTmp=true prevents a service from seeing a checkout under host /tmp.
  directory = await mkdtemp(join(cache, "codex-pwa-acceptance-"));
  const app = join(directory, "app with spaces");
  const configHome = join(directory, "configuration");
  const config = join(configHome, "codex-pwa");
  const project = join(directory, "project");
  const extra = join(directory, "additional project");
  await Promise.all([app, project, extra].map((path) => mkdir(path, { mode: 0o700 })));
  // Copy the complete runtime and actual installer, without development state or credentials.
  for (const entry of await readdir(source)) {
    if (entry.endsWith(".mjs") || ["package.json", "package-lock.json", "public", "scripts", "systemd"].includes(entry)) {
      await cp(join(source, entry), join(app, entry), { recursive: true });
    }
  }
  await run("npm", ["ci", "--offline", "--omit=dev", "--no-audit", "--no-fund"], { cwd: app });
  const port = await unusedPort();
  await run("bash", ["scripts/install-user.sh", "--dry-run", "--yes", "--loopback-only",
    "--skip-daemon-bootstrap", "--port", String(port), "--root", project,
    "--instance-name", "Isolated release acceptance"], {
    cwd: app, env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });
  const rootsFile = join(config, "authorized-roots.json");
  const replayFile = join(config, "event-replay.jsonl");
  const quote = (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  await appendFile(join(config, "codex-pwa.env"), [
    `CODEX_PWA_ROOTS_FILE=${quote(rootsFile)}`,
    `CODEX_PWA_EVENT_REPLAY_FILE=${quote(replayFile)}`,
    `CODEX_PWA_DAEMON_SOCKET=${quote(daemon.socketPath)}`,
    "",
  ].join("\n"));
  const generated = join(configHome, "systemd", "user", "codex-pwa.service");
  const temporaryUnit = join(directory, unit);
  await cp(generated, temporaryUnit);
  await run("systemd-analyze", ["--user", "verify", temporaryUnit]);
  pass("actual installer unit validates (installation path contains spaces)");
  linked = true;
  await systemctl("link", "--runtime", temporaryUnit);
  await systemctl("daemon-reload");
  await systemctl("start", unit);

  const base = `http://127.0.0.1:${port}`;
  const version = JSON.parse(await readFile(join(app, "package.json"), "utf8")).version;
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]),
  });
  async function health() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      abort.signal.throwIfAborted();
      try {
        const response = await request("/api/health");
        const value = await response.json();
        if (response.ok && value.ok === true && value.bridge === "ready" && value.version === version) return;
      } catch (error) { if (abort.signal.aborted) throw error; }
      await delay(100, undefined, { signal: abort.signal });
    }
    throw new Error("Temporary service health did not become ready");
  }
  await health();
  assert.equal(await systemctl("show", unit, "-p", "PrivateTmp", "--value"), "yes");
  assert.equal(await systemctl("show", unit, "-p", "NoNewPrivileges", "--value"), "yes");
  pass("real systemd starts full PWA with hardening and shared-daemon initialization");
  assert.equal((await request("/api/status")).status, 401);
  const login = await request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: (await readFile(join(config, "access-username"), "utf8")).trim(),
      password: (await readFile(join(config, "access-password"), "utf8")).trim(), remember: true }),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const cookieHeader = login.headers.get("set-cookie");
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  const headers = { cookie: cookieHeader.split(";")[0], "content-type": "application/json" };
  const authenticated = (path, options = {}) => request(path, {
    ...options, headers: { ...headers, ...options.headers },
  });
  const rename = `/api/auth/devices/${encodeURIComponent(session.id)}`;
  assert.equal((await authenticated(rename, { method: "PATCH", body: JSON.stringify({ label: "acceptance" }) })).status, 403);
  headers["x-codex-pwa-csrf"] = session.csrfToken;
  assert.equal((await authenticated(rename, { method: "PATCH", body: JSON.stringify({ label: "acceptance" }) })).status, 200);
  pass("authentication, persistent device cookie and CSRF enforcement");

  const statusResponse = await authenticated("/api/status");
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.deepEqual(status.roots, [project]);
  assert.deepEqual(status.ownedThreads, []);
  assert.equal(status.eventReplay.persistent, true);
  assert.equal(status.appServerMode, "shared-daemon");
  await writeFile(join(project, "acceptance.txt"), "isolated acceptance\n", { mode: 0o600 });
  assert.equal((await authenticated(`/api/files/list?path=${encodeURIComponent(directory)}`)).status, 403);
  const file = await authenticated(`/api/files/raw?path=${encodeURIComponent(join(project, "acceptance.txt"))}`);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), "isolated acceptance\n");
  const rootResponse = await authenticated("/api/access-roots", { method: "POST",
    headers: { "x-codex-pwa-root-change": "1" }, body: JSON.stringify({ path: extra }) });
  assert.equal(rootResponse.status, 200);
  pass("isolated root boundary, file reads and additional-root persistence");

  let assets = 0;
  async function verifyAssets(folder, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const url = `${prefix}/${encodeURIComponent(entry.name)}`;
      if (entry.isDirectory()) await verifyAssets(path, url);
      else if (entry.isFile()) {
        const response = await request(url);
        assert.equal(response.status, 200, `Static resource: ${url}`);
        assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(await readFile(path)), url);
        if (url === "/sw.js") assert.equal(response.headers.get("cache-control"), "no-cache");
        assets += 1;
      }
    }
  }
  await verifyAssets(join(app, "public"));
  const vendorFiles = ["marked/lib/marked.esm.js", "dompurify/dist/purify.es.mjs", "katex/dist/katex.mjs",
    "katex/dist/katex.min.css", "pdfjs-dist/build/pdf.mjs", "pdfjs-dist/build/pdf.worker.mjs"];
  for (const path of vendorFiles) {
    const url = `/vendor/${path.replace("marked/lib/", "marked/").replace("dompurify/dist/", "dompurify/")
      .replace("katex/dist/", "katex/").replace("pdfjs-dist/", "pdfjs/")}`;
    const response = await request(url);
    assert.equal(response.status, 200, url);
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(await readFile(join(app, "node_modules", path))), url);
  }
  pass(`${assets} public assets plus ${vendorFiles.length} vendor resources match installed bytes`);

  const oldRecords = (await readFile(replayFile, "utf8")).trim().split("\n").map(JSON.parse);
  const priorPid = await systemctl("show", unit, "-p", "MainPID", "--value");
  await systemctl("restart", unit);
  await health();
  const newPid = await systemctl("show", unit, "-p", "MainPID", "--value");
  assert.notEqual(newPid, "0");
  assert.notEqual(newPid, priorPid);
  const restoredResponse = await authenticated("/api/auth/session");
  assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json();
  assert.equal(restored.id, session.id);
  assert.equal(restored.csrfToken, session.csrfToken);
  const restoredStatus = await (await authenticated("/api/status")).json();
  assert.deepEqual(restoredStatus.roots, [project, extra]);
  assert.deepEqual(restoredStatus.ownedThreads, []);
  const records = (await readFile(replayFile, "utf8")).trim().split("\n").map(JSON.parse);
  for (const record of oldRecords) assert.deepEqual(records.find(({ id }) => id === record.id), record);
  assert.ok(records.at(-1).id > oldRecords.at(-1).id);
  const replay = await authenticated("/api/events", { headers: { "last-event-id": String(oldRecords.at(-2).id) } });
  const reader = replay.body.getReader();
  let frames = "";
  try {
    while (!frames.includes(`id: ${oldRecords.at(-1).id}\n`)) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      frames += new TextDecoder().decode(value);
    }
  } finally { await reader.cancel(); }
  const replayedFrame = frames.split("\n\n").find((frame) => frame.startsWith(`id: ${oldRecords.at(-1).id}\n`));
  assert.deepEqual(JSON.parse(replayedFrame.split("\ndata: ")[1]), oldRecords.at(-1).payload);
  for (const file of [rootsFile, replayFile, join(config, "trusted-devices.json")]) {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  pass("real service restart preserves login, roots, replay IDs and SSE resume; persisted files mode 600");
  await systemctl("kill", "--kill-whom=main", "--signal=SIGKILL", unit);
  await health();
  const recoveredPid = await systemctl("show", unit, "-p", "MainPID", "--value");
  assert.notEqual(recoveredPid, "0");
  assert.notEqual(recoveredPid, newPid);
  assert.ok(Number(await systemctl("show", unit, "-p", "NRestarts", "--value")) >= 1);
  const crashSession = await authenticated("/api/auth/session");
  assert.equal(crashSession.status, 200);
  assert.equal((await crashSession.json()).id, session.id);
  pass("Restart=on-failure recovers an isolated process crash with login preserved");
} catch (error) {
  failure = error;
} finally {
  clearTimeout(deadline);
  // Cleanup ignores the test abort, but retains its own per-command time limit.
  let stopped = !linked;
  if (linked) {
    try {
      await run("systemctl", ["--user", "stop", unit], { signal: undefined });
      stopped = true;
      await run("systemctl", ["--user", "disable", "--runtime", unit], { signal: undefined });
      await run("systemctl", ["--user", "daemon-reload"], { signal: undefined });
    } catch (error) { stopped = false; failure ||= error; }
  }
  if (directory && stopped) {
    try { await rm(directory, { recursive: true, force: true }); }
    catch (error) { failure ||= error; }
  }
  if (!stopped) console.error(`Temporary unit cleanup requires attention: ${unit}; directory preserved`);
  if (before) {
    try { assert.deepEqual(await guardSnapshot({ signal: undefined }), before); pass("existing PWA units, production configuration and daemon socket unchanged"); }
    catch (error) { failure ||= error; }
  }
  if (abort.signal.aborted) failure ||= new Error("Acceptance interrupted or timed out");
}
if (failure) {
  console.error(`Systemd acceptance failed: ${failure.message}`);
  process.exitCode = 1;
} else {
  console.log(`Systemd acceptance passed: ${checks.length} groups; temporary unit and files removed.`);
}
