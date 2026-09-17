// Explicit protocol probe: real CLI, ephemeral task, local inert model endpoint.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export async function verifyMessageIdentity(executable) {
  const scratch = await mkdtemp(join(tmpdir(), "pwa-message-identity-"));
  const pending = new Map();
  const messages = [];
  let child, closed, reader, sequence = 0, providerRequests = 0;
  const provider = createServer((request, response) => {
    providerRequests += 1;
    // Discard prompts/headers. No external model, generated text or tools.
    request.resume();
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(": waiting for the protocol probe to interrupt\n\n");
  });
  const rpc = (method, params) => new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    const finish = (error, value) => {
      clearTimeout(timer);
      pending.delete(id);
      if (error) reject(error); else resolveRequest(value);
    };
    const timer = setTimeout(() => finish(new Error(`RPC timeout: ${method}`)), 45_000);
    pending.set(id, finish);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await new Promise((ready) => provider.listen(0, "127.0.0.1", ready));
    for (const name of ["state", "logs", "project"]) await mkdir(join(scratch, name), { mode: 0o700 });
    const config = {
      sqlite_home: join(scratch, "state"), log_dir: join(scratch, "logs"),
      "history.persistence": "none", "analytics.enabled": false, check_for_update_on_startup: false,
      model_provider: "pwa_identity_probe", model: "pwa-protocol-probe",
      "model_providers.pwa_identity_probe.name": "Local protocol probe",
      "model_providers.pwa_identity_probe.base_url": `http://127.0.0.1:${provider.address().port}/v1`,
      "model_providers.pwa_identity_probe.wire_api": "responses",
      "model_providers.pwa_identity_probe.requires_openai_auth": false,
      "model_providers.pwa_identity_probe.request_max_retries": 0,
      "model_providers.pwa_identity_probe.stream_max_retries": 0,
    };
    child = spawn(executable, ["app-server", "--listen", "stdio://", "--strict-config",
      ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    ], { cwd: join(scratch, "project"), stdio: ["pipe", "pipe", "ignore"] });
    // Resolve on close even when spawn fails; no unhandled rejection in cleanup.
    closed = new Promise((done) => child.once("close", done));
    child.on("error", () => { for (const finish of pending.values()) finish(new Error("CLI could not start")); });
    child.on("close", () => { for (const finish of pending.values()) finish(new Error("CLI exited during the probe")); });
    child.stdin.on("error", () => { for (const finish of pending.values()) finish(new Error("CLI input closed")); });
    reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (Object.hasOwn(message, "id") && pending.has(message.id)) {
        // Do not print upstream error bodies, paths, user-agent or credentials.
        pending.get(message.id)(message.error ? new Error(`RPC rejected (${message.error.code})`) : null, message.result);
      } else if (message.params?.item?.type === "userMessage") {
        messages.push(message.params.item);
        if (messages.length > 16) messages.shift();
      }
    });
    const init = await rpc("initialize", { clientInfo: { name: "pwa_protocol_probe", version: "1.0.0" },
      capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const started = await rpc("thread/start", { cwd: join(scratch, "project"), ephemeral: true,
      modelProvider: "pwa_identity_probe", model: "pwa-protocol-probe", approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: "Protocol probe. No tools.", developerInstructions: "Protocol probe. No tools." });
    assert.equal(started.thread.ephemeral, true);
    assert.equal(started.thread.modelProvider, "pwa_identity_probe");
    const marker = "pwa-probe-message-correlation-0001";
    const result = await rpc("turn/start", { threadId: started.thread.id, clientUserMessageId: marker,
      input: [{ type: "text", text: "protocol identity probe" }] });
    const deadline = Date.now() + 10_000;
    while (!messages.length && Date.now() < deadline) await delay(20);
    assert.ok(messages.length, "Codex must emit a user message");
    assert.equal(messages[0].clientId, marker);
    const read = await rpc("thread/read", { threadId: started.thread.id, includeTurns: false });
    await rpc("turn/interrupt", { threadId: started.thread.id, turnId: result.turn.id });
    return { version: init.userAgent?.match(/\d+\.\d+\.\d+/)?.[0], ephemeral: read.thread.ephemeral,
      notificationClientIdMatchesInput: true, historyReadAvailable: false, providerRequests,
      messageFields: Object.keys(messages[0]).sort(), threadFields: Object.keys(read.thread).sort(),
      canAcceptDirectInput: read.thread.canAcceptDirectInput };
  } finally {
    reader?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await closed; } finally { clearTimeout(kill); }
    }
    provider.closeAllConnections();
    if (provider.listening) { const closing = once(provider, "close"); provider.close(); await closing; }
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length < 3) throw new Error("Usage: node scripts/verify-message-identity.mjs CLI [CLI ...]");
    for (const executable of process.argv.slice(2)) console.log(JSON.stringify(await verifyMessageIdentity(executable)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
