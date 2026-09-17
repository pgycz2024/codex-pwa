import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvironmentFile } from "../scripts/read-env.mjs";

const project = fileURLToPath(new URL("..", import.meta.url));

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  // exit can precede the final stdout/stderr chunks (including git HEAD).
  const [code] = await once(child, "close");
  return { code, output };
}

// A real HTTP process is installed and swapped. Only the systemd/Codex command
// surfaces are replaced; this fixture never controls the account's real services.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pwa lifecycle "));
  const app = join(root, "installed app");
  const config = join(root, "config");
  const bin = join(root, "bin");
  for (const path of [app, bin, join(config, "codex-pwa")]) await mkdir(path, { recursive: true });
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  let service = null;
  const commands = [];
  const stop = async () => {
    if (service && service.exitCode === null && service.signalCode === null) {
      const exited = once(service, "exit");
      service.kill("SIGTERM");
      await exited;
    }
    service = null;
  };
  const supervisor = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const args = JSON.parse(text);
    commands.push(args);
    const command = args[1];
    let result = { code: 0, output: "" };
    try {
      if (command === "show") result.output = `CODEX_PWA_PORT=${port}`;
      if (["stop", "restart"].includes(command) && args[2] === "codex-pwa.service") await stop();
      if (command === "restart" && args[2] === "codex-pwa.service") {
        const settings = JSON.parse(await readFile(join(app, "fixture.json"), "utf8"));
        if (settings.restartFailure) result.code = 1;
        else {
          service = spawn(process.execPath, [join(app, "server.mjs")], {
            cwd: app, env: { ...process.env, FIXTURE_PORT: String(port) }, stdio: "ignore",
          });
          // Wait for bind, as systemctl restart does not guarantee HTTP readiness.
          for (let attempt = 0; attempt < 100; attempt += 1) {
            try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
            if (service.exitCode !== null) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }
    } catch (error) { result = { code: 1, output: error.message }; }
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => supervisor.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await stop();
    await new Promise((resolve) => supervisor.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const env = {
    ...process.env, XDG_CONFIG_HOME: config,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, CODEX_BIN: join(bin, "codex"),
    FIXTURE_SUPERVISOR: `http://127.0.0.1:${supervisor.address().port}`,
    npm_config_audit: "false", npm_config_fund: "false", npm_config_offline: "true",
  };
  await writeFile(join(bin, "systemctl"), `#!/usr/bin/env node
const result = await fetch(process.env.FIXTURE_SUPERVISOR, { method: "POST", body: JSON.stringify(process.argv.slice(2)) }).then(r => r.json());
process.stdout.write(result.output); process.exitCode = result.code;
`, { mode: 0o755 });
  await writeFile(join(bin, "codex"), `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "app-server daemon version") console.log(JSON.stringify({ status: "running", socketPath: "/tmp/isolated-test-daemon.sock" }));
else if (args !== "login status") process.exitCode = 1;
`, { mode: 0o755 });
  await writeFile(join(bin, "systemd-analyze"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(bin, "loginctl"), "#!/bin/sh\nprintf 'yes\\n'\n", { mode: 0o755 });
  // Test credentials and session state are intentionally outside the program tree.
  const saved = { "access-password": "fixture-password-only\n", "access-username": "fixture-user\n", "trusted-devices.json": "[]\n" };
  for (const [name, value] of Object.entries(saved)) await writeFile(join(config, "codex-pwa", name), value, { mode: 0o600 });
  const stateFile = join(config, "codex-pwa", "codex-pwa.env");
  await writeFile(stateFile, `CODEX_PWA_PORT="${port}"\nCODEX_PWA_ROOTS="${app}"\n`, { mode: 0o600 });

  async function makeApp(directory, version, settings = {}) {
    await mkdir(join(directory, "scripts"), { recursive: true });
    await mkdir(join(directory, "public"), { recursive: true });
    const pkg = { name: "pwa-deployment-fixture", version, type: "module", scripts: { check: "node check.mjs" } };
    await writeFile(join(directory, "package.json"), JSON.stringify(pkg));
    await writeFile(join(directory, "package-lock.json"), JSON.stringify({ name: pkg.name, version, lockfileVersion: 3,
      packages: { "": { name: pkg.name, version } },
    }));
    await writeFile(join(directory, "fixture.json"), JSON.stringify(settings));
    await writeFile(join(directory, "check.mjs"), `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const settings = JSON.parse(readFileSync("fixture.json"));
if (settings.checkFailure) process.exit(1);
if (settings.pauseCheck) {
  writeFileSync(process.env.FIXTURE_CHECK_STARTED, "ready");
  while (!existsSync(process.env.FIXTURE_CHECK_RELEASE)) await new Promise(resolve => setTimeout(resolve, 20));
}
`);
    await writeFile(join(directory, "server.mjs"), `import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json"));
const settings = JSON.parse(readFileSync("fixture.json"));
const worker = readFileSync("public/sw.js", "utf8");
createServer((req, res) => {
  if (req.url === "/api/health") res.end(JSON.stringify({ ok: settings.healthOk !== false, version: settings.runtimeVersion || pkg.version }));
  else if (req.url === "/sw.js") res.end(settings.staleWorker ? 'const CACHE = "stale-worker";\\n' : worker);
  else { res.statusCode = 404; res.end(); }
}).listen(Number(process.env.FIXTURE_PORT), "127.0.0.1");
`);
    await writeFile(join(directory, "public/sw.js"), `const CACHE = "fixture-${version}";\n`);
    for (const name of ["install-user.sh", "update-user.sh", "read-env.mjs", "verify-release-manifest.mjs"]) await cp(join(project, "scripts", name), join(directory, "scripts", name));
  }

  async function archive(version, settings = {}, { corrupt = false } = {}) {
    const stage = await mkdtemp(join(root, "package-"));
    const name = `codex-pwa-v${version}`;
    const candidate = join(stage, name);
    await makeApp(candidate, version, settings);
    const entries = await readdir(candidate, { recursive: true, withFileTypes: true });
    const lines = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = join(entry.parentPath, entry.name);
      const hash = createHash("sha256").update(await readFile(file)).digest("hex");
      lines.push(`${hash}  ./${file.slice(candidate.length + 1)}`);
    }
    await writeFile(join(candidate, "RELEASE-MANIFEST.sha256"), lines.sort().join("\n") + "\n");
    if (corrupt) await writeFile(join(candidate, "public/sw.js"), 'const CACHE = "damaged";\n');
    const zip = join(stage, "candidate.zip");
    const result = await run("zip", ["-qr", zip, name], { cwd: stage });
    assert.equal(result.code, 0, result.output);
    return zip;
  }

  await makeApp(app, "1.0.0");
  const control = (...args) => run("systemctl", ["--user", ...args], { env });
  const update = (zip) => run("bash", [join(app, "scripts/update-user.sh"), ...(zip ? ["--zip", zip] : [])], { cwd: app, env });
  const health = async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  const assertPreserved = async () => {
    for (const [name, value] of Object.entries(saved)) assert.equal(await readFile(join(config, "codex-pwa", name), "utf8"), value);
  };
  return { root, app, bin, config, env, port, stateFile, commands, archive, makeApp, control, update, health, assertPreserved };
}

async function gitFixture(t, settings = {}) {
  const f = await fixture(t);
  // Local fixture repositories only: no source-checkout commits, external remotes,
  // network access or real user Git credentials are involved.
  const upstream = join(f.root, "upstream");
  const git = async (directory, ...args) => {
    const result = await run("git", ["-c", "user.name=PWA fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", directory, ...args], { env: f.env });
    assert.equal(result.code, 0, result.output);
    return result.output.trim();
  };
  await cp(f.app, upstream, { recursive: true });
  await writeFile(join(upstream, ".gitignore"), "node_modules/\n.local-instance\n");
  await git(upstream, "init", "-b", "main");
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-m", "Fixture initial version");
  await rm(f.app, { recursive: true });
  await git(f.root, "clone", upstream, f.app);
  const previousHead = await git(f.app, "rev-parse", "HEAD");
  await f.makeApp(upstream, "1.0.1", settings);
  await git(upstream, "add", ".");
  await git(upstream, "commit", "-m", "Fixture candidate version");
  const candidateHead = await git(upstream, "rev-parse", "HEAD");
  return { ...f, git, upstream, previousHead, candidateHead };
}

test("installer starts an isolated HTTP service and preserves existing credentials on reinstall", async (t) => {
  const f = await fixture(t);
  const persistedNames = ["CODEX_PWA_ROOTS_FILE", "CODEX_PWA_EVENT_REPLAY_FILE", "CODEX_PWA_TASK_RECOVERY_FILE", "CODEX_PWA_PUSH_CONFIG_FILE", "CODEX_PWA_PUSH_STORE_FILE"];
  const existing = await readFile(f.stateFile, "utf8");
  await writeFile(f.stateFile, `${existing}\n${persistedNames.map((name) => `${name}="${join(f.root, `${name}.json`)}"`).join("\n")}\n`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Absolute invocation must install the application, not the caller's cwd.
    const result = await run("bash", [join(f.app, "scripts/install-user.sh"), "--yes", "--loopback-only", "--skip-daemon-bootstrap", "--port", String(f.port)], { cwd: attempt === 0 ? f.root : f.app, env: f.env });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await f.health(), { ok: true, version: "1.0.0" });
    await f.assertPreserved();
    const config = parseEnvironmentFile(await readFile(f.stateFile, "utf8"));
    assert.equal(config.get("CODEX_PWA_ROOTS"), f.app);
    assert.equal(config.get("CODEX_PWA_DAEMON_SOCKET"), "/tmp/isolated-test-daemon.sock");
    for (const name of persistedNames) assert.equal(config.get(name), join(f.root, `${name}.json`));
  }
});

test("default installation reuses a running daemon without bootstrap or start", async (t) => {
  const f = await fixture(t);
  const result = await run("bash", [join(f.app, "scripts/install-user.sh"), "--yes", "--loopback-only", "--port", String(f.port)], { cwd: f.root, env: f.env });
  // The CLI fixture rejects every command other than login status and daemon
  // version, so this fails if setup attempts any daemon lifecycle mutation.
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Reusing the running Codex app-server daemon/);
  assert.equal((await f.health()).ok, true);
  await f.assertPreserved();
});

test("default installation bootstraps an absent daemon and confirms it is running", async (t) => {
  const f = await fixture(t);
  const commandsFile = join(f.root, "codex-commands.jsonl");
  const startedFile = join(f.root, "daemon-started");
  await writeFile(join(f.bin, "codex"), `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
appendFileSync(process.env.FIXTURE_CODEX_COMMANDS, JSON.stringify(args) + "\\n");
if (args === "app-server daemon version") {
  if (!existsSync(process.env.FIXTURE_DAEMON_STARTED)) process.exit(1);
  console.log(JSON.stringify({ status: "running", socketPath: "/tmp/isolated-test-daemon.sock" }));
} else if (args === "app-server daemon start") writeFileSync(process.env.FIXTURE_DAEMON_STARTED, "running");
else if (!["login status", "app-server daemon bootstrap --help", "app-server daemon bootstrap"].includes(args)) process.exit(1);
`, { mode: 0o755 });
  const result = await run("bash", [join(f.app, "scripts/install-user.sh"), "--yes", "--loopback-only", "--port", String(f.port)], {
    cwd: f.root, env: { ...f.env, FIXTURE_CODEX_COMMANDS: commandsFile, FIXTURE_DAEMON_STARTED: startedFile },
  });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual((await readFile(commandsFile, "utf8")).trim().split("\n").map(JSON.parse), [
    "login status", "app-server daemon version", "app-server daemon bootstrap --help",
    "app-server daemon bootstrap", "app-server daemon start", "app-server daemon version",
  ]);
  assert.equal((await f.health()).ok, true);
});

test("an unrecognized successful daemon status does not trigger automatic bootstrap", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.stateFile, "utf8");
  await writeFile(join(f.bin, "codex"), `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "app-server daemon version") console.log(JSON.stringify({ status: "running", socketPath: {} }));
else if (args !== "login status") { console.error("UNEXPECTED_DAEMON_MUTATION"); process.exit(1); }
`, { mode: 0o755 });
  const result = await run("bash", [join(f.app, "scripts/install-user.sh"), "--yes", "--loopback-only", "--port", String(f.port)], { cwd: f.root, env: f.env });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Could not validate the running Codex daemon/);
  assert.doesNotMatch(result.output, /UNEXPECTED_DAEMON_MUTATION/);
  assert.deepEqual(f.commands, []);
  assert.equal(await readFile(f.stateFile, "utf8"), original);
  await f.assertPreserved();
});

test("failed Codex daemon bootstrap explains the supported existing-daemon path without changing services", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.bin, "codex"), `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "login status" || args === "app-server daemon bootstrap --help") process.exit(0);
console.error("managed standalone Codex install not found"); process.exitCode = 1;
`, { mode: 0o755 });
  const before = await readFile(f.stateFile, "utf8");
  const result = await run("bash", [join(f.app, "scripts/install-user.sh"), "--yes", "--loopback-only", "--port", String(f.port)], { cwd: f.root, env: f.env });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /managed standalone/);
  assert.match(result.output, /--skip-daemon-bootstrap/);
  assert.deepEqual(f.commands, [], "no PWA or proxy service changes after bootstrap failure");
  assert.equal(await readFile(f.stateFile, "utf8"), before);
  await f.assertPreserved();
});

test("ZIP update switches real HTTP processes and retains the complete previous tree", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.control("restart", "codex-pwa.service")).code, 0);
  const result = await f.update(await f.archive("1.0.1"));
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(await f.health(), { ok: true, version: "1.0.1" });
  const backups = (await readdir(f.root)).filter((name) => name.startsWith(".codex-pwa-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(JSON.parse(await readFile(join(f.root, backups[0], "package.json"), "utf8")).version, "1.0.0");
  await f.assertPreserved();
});

test("ZIP failures restore verified old runtime and preserve configuration", { concurrency: 4 }, async (t) => {
  await Promise.all([
    ["stale Service Worker", { staleWorker: true }],
    ["wrong running version", { runtimeVersion: "0.9.0" }],
    ["unhealthy HTTP reply", { healthOk: false }],
    ["service restart failure", { restartFailure: true }],
  ].map(([name, settings]) => t.test(name, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.control("restart", "codex-pwa.service")).code, 0);
    const result = await f.update(await f.archive("1.0.1", settings));
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Rollback completed/);
    assert.deepEqual(await f.health(), { ok: true, version: "1.0.0" });
    const failed = (await readdir(f.root)).filter((entry) => entry.startsWith(".codex-pwa-failed-"));
    assert.equal(failed.length, 1);
    await f.assertPreserved();
  })));
});

test("bad candidate tests and corrupt archives never replace the live installation", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.control("restart", "codex-pwa.service")).code, 0);
  for (const [settings, options] of [[{ checkFailure: true }, {}], [{}, { corrupt: true }]]) {
    const result = await f.update(await f.archive("1.0.1", settings, options));
    assert.notEqual(result.code, 0, result.output);
    assert.deepEqual(await f.health(), { ok: true, version: "1.0.0" });
    assert.equal(f.commands.filter((args) => args[1] === "restart").length, 1);
    await f.assertPreserved();
  }
});

test("rollback health failure is reported without claiming service recovery", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.control("restart", "codex-pwa.service")).code, 0);
  // The old running process remains healthy, but its next start will fail too.
  await writeFile(join(f.app, "fixture.json"), JSON.stringify({ restartFailure: true }));
  const result = await f.update(await f.archive("1.0.1", { restartFailure: true }));
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Previous files restored, but service health could not be confirmed/);
  assert.doesNotMatch(result.output, /Rollback completed/);
  assert.equal(JSON.parse(await readFile(join(f.app, "package.json"), "utf8")).version, "1.0.0");
  await f.assertPreserved();
});

test("updates within the same clock second keep distinct recoverable backups", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.bin, "date"), "#!/bin/sh\nprintf '20260101T000000Z\\n'\n", { mode: 0o755 });
  assert.equal((await f.control("restart", "codex-pwa.service")).code, 0);
  for (const version of ["1.0.1", "1.0.2"]) {
    const result = await f.update(await f.archive(version));
    assert.equal(result.code, 0, result.output);
    assert.equal((await f.health()).version, version);
  }
  const backups = (await readdir(f.root)).filter((name) => name.startsWith(".codex-pwa-backup-"));
  assert.equal(backups.length, 2);
  const versions = await Promise.all(backups.map(async (name) => JSON.parse(await readFile(join(f.root, name, "package.json"), "utf8")).version));
  assert.deepEqual(versions.sort(), ["1.0.0", "1.0.1"]);
});

test("an overlapping updater cannot replace the installation or restart its service", async (t) => {
  const f = await fixture(t);
  const archive = await f.archive("1.0.1");
  const holder = spawn("flock", [join(f.root, ".codex-pwa-update-installed app.lock"), process.execPath,
    "-e", 'console.log("locked"); setInterval(() => {}, 1000);',
  ], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  t.after(async () => {
    const exited = once(holder, "exit");
    process.kill(-holder.pid, "SIGTERM");
    await exited;
  });
  await once(holder.stdout, "data");
  const result = await f.update(archive);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Another update is already in progress/);
  assert.equal(f.commands.length, 0);
  assert.equal(JSON.parse(await readFile(join(f.app, "package.json"), "utf8")).version, "1.0.0");
});

test("Git update stages a fast-forward and preserves repository configuration and local files", async (t) => {
  const f = await gitFixture(t);
  await f.git(f.app, "remote", "set-url", "origin", "../upstream");
  await f.git(f.app, "config", "pwa.fixture", "preserved");
  await writeFile(join(f.app, ".local-instance"), "local deployment data\n");
  assert.equal((await f.control("restart", "codex-pwa.service")).code, 0);
  const result = await f.update();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(await f.health(), { ok: true, version: "1.0.1" });
  assert.equal(await f.git(f.app, "rev-parse", "HEAD"), f.candidateHead);
  assert.equal(await f.git(f.app, "remote", "get-url", "origin"), "../upstream");
  assert.equal(await f.git(f.app, "config", "pwa.fixture"), "preserved");
  assert.equal(await readFile(join(f.app, ".local-instance"), "utf8"), "local deployment data\n");
  const backups = (await readdir(f.root)).filter((name) => name.startsWith(".codex-pwa-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(await f.git(join(f.root, backups[0]), "rev-parse", "HEAD"), f.previousHead);
  await f.assertPreserved();
  const restarts = f.commands.filter((args) => args[1] === "restart").length;
  assert.equal((await f.update()).code, 0);
  assert.equal(f.commands.filter((args) => args[1] === "restart").length, restarts, "no restart when already current");
});

test("Git candidate failures preserve original checkout and verified runtime", { concurrency: 2 }, async (t) => {
  await Promise.all([
    ["candidate check", { checkFailure: true }],
    ["candidate service", { restartFailure: true }],
  ].map(([name, settings]) => t.test(name, async (t) => {
    const f = await gitFixture(t, settings);
    assert.equal((await f.control("restart", "codex-pwa.service")).code, 0);
    const result = await f.update();
    assert.notEqual(result.code, 0, result.output);
    assert.equal(await f.git(f.app, "rev-parse", "HEAD"), f.previousHead);
    assert.equal(JSON.parse(await readFile(join(f.app, "package.json"), "utf8")).version, "1.0.0");
    assert.deepEqual(await f.health(), { ok: true, version: "1.0.0" });
    assert.equal(await f.git(f.app, "status", "--porcelain"), "");
    await f.assertPreserved();
  })));
});

test("Git updates refuse dirty and divergent checkouts without restarting", async (t) => {
  const f = await gitFixture(t);
  assert.equal((await f.control("restart", "codex-pwa.service")).code, 0);
  await writeFile(join(f.app, "local-edit.txt"), "keep this work\n");
  let result = await f.update();
  assert.notEqual(result.code, 0);
  assert.match(result.output, /local changes/);
  assert.equal(await readFile(join(f.app, "local-edit.txt"), "utf8"), "keep this work\n");
  await f.git(f.app, "add", "local-edit.txt");
  await f.git(f.app, "commit", "-m", "Fixture local divergence");
  const localHead = await f.git(f.app, "rev-parse", "HEAD");
  result = await f.update();
  assert.notEqual(result.code, 0);
  assert.equal(await f.git(f.app, "rev-parse", "HEAD"), localHead);
  assert.equal(f.commands.filter((args) => args[1] === "restart").length, 1);
  assert.deepEqual(await f.health(), { ok: true, version: "1.0.0" });
});

test("Git updates detect edits made to the live checkout during candidate checks", async (t) => {
  const f = await gitFixture(t, { pauseCheck: true });
  f.env.FIXTURE_CHECK_STARTED = join(f.root, "check-started");
  f.env.FIXTURE_CHECK_RELEASE = join(f.root, "check-release");
  assert.equal((await f.control("restart", "codex-pwa.service")).code, 0);
  const updating = f.update();
  try {
    let started = false;
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try { started = (await readFile(f.env.FIXTURE_CHECK_STARTED, "utf8")) === "ready"; } catch {}
      if (started) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(started, true, "candidate should reach its check without moving the live tree");
    assert.equal(await f.git(f.app, "rev-parse", "HEAD"), f.previousHead);
    await writeFile(join(f.app, "late-local-edit.txt"), "preserve this new work\n");
  } finally { await writeFile(f.env.FIXTURE_CHECK_RELEASE, "continue"); }
  const result = await updating;
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /live checkout changed while testing/);
  assert.equal(await readFile(join(f.app, "late-local-edit.txt"), "utf8"), "preserve this new work\n");
  assert.equal(await f.git(f.app, "rev-parse", "HEAD"), f.previousHead);
  assert.equal(f.commands.filter((args) => args[1] === "restart").length, 1);
  assert.deepEqual(await f.health(), { ok: true, version: "1.0.0" });
});

test("Git linked worktrees remain at their original locations", async (t) => {
  const f = await gitFixture(t);
  const linked = join(f.root, "linked worktree");
  await f.git(f.app, "worktree", "add", "-b", "fixture-linked", linked);
  const result = await f.update();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /standalone Git checkout/);
  assert.equal(await f.git(linked, "rev-parse", "HEAD"), f.previousHead);
  assert.equal(await f.git(f.app, "rev-parse", "HEAD"), f.previousHead);
  assert.equal(f.commands.length, 0);
});

test("backup retention never prunes other installations or unclassified legacy backups", async (t) => {
  const f = await fixture(t);
  const legacy = Array.from({ length: 4 }, (_, i) => `.codex-pwa-backup-legacy-${i}`);
  for (const name of legacy) {
    await mkdir(join(f.root, name));
    await writeFile(join(f.root, name, "preserve.txt"), "unrelated deployment\n");
  }
  assert.equal((await f.control("restart", "codex-pwa.service")).code, 0);
  for (const version of ["1.0.1", "1.0.2", "1.0.3", "1.0.4"]) {
    const result = await f.update(await f.archive(version));
    assert.equal(result.code, 0, result.output);
  }
  const names = (await readdir(f.root)).filter((name) => name.startsWith(".codex-pwa-backup-"));
  assert.equal(names.filter((name) => !legacy.includes(name)).length, 3);
  for (const name of legacy) assert.equal(await readFile(join(f.root, name, "preserve.txt"), "utf8"), "unrelated deployment\n");
});
