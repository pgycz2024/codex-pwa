// Explicit, isolated CLI acceptance. Never runs automatically with node --test.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const contracts = ["v1/InitializeResponse.json", "ServerRequest.json", "ServerNotification.json", "ClientRequest.json",
  "CommandExecutionRequestApprovalParams.json", "FileChangeRequestApprovalParams.json", "ExecCommandApprovalParams.json",
  "ApplyPatchApprovalParams.json", "v2/ThreadItemsListParams.json"];

export async function verifyCliCompatibility(executable, { sqliteDirectory = null } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "pwa-cli-acceptance-"));
  const schemaDir = join(scratch, "schema"), project = join(scratch, "project"), sqlite = sqliteDirectory || join(scratch, "sqlite");
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 90_000);
  const onSignal = () => abort.abort();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  let child, closed;
  try {
    const { stdout } = await exec(executable, ["--version"], { timeout: 5000, signal: abort.signal });
    const version = stdout.match(/^codex-cli (\d+\.\d+\.\d+)\b/)?.[1];
    assert.ok(version, "CLI must report a semantic version");
    await exec(executable, ["app-server", "generate-json-schema", "--experimental", "--out", schemaDir], {
      timeout: 15_000, maxBuffer: 1024 * 1024, signal: abort.signal,
    });
    const schemas = {}, hashes = {};
    for (const name of contracts) {
      const bytes = await readFile(join(schemaDir, name));
      schemas[name] = JSON.parse(bytes);
      hashes[name] = digest(bytes);
    }
    const methods = (name) => schemas[name].oneOf.map((entry) => entry.properties.method.enum[0]).sort();
    const fields = (name) => ({ required: schemas[name].required || [], fields: Object.keys(schemas[name].properties || {}) });
    const clientMethods = methods("ClientRequest.json"), serverMethods = methods("ServerRequest.json"), notifications = methods("ServerNotification.json");
    for (const method of ["initialize", "thread/list", "thread/read", "thread/turns/list", "model/list", "turn/start", "turn/steer", "turn/interrupt"]) {
      assert.ok(clientMethods.includes(method), `Missing PWA client method: ${method}`);
    }
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "execCommandApproval", "applyPatchApproval"]) {
      assert.ok(serverMethods.includes(method), `Missing supported server request: ${method}`);
    }
    for (const method of ["serverRequest/resolved", "item/started", "item/completed", "item/fileChange/patchUpdated", "turn/started", "turn/completed"]) {
      assert.ok(notifications.includes(method), `Missing recovery notification: ${method}`);
    }
    assert.ok(schemas["CommandExecutionRequestApprovalParams.json"].properties.availableDecisions);
    for (const directory of [project, sqlite, join(scratch, "logs")]) await mkdir(directory, { mode: 0o700, recursive: true });
    const previousDatabaseFiles = (await readdir(sqlite)).filter((name) => name.endsWith(".sqlite")).length;
    // Keep HOME/CODEX_HOME and user credentials intact. State and logs are
    // redirected with documented command-line overrides, not saved config.
    const wrapper = join(scratch, "isolated-codex");
    const flags = ["--strict-config", "-c", `sqlite_home=${JSON.stringify(sqlite)}`, "-c", `log_dir=${JSON.stringify(join(scratch, "logs"))}`,
      "-c", 'history.persistence="none"', "-c", "analytics.enabled=false", "-c", "check_for_update_on_startup=false"];
    await writeFile(wrapper, `#!/usr/bin/env bash\nexec ${quote(executable)} "$@" ${flags.map(quote).join(" ")}\n`, { mode: 0o700 });
    await chmod(wrapper, 0o700);
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEX_PWA_")));
    child = spawn(process.execPath, ["--unhandled-rejections=strict", "server.mjs"], { cwd: source, stdio: ["ignore", "ignore", "ignore"], env: {
      ...inherited, NODE_ENV: "test", CODEX_BIN: wrapper, CODEX_PWA_APP_SERVER_MODE: "isolated",
      CODEX_PWA_PORT: String(port), CODEX_PWA_HOST: "127.0.0.1", CODEX_PWA_ROOTS: project,
      CODEX_PWA_PASSWORD_FILE: "", CODEX_PWA_USERNAME_FILE: "", CODEX_PWA_SESSION_FILE: join(scratch, "devices.json"),
      CODEX_PWA_ROOTS_FILE: join(scratch, "roots.json"), CODEX_PWA_EVENT_REPLAY_FILE: join(scratch, "events.jsonl"),
      CODEX_PWA_TASK_RECOVERY_FILE: join(scratch, "recovery.json"), CODEX_PWA_PUSH_CONFIG_FILE: "",
      CODEX_PWA_PUSH_STORE_FILE: join(scratch, "push.json"),
    } });
    closed = once(child, "close");
    const request = (path) => fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
    let ready = false;
    for (let attempt = 0; attempt < 800; attempt += 1) {
      abort.signal.throwIfAborted();
      assert.equal(child.exitCode, null, "isolated PWA exited before CLI initialization");
      try { ready = (await (await request("/api/health")).json()).bridge === "ready"; } catch {}
      if (ready) break;
      await delay(50, undefined, { signal: abort.signal });
    }
    assert.ok(ready, `CLI ${version} did not initialize through the PWA bridge`);
    const status = await (await request("/api/status")).json();
    assert.equal(status.protocol.cliVersion, version);
    assert.equal(status.protocol.appServerVersion, version);
    assert.deepEqual(status.activeTurns, {});
    assert.deepEqual(status.pendingApprovals, []);
    assert.deepEqual(status.ownedThreads, []);
    const modelsResponse = await request("/api/models");
    assert.equal(modelsResponse.status, 200, "actual CLI model/list through HTTP");
    const models = await modelsResponse.json();
    assert.ok(Array.isArray(models.data));
    assert.ok((await readdir(sqlite)).some((name) => name.endsWith(".sqlite")), "CLI must create its database in the isolated directory");
    return { version, schemaHashes: hashes, clientMethods, serverMethods, notifications,
      initialize: fields("v1/InitializeResponse.json"),
      approvals: Object.fromEntries(contracts.filter((name) => name.endsWith("ApprovalParams.json")).map((name) => [name, fields(name)])),
      runtime: { bridge: "ready", cliVersion: status.protocol.cliVersion, appServerVersion: status.protocol.appServerVersion,
        protocolVersion: status.protocol.protocolVersion, advertisedCapabilities: status.protocol.advertisedCapabilities,
        modelCount: models.data.length, isolatedStateDatabase: true, previousDatabaseFiles },
    };
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await closed; } finally { clearTimeout(kill); }
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let upgradeDirectory;
  try {
    if (process.argv.length < 3) throw new Error("Usage: node scripts/verify-cli-compatibility.mjs CLI [CLI ...]");
    upgradeDirectory = await mkdtemp(join(tmpdir(), "pwa-cli-upgrade-"));
    for (const executable of process.argv.slice(2)) console.log(JSON.stringify(await verifyCliCompatibility(executable,
      { sqliteDirectory: join(upgradeDirectory, "state") })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { if (upgradeDirectory) await rm(upgradeDirectory, { recursive: true, force: true }); }
}
