import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer as createNetServer } from "node:net";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findPendingUserMessageIndex,
  normalizeUserMessageText,
  reconcilePendingUserMessage,
} from "../public/message-reconcile.js";
import {
  chronologicalTurns,
  countDiffLines,
  nextDiffChunkEnd,
} from "../public/history-utils.js";
import { createMathExtensions } from "../public/markdown-math.js";
import { filePreviewHref, fileRawHref, normalizeMarkdownFileLinks, serverFilePath } from "../public/file-links.js";
import { Marked } from "marked";
import {
  contentDisposition,
  filePresentation,
  isCanonicalPathWithinRoots,
  isPathWithinRoots,
  parseByteRange,
} from "../file-access.mjs";
import { numberedUploadFilename, safeUploadFilename } from "../upload-utils.mjs";
import { appendUploadedFileReferences, formatUploadSize } from "../public/upload-utils.js";
import { directoryBreadcrumbs, validateDirectoryName } from "../directory-utils.mjs";
import { DEVICE_COOKIE, LoginRateLimiter, deviceCookie, parseCookies } from "../auth-store.mjs";
import {
  mergeThreadSettings,
  parseSettingsOverrides,
  permissionPresetFromSettings,
  serializeThreadSettings,
  threadStartPermission,
} from "../thread-settings.mjs";
import { inferClientOrigin, narrativeHistoryTurn } from "../thread-history.mjs";
import {
  decodedBase64Size,
  imagePresentationFromBase64,
  listRolloutArtifacts,
  readRolloutArtifact,
  scanRolloutArtifacts,
} from "../artifact-store.mjs";
import { readStoredStringArray } from "../public/storage-utils.js";
import { boundedWindow, fixedVirtualRange } from "../public/virtual-list.js";
import { modelDisplayName, resolveModel } from "../public/model-display.js";
import { parseEnvironmentFile } from "../scripts/read-env.mjs";

const projectDirectory = dirname(fileURLToPath(new URL("../server.mjs", import.meta.url)));

test("package, server, and documentation share one application version", async () => {
  const [manifest, server, readme] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  assert.equal(manifest.version, "0.18.9");
  assert.match(server, /APP_VERSION = JSON\.parse\(readFileSync\(join\(here, "package\.json"\)/);
  assert.doesNotMatch(server, /APP_VERSION = "\d+\.\d+\.\d+"/);
  assert.ok(readme.includes(`当前版本为 \`${manifest.version}\``));
});

test("login rate limiting isolates ordinary clients while retaining a bounded key set", () => {
  const limiter = new LoginRateLimiter({ maxFailures: 2, windowMs: 1_000, maxKeys: 2 });
  limiter.recordFailure("phone-a", 0);
  limiter.recordFailure("phone-a", 10);
  assert.equal(limiter.retryAfterSeconds("phone-a", 20), 1);
  assert.equal(limiter.retryAfterSeconds("phone-b", 20), 0);
  limiter.reset("phone-a");
  assert.equal(limiter.retryAfterSeconds("phone-a", 20), 0);
  limiter.recordFailure("phone-b", 20);
  limiter.recordFailure("phone-c", 20);
  limiter.recordFailure("phone-d", 20);
  assert.ok(limiter.failures.size <= 2);
});

async function reserveLocalPort() {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

async function waitForHttp(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Timed out waiting for the test server");
}

async function rawHttpRequest(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", reject);
  });
}

test("corrupt legacy browser state falls back without preventing startup", () => {
  const values = new Map([["pins", "{broken"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
  };
  assert.deepEqual(readStoredStringArray(storage, "pins"), []);
  assert.equal(values.has("pins"), false);
  values.set("pins", JSON.stringify(["thread-1", 42, "thread-2"]));
  assert.deepEqual(readStoredStringArray(storage, "pins"), ["thread-1", "thread-2"]);
});

test("history virtualization bounds DOM-sized windows for very long tasks", () => {
  assert.deepEqual(boundedWindow(12_500, 160), { start: 12_340, end: 12_500, enabled: true });
  assert.deepEqual(boundedWindow(12_500, 160, 4_000), { start: 4_000, end: 4_160, enabled: true });
  assert.deepEqual(boundedWindow(20, 160), { start: 0, end: 20, enabled: false });
  assert.deepEqual(fixedVirtualRange({
    total: 12_500, scrollTop: 5_800, rowHeight: 58, viewportHeight: 580, overscan: 12,
  }), { start: 88, end: 122 });
});

test("environment-file parser treats shell syntax as inert data", () => {
  const parsed = parseEnvironmentFile([
    'CODEX_PWA_PORT="4177"',
    'CODEX_PWA_INSTANCE_NAME="$(touch /tmp/never-run)"',
    'CODEX_PWA_NETWORK_LABEL="literal `command`"',
    'UNRELATED_SECRET="ignored"',
  ].join("\n"));
  assert.equal(parsed.get("CODEX_PWA_PORT"), "4177");
  assert.equal(parsed.get("CODEX_PWA_INSTANCE_NAME"), "$(touch /tmp/never-run)");
  assert.equal(parsed.get("CODEX_PWA_NETWORK_LABEL"), "literal `command`");
  assert.equal(parsed.has("UNRELATED_SECRET"), false);
});

test("PWA manifest is valid JSON and standalone", async () => {
  const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
});

test("distribution build uses per-user runtime defaults instead of personal paths and addresses", async () => {
  const [server, app, html, unit] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../systemd/codex-pwa.service", import.meta.url), "utf8"),
  ]);
  for (const source of [server, app, html, unit]) {
    assert.doesNotMatch(source, /\/home\/dell/);
    assert.doesNotMatch(source, /172\.16\.2\.53/);
  }
  assert.match(server, /process\.env\.HOME \|\| process\.cwd\(\)/);
  assert.match(server, /CODEX_PWA_INSTANCE_NAME/);
  assert.match(server, /CODEX_PWA_NETWORK_LABEL/);
  assert.match(html, /id="instanceName"/);
  assert.match(html, /id="networkLabel"/);
  assert.match(app, /status\.instanceName/);
  assert.match(app, /status\.networkLabel/);
});

test("doctor supports legacy inline service environments", async () => {
  const doctor = await readFile(new URL("../scripts/doctor.sh", import.meta.url), "utf8");
  assert.match(doctor, /systemctl --user show codex-pwa\.service/);
  assert.match(doctor, /legacy inline codex-pwa\.service environment/);
  assert.match(doctor, /while IFS=\$'\\t' read -r name value/);
  assert.doesNotMatch(doctor, /eval \"unit_assignments=/);
  assert.doesNotMatch(doctor, /source \"\$env_file\"/);
  assert.match(doctor, /api\/health/);
});

test("ZIP distribution excludes Git history and has atomic update and compatible uninstall paths", async () => {
  const [release, update, uninstall, publish, releaseWorkflow] = await Promise.all([
    readFile(new URL("../scripts/make-release.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/update-user.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/uninstall-user.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/publish-mirror.sh", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  ]);
  assert.match(release, /codex-pwa-\$tag\.zip/);
  assert.match(release, /codex-pwa-\$tag-clean-git\.bundle/);
  assert.match(release, /RELEASE-MANIFEST\.sha256/);
  assert.match(release, /git -C "\$package_root" init -q -b main/);
  assert.match(release, /git -C "\$package_root" bundle create/);
  assert.match(release, /bundle create "\$bundle" HEAD main "\$tag"/);
  assert.doesNotMatch(release, /git bundle create --all/);
  assert.match(release, /git status --porcelain --untracked-files=all/);
  assert.match(release, /tag %s must exist and point to HEAD/);
  assert.match(release, /sha256sum "\$\(basename -- "\$archive"\)"/);
  assert.match(release, /possible %s found in/);
  assert.match(release, /symbolic links are not allowed/);
  assert.match(update, /--zip/);
  assert.match(update, /Candidate health check failed; restoring the previous version/);
  assert.match(update, /mv -- \"\$backup\" \"\$app_dir\"/);
  assert.match(update, /\/api\/health/);
  assert.match(update, /resolve_health_port/);
  assert.match(update, /systemctl --user show codex-pwa\.service/);
  assert.match(update, /port=\$\(resolve_health_port \|\| true\)/);
  assert.match(update, /prune_old_backups/);
  assert.match(uninstall, /codex-pwa-private\.service/);
  assert.match(uninstall, /codex-pwa-pgy\.socket/);
  assert.match(uninstall, /codex-pwa-pgy\.service/);
  assert.match(publish, /npm run release:local/);
  assert.match(publish, /rsync -a --delete --exclude='\/\.git\/'/);
  assert.match(publish, /git -C "\$mirror" push --atomic origin main "\$tag"/);
  assert.doesNotMatch(publish, /push .*--force/);
  assert.match(releaseWorkflow, /permissions:\s*\n\s*contents: write/);
  assert.match(releaseWorkflow, /npm run release:local/);
  assert.match(releaseWorkflow, /gh release create/);
});

test("ZIP updater resolves the health port from a legacy inline systemd environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-update-port-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const fakeSystemctl = join(bin, "systemctl");
  await writeFile(fakeSystemctl, "#!/usr/bin/env bash\nprintf '%s\\n' 'NODE_ENV=production CODEX_PWA_PORT=4266 CODEX_PWA_ROOTS=/srv/example'\n");
  await chmod(fakeSystemctl, 0o755);
  const child = spawn("bash", [join(projectDirectory, "scripts", "update-user.sh"), "--health-port"], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      // setup-node installs Node outside /usr/bin on GitHub-hosted runners.
      // Preserve the running Node binary while keeping the fake systemctl first.
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "4266");
});

test("service worker excludes API requests from cache handling", async () => {
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(source, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /ASSET_PATHS/);
  assert.match(source, /!navigation && !ASSET_PATHS\.has/);
  assert.match(source, /url\.pathname !== "\/file-preview\.html"/);
  assert.match(source, /cached \|\| Response\.error\(\)/);
  assert.doesNotMatch(source, /cache\.put\(event\.request/);
});

test("trusted-device cookie and parser use a strict HttpOnly 90-day boundary", () => {
  const header = deviceCookie("opaque token", { remember: true });
  assert.match(header, new RegExp(`^${DEVICE_COOKIE}=`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=7776000/);
  assert.equal(parseCookies(`${DEVICE_COOKIE}=opaque%20token; theme=dark`)[DEVICE_COOKIE], "opaque token");
  assert.match(deviceCookie("", { clear: true }), /Max-Age=0/);
});

test("per-task settings preserve effective values until an explicit next-turn override", () => {
  const effective = serializeThreadSettings({
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: {
      type: "workspaceWrite", writableRoots: [], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false,
    },
  });
  assert.equal(effective.permissionPreset, "request");
  const overrides = parseSettingsOverrides({ effort: "xhigh", permissionPreset: "auto" }, effective);
  assert.equal(overrides.rpc.effort, "xhigh");
  assert.equal(overrides.rpc.approvalsReviewer, "auto_review");
  assert.equal(overrides.rpc.sandboxPolicy.type, "workspaceWrite");
  const merged = mergeThreadSettings(effective, overrides.applied);
  assert.equal(merged.permissionPreset, "auto");
  assert.equal(merged.effort, "xhigh");
  assert.deepEqual(threadStartPermission("full"), {
    approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access",
  });
  assert.equal(permissionPresetFromSettings({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }), "full");
});

test("task settings retain models that are missing from the catalog", async () => {
  const nested = serializeThreadSettings({
    thread: {
      model: "gpt-6-astra",
      reasoningEffort: "xhigh",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite", writableRoots: [] },
    },
  });
  assert.equal(nested.model, "gpt-6-astra");
  assert.equal(nested.effort, "xhigh");
  assert.equal(nested.permissionPreset, "request");
  assert.equal(modelDisplayName("gpt-6-astra"), "GPT6-Astra");
  assert.equal(modelDisplayName("gpt-5.6-sol"), "GPT5.6-Sol");
  const resolved = resolveModel("gpt-6-astra", [{
    model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true,
  }]);
  assert.equal(resolved.model, "gpt-6-astra");
  assert.equal(resolved.displayName, "GPT6-Astra");
  assert.equal(resolveModel("", [{ model: "gpt-5.6-sol", isDefault: true }]).model, "gpt-5.6-sol");
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /el\("option", "", effortLabel\(selectedValue\)\)/);
});

test("active narrative keeps complete text while omitting heavy tool activity", () => {
  const turn = narrativeHistoryTurn({
    id: "turn-1",
    items: [
      { id: "u", type: "userMessage", text: "开始" },
      { id: "a1", type: "agentMessage", text: "中间输出 1" },
      { id: "cc", type: "ContextCompaction" },
      { id: "c", type: "commandExecution", aggregatedOutput: "large" },
      { id: "r", type: "reasoning", summary: ["分析"] },
      { id: "r2", type: "reasoning", content: ["继续分析"] },
      { id: "a2", type: "agentMessage", text: "中间输出 2" },
      { id: "f", type: "fileChange", changes: [] },
    ],
  });
  assert.deepEqual(turn.items.filter((item) => item.type === "agentMessage").map((item) => item.text), ["中间输出 1", "中间输出 2"]);
  assert.equal(turn.items.some((item) => item.type === "commandExecution"), false);
  assert.equal(turn.items.filter((item) => item.type === "reasoning").length, 1);
  assert.equal(turn.items.find((item) => item.type === "reasoning").mergedReasoningItems, 2);
  assert.equal(turn.items.some((item) => item.type === "ContextCompaction"), true);
  assert.equal(turn.items.some((item) => item.type === "historyNotice"), true);
});

test("task creation sources distinguish Windows, mobile Web, CLI, and subagents", () => {
  assert.equal(inferClientOrigin({ source: "vscode" }, "Codex Desktop"), "windows");
  assert.equal(inferClientOrigin({ source: "vscode", threadSource: "codex-pwa-mobile" }, "Codex Desktop"), "mobile-web");
  assert.equal(inferClientOrigin({ source: "cli" }, "codex-tui"), "cli");
  assert.equal(inferClientOrigin({ source: { subAgent: {} }, parentThreadId: "parent" }), "subagent");
});

test("Markdown renderer recognizes LaTeX and GFM tables without touching code spans", () => {
  const parser = new Marked({ breaks: true, gfm: true });
  parser.use({
    extensions: createMathExtensions((tex, displayMode) => (
      `<${displayMode ? "div" : "span"} class="math-test">${tex}</${displayMode ? "div" : "span"}>`
    )),
  });
  const html = parser.parse([
    "行内公式 \\(G_{ae}\\) 与 \\(T_a,T_i,T_o,T_e\\)。",
    "",
    "\\[",
    "\\boxed{\\partial_t \\mathbf{u} + \\nabla p = 0}",
    "\\]",
    "",
    "| 变量 | 含义 |",
    "| :--- | ---: |",
    "| \\(T_a\\) | 环境温度 |",
    "",
    "代码 `\\(not_math\\)` 不应渲染。",
  ].join("\n"));

  assert.match(html, /<table>/);
  assert.match(html, /<th[^>]*>变量<\/th>/);
  assert.match(html, /<div class="math-test">\\boxed/);
  assert.equal((html.match(/class="math-test"/g) || []).length, 4);
  assert.match(html, /<code>\\\(not_math\\\)<\/code>/);
});

test("PWA locally serves and caches Markdown and KaTeX assets", async () => {
  const [server, worker, html] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(server, /node_modules[\s\S]*marked[\s\S]*dompurify[\s\S]*katex/);
  assert.match(server, /"\.woff2": "font\/woff2"/);
  assert.match(worker, /\/markdown-math\.js/);
  assert.match(worker, /\/vendor\/katex\/katex\.mjs/);
  assert.match(html, /\/vendor\/katex\/katex\.min\.css/);
});

test("server file links become authenticated preview links only inside allowed roots", () => {
  const path = "/srv/example/research/paper/main.pdf";
  assert.equal(serverFilePath(path, ["/srv/example"]), path);
  assert.equal(serverFilePath(`file://${encodeURI(path)}`, ["/srv/example"]), path);
  assert.equal(serverFilePath("sandbox:/srv/example/paper/main.pdf", ["/srv/example"]), "/srv/example/paper/main.pdf");
  assert.equal(serverFilePath("/srv/example-other/private.pdf", ["/srv/example"]), null);
  assert.equal(serverFilePath("https://example.com/main.pdf", ["/srv/example"]), null);
  assert.equal(filePreviewHref(path), `/file-preview.html?path=${encodeURIComponent(path)}`);
  assert.equal(fileRawHref(path), `/api/files/raw?path=${encodeURIComponent(path)}`);
});

test("Markdown local-file links remain clickable when paths contain spaces or parentheses", () => {
  const source = [
    "[研究 PDF](/srv/example/research (copy 1)/paper/main file.pdf)",
    "[file](file:///srv/example/research (copy 1)/paper/main file.pdf)",
    "[sandbox](sandbox:/srv/example/research (copy 1)/paper/main file.pdf)",
    "```text",
    "[不要改写](/srv/example/research (copy 1)/paper/main file.pdf)",
    "```",
  ].join("\n");
  const normalized = normalizeMarkdownFileLinks(source);
  assert.match(normalized, /\[研究 PDF\]\(\/srv\/example\/research%20%28copy%201%29\/paper\/main%20file\.pdf\)/);
  assert.match(normalized, /\[file\]\(\/srv\/example\/research%20%28copy%201%29\/paper\/main%20file\.pdf\)/);
  assert.match(normalized, /\[sandbox\]\(\/srv\/example\/research%20%28copy%201%29\/paper\/main%20file\.pdf\)/);
  assert.match(normalized, /\[不要改写\]\(\/srv\/example\/research \(copy 1\)\/paper\/main file\.pdf\)/);
  const html = new Marked({ breaks: true, gfm: true }).parse(normalized);
  assert.equal((html.match(/<a href=/g) || []).length, 3);
  assert.match(html, /<a href="\/srv\/example\/research%20%28copy%201%29\/paper\/main%20file\.pdf">研究 PDF<\/a>/);
});

test("remote file access helpers enforce roots, safe types, and single byte ranges", () => {
  assert.equal(isPathWithinRoots("/srv/example/project/file.pdf", ["/srv/example"]), true);
  assert.equal(isPathWithinRoots("/srv/example/../../etc/passwd", ["/srv/example"]), false);
  assert.deepEqual(parseByteRange("bytes=0-99", 500), { kind: "range", start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-100", 500), { kind: "range", start: 400, end: 499 });
  assert.deepEqual(parseByteRange("bytes=900-", 500), { kind: "invalid" });
  assert.equal(filePresentation("paper.pdf").previewKind, "pdf");
  assert.equal(filePresentation("payload.html").previewKind, "download");
  assert.match(contentDisposition("/srv/example/研究.pdf", false), /^inline;[^\r\n]+filename\*=UTF-8''/);
});

test("canonical root checks reject symlink escapes while allowing deleted in-root task directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-root-test-"));
  const outside = await mkdtemp(join(tmpdir(), "codex-pwa-outside-test-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await symlink(outside, join(root, "outside-link"));
  assert.equal(await isCanonicalPathWithinRoots(join(root, "outside-link"), [root]), false);
  assert.equal(await isCanonicalPathWithinRoots(join(root, "outside-link", "missing"), [root], { allowMissing: true }), false);
  assert.equal(await isCanonicalPathWithinRoots(join(root, "deleted-project"), [root], { allowMissing: true }), true);
  assert.equal(await isCanonicalPathWithinRoots("relative/project", [root], { allowMissing: true }), false);
});

test("image-generation artifacts are recovered from rollout JSONL without exposing base64 metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-artifact-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rollout = join(root, "rollout-test.jsonl");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
  await writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-08-09T00:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ timestamp: "2026-08-09T00:00:01Z", type: "response_item", payload: { type: "image_generation_call", id: "image-1", status: "generating", revised_prompt: "mountain", result: png } }),
  ].join("\n"));
  assert.equal(decodedBase64Size(png), 12);
  assert.equal(imagePresentationFromBase64(png).mimeType, "image/png");
  const artifacts = await listRolloutArtifacts(rollout);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].turnId, "turn-1");
  assert.equal(artifacts[0].byteLength, 12);
  assert.equal(Object.hasOwn(artifacts[0], "result"), false);
  const recovered = await readRolloutArtifact(rollout, "image-1");
  assert.deepEqual(recovered.buffer, Buffer.from(png, "base64"));

  const initialScan = await scanRolloutArtifacts(rollout);
  await appendFile(rollout, `\n${JSON.stringify({ timestamp: "2026-08-09T00:01:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } })}\n${JSON.stringify({ timestamp: "2026-08-09T00:01:01Z", type: "response_item", payload: { type: "image_generation_call", id: "image-2", result: png } })}`);
  const incrementalScan = await scanRolloutArtifacts(rollout, {
    start: initialScan.scannedBytes,
    artifacts: initialScan.artifacts,
    activeTurnId: initialScan.activeTurnId,
  });
  assert.deepEqual(incrementalScan.artifacts.map((artifact) => artifact.id), ["image-1", "image-2"]);
  assert.equal(incrementalScan.artifacts[1].turnId, "turn-2");
  assert.ok(incrementalScan.scannedBytes > initialScan.scannedBytes);

  const thirdLine = JSON.stringify({
    timestamp: "2026-08-09T00:02:01Z",
    type: "response_item",
    payload: { type: "image_generation_call", id: "image-3", result: png },
  });
  const splitAt = Math.floor(thirdLine.length / 2);
  await appendFile(rollout, `\n${thirdLine.slice(0, splitAt)}`);
  const partialScan = await scanRolloutArtifacts(rollout, {
    start: incrementalScan.scannedBytes,
    artifacts: incrementalScan.artifacts,
    activeTurnId: incrementalScan.activeTurnId,
  });
  assert.deepEqual(partialScan.artifacts.map((artifact) => artifact.id), ["image-1", "image-2"]);
  assert.ok(partialScan.scannedBytes < partialScan.size, "unterminated JSON must remain eligible for rescan");
  await appendFile(rollout, `${thirdLine.slice(splitAt)}\n`);
  const completedScan = await scanRolloutArtifacts(rollout, {
    start: partialScan.scannedBytes,
    artifacts: partialScan.artifacts,
    activeTurnId: partialScan.activeTurnId,
  });
  assert.deepEqual(completedScan.artifacts.map((artifact) => artifact.id), ["image-1", "image-2", "image-3"]);
  assert.equal(completedScan.scannedBytes, completedScan.size);
});

test("file preview uses a realpath-checked API and local PDF.js worker", async () => {
  const [server, app, worker, preview] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/file-preview.js", import.meta.url), "utf8"),
  ]);
  assert.match(server, /resolveAllowedFile[\s\S]*await realpath\(candidate\)[\s\S]*isAllowedPath\(actual\)/);
  assert.match(server, /\/api\/files\/raw/);
  assert.match(server, /content-range/);
  assert.match(app, /serverFilePath[\s\S]*filePreviewHref/);
  assert.match(app, /image\.src\s*=\s*fileRawHref\(localPath\)/);
  assert.match(app, /suppressRedundantGeneratedArtifacts/);
  assert.match(worker, /\/file-preview\.js/);
  assert.match(preview, /pdf\.worker\.mjs/);
  assert.match(preview, /IntersectionObserver/);
  assert.match(preview, /PDF_PAGE_BATCH_SIZE = 100/);
  assert.match(preview, /appendPdfPageBatch/);
});

test("upload filenames are flattened, bounded, and never overwrite by name", () => {
  assert.equal(safeUploadFilename("../../实验数据.csv"), "实验数据.csv");
  assert.equal(safeUploadFilename("..\\..\\notes.txt"), "notes.txt");
  assert.equal(safeUploadFilename("..."), "uploaded-file");
  assert.ok(Buffer.byteLength(safeUploadFilename(`${"数".repeat(200)}.csv`)) <= 180);
  assert.equal(numberedUploadFilename("results.csv", 0), "results.csv");
  assert.equal(numberedUploadFilename("results.csv", 1), "results-2.csv");
});

test("uploaded files are appended to prompts as relative workspace references", () => {
  const prompt = appendUploadedFileReferences("请分析这些数据", [
    { relativePath: "experiment.csv" },
    { relativePath: "图片/样品.png" },
    { relativePath: "experiment.csv" },
  ]);
  assert.match(prompt, /^请分析这些数据/);
  assert.match(prompt, /- `experiment\.csv`/);
  assert.match(prompt, /- `图片\/样品\.png`/);
  assert.equal((prompt.match(/experiment\.csv/g) || []).length, 1);
  assert.equal(formatUploadSize(1024), "1.0 KB");
});

test("directory names and breadcrumbs are normalized safely", () => {
  assert.deepEqual(validateDirectoryName("  新项目  "), { ok: true, name: "新项目" });
  for (const invalid of ["", ".", "..", "nested/path", "nested\\path", "bad\u0000name"]) {
    assert.equal(validateDirectoryName(invalid).ok, false);
  }
  assert.equal(validateDirectoryName("数".repeat(100)).ok, false);
  assert.deepEqual(directoryBreadcrumbs("/srv/example/work/project", ["/srv/example"]), [
    { name: "example", path: "/srv/example" },
    { name: "work", path: "/srv/example/work" },
    { name: "project", path: "/srv/example/work/project" },
  ]);
  assert.deepEqual(directoryBreadcrumbs("/etc", ["/srv/example"]), []);
});

test("directory API browses authorized roots and creates folders without overwriting", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-directory-test-"));
  await mkdir(join(root, "visible"), { mode: 0o750 });
  await mkdir(join(root, ".hidden"), { mode: 0o750 });
  await writeFile(join(root, "notes.txt"), "server file browser\n");
  await writeFile(join(root, ".private.txt"), "hidden\n");
  await symlink(join(root, "visible"), join(root, "linked-directory"));
  await symlink(join(root, "notes.txt"), join(root, "linked-file.txt"));
  const port = await reserveLocalPort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      CODEX_PWA_HOST: "127.0.0.1",
      CODEX_PWA_PORT: String(port),
      CODEX_PWA_ROOTS: root,
      CODEX_PWA_PASSWORD_FILE: "",
      CODEX_PWA_APP_SERVER_MODE: "shared-daemon",
      CODEX_PWA_DAEMON_SOCKET: join(root, "missing-daemon.sock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/api/directories?path=${encodeURIComponent(root)}`, child);

  let response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`);
  let payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.entries.map((entry) => entry.name), ["visible"]);
  assert.equal(payload.path, root);
  assert.equal(payload.parent, null);

  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}&hidden=true`);
  payload = await response.json();
  assert.deepEqual(payload.entries.map((entry) => entry.name), [".hidden", "visible"]);
  assert.equal(payload.entries.some((entry) => entry.name === "linked-directory"), false);

  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}&query=${encodeURIComponent("visi")}`);
  payload = await response.json();
  assert.deepEqual(payload.entries.map((entry) => entry.name), ["visible"]);

  response = await fetch(`${base}/api/files/list?path=${encodeURIComponent(root)}`);
  payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.entries.map((entry) => entry.name), ["visible", "notes.txt"]);
  assert.equal(payload.entries.find((entry) => entry.name === "visible").type, "directory");
  assert.equal(payload.entries.find((entry) => entry.name === "notes.txt").previewKind, "text");
  assert.equal(payload.entries.some((entry) => entry.name === "linked-file.txt"), false);

  response = await fetch(`${base}/api/files/list?path=${encodeURIComponent(root)}&hidden=true&query=private`);
  payload = await response.json();
  assert.deepEqual(payload.entries.map((entry) => entry.name), [".private.txt"]);

  response = await fetch(`${base}/api/files/list?path=${encodeURIComponent(dirname(root))}`);
  assert.equal(response.status, 403);

  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(dirname(root))}`);
  assert.equal(response.status, 403);

  response = await fetch(`${base}/api/directories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: root, name: "created" }),
  });
  assert.equal(response.status, 403);

  response = await fetch(`${base}/api/directories`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Codex-PWA-Directory": "1" },
    body: JSON.stringify({ parent: root, name: "created" }),
  });
  payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.path, join(root, "created"));
  const details = await stat(payload.path);
  assert.equal(details.mode & 0o777, 0o750);

  const upload = new FormData();
  upload.append("files", new Blob(["真实 multipart 上传测试\n"], { type: "text/plain" }), "测试附件.txt");
  response = await fetch(`${base}/api/files/upload?cwd=${encodeURIComponent(payload.path)}`, {
    method: "POST",
    headers: { "X-Codex-PWA-Upload": "1" },
    body: upload,
  });
  const uploadPayload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(uploadPayload.files.length, 1);
  assert.equal(uploadPayload.files[0].relativePath, "测试附件.txt");
  assert.equal(await readFile(join(payload.path, "测试附件.txt"), "utf8"), "真实 multipart 上传测试\n");

  const operate = (body) => fetch(`${base}/api/files/operations`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Codex-PWA-File-Operation": "1" },
    body: JSON.stringify(body),
  });
  response = await operate({ operation: "copy", path: join(root, "notes.txt"), targetDirectory: payload.path });
  assert.equal(response.status, 200);
  assert.equal(await readFile(join(payload.path, "notes.txt"), "utf8"), "server file browser\n");
  assert.equal((await readdir(payload.path)).some((name) => name.includes(".codex-pwa-copying-")), false);
  response = await operate({ operation: "rename", path: join(payload.path, "notes.txt"), name: "renamed.txt" });
  assert.equal(response.status, 200);
  response = await operate({ operation: "move", path: join(payload.path, "renamed.txt"), targetDirectory: join(root, "visible") });
  assert.equal(response.status, 200);
  assert.equal(await readFile(join(root, "visible", "renamed.txt"), "utf8"), "server file browser\n");

  response = await fetch(`${base}/`);
  assert.equal(response.headers.get("cache-control"), "no-cache");

  const malformedHostResponse = await rawHttpRequest(
    port,
    "GET / HTTP/1.1\r\nHost: [bad\r\nConnection: close\r\n\r\n",
  );
  assert.match(malformedHostResponse, /^HTTP\/1\.1 200 /);
  assert.equal(child.exitCode, null);
  response = await fetch(`${base}/`);
  assert.equal(response.status, 200);

  response = await fetch(`${base}/api/directories`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Codex-PWA-Directory": "1" },
    body: JSON.stringify({ parent: root, name: "created" }),
  });
  assert.equal(response.status, 409);
});

test("trusted-device login protects APIs, enforces CSRF, and invalidates sessions after password changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-pwa-auth-test-"));
  const passwordPath = join(root, "access-password");
  const sessionPath = join(root, "trusted-devices.json");
  await writeFile(passwordPath, "initial-secret\n", { mode: 0o600 });
  const port = await reserveLocalPort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      CODEX_PWA_HOST: "127.0.0.1",
      CODEX_PWA_PORT: String(port),
      CODEX_PWA_ROOTS: root,
      CODEX_PWA_PASSWORD_FILE: passwordPath,
      CODEX_PWA_SESSION_FILE: sessionPath,
      CODEX_PWA_APP_SERVER_MODE: "shared-daemon",
      CODEX_PWA_DAEMON_SOCKET: join(root, "missing-daemon.sock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForHttp(`${base}/`, child);

  let response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.has("www-authenticate"), false);

  response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 503);
  assert.notEqual((await response.json()).bridge, "ready");

  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "codex", password: "wrong", remember: true }),
  });
  assert.equal(response.status, 401);

  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Android Test Browser" },
    body: JSON.stringify({ username: "codex", password: "initial-secret", remember: true }),
  });
  const login = await response.json();
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(response.status, 200);
  assert.equal(login.authenticated, true);
  assert.equal(login.remembered, true);
  assert.match(response.headers.get("set-cookie"), /Max-Age=7776000/);

  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`, { headers: { cookie } });
  assert.equal(response.status, 200);

  response = await fetch(`${base}/api/auth/devices`, { headers: { cookie } });
  let devices = await response.json();
  assert.equal(response.status, 200);
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].current, true);
  assert.match(devices.devices[0].userAgent, /Android Test Browser/);
  assert.equal(Object.hasOwn(devices.devices[0], "tokenHash"), false);

  response = await fetch(`${base}/api/auth/devices/${encodeURIComponent(login.id)}`, {
    method: "PATCH",
    headers: {
      cookie,
      "content-type": "application/json",
      "X-Codex-PWA-CSRF": login.csrfToken,
    },
    body: JSON.stringify({ label: "我的手机" }),
  });
  let deviceUpdate = await response.json();
  assert.equal(response.status, 200);
  assert.equal(deviceUpdate.device.label, "我的手机");

  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Windows Chrome Test" },
    body: JSON.stringify({ username: "codex", password: "initial-secret", remember: true }),
  });
  const secondLogin = await response.json();
  const secondCookie = response.headers.get("set-cookie").split(";", 1)[0];
  assert.equal(response.status, 200);

  response = await fetch(`${base}/api/auth/devices`, { headers: { cookie } });
  devices = await response.json();
  assert.equal(devices.devices.length, 2);
  assert.equal(devices.devices.find((device) => device.id === login.id).label, "我的手机");
  assert.equal(devices.devices.find((device) => device.id === secondLogin.id).current, false);

  response = await fetch(`${base}/api/auth/logout-others`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "X-Codex-PWA-CSRF": login.csrfToken,
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revoked, 1);
  response = await fetch(`${base}/api/auth/session`, { headers: { cookie: secondCookie } });
  assert.equal(response.status, 401);

  response = await fetch(`${base}/api/directories`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "X-Codex-PWA-Directory": "1" },
    body: JSON.stringify({ parent: root, name: "missing-csrf" }),
  });
  assert.equal(response.status, 403);

  response = await fetch(`${base}/api/directories`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "X-Codex-PWA-Directory": "1",
      "X-Codex-PWA-CSRF": login.csrfToken,
    },
    body: JSON.stringify({ parent: root, name: "csrf-ok" }),
  });
  assert.equal(response.status, 201);
  assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);

  const basic = Buffer.from("codex:initial-secret").toString("base64");
  response = await fetch(`${base}/api/directories?path=${encodeURIComponent(root)}`, {
    headers: { authorization: `Basic ${basic}` },
  });
  assert.equal(response.status, 401);

  await writeFile(passwordPath, "replacement-secret\n", { mode: 0o600 });
  response = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(response.status, 401);

  response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "codex", password: "replacement-secret", remember: true }),
  });
  const replacement = await response.json();
  const replacementCookie = response.headers.get("set-cookie").split(";", 1)[0];
  response = await fetch(`${base}/api/auth/logout-all`, {
    method: "POST",
    headers: {
      cookie: replacementCookie,
      "content-type": "application/json",
      "X-Codex-PWA-CSRF": replacement.csrfToken,
    },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  response = await fetch(`${base}/api/auth/session`, { headers: { cookie: replacementCookie } });
  assert.equal(response.status, 401);
});

test("directory picker exposes mobile browsing, filtering, and creation controls", async () => {
  const [server, app, html] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  for (const id of [
    "browseDirectoryButton", "directoryDialog", "directoryRoots", "directoryBreadcrumbs",
    "directorySearch", "showHiddenDirectories", "directoryCurrentPath", "directoryList",
    "newDirectoryForm", "newDirectoryInput", "showNewDirectoryButton", "chooseDirectoryButton",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(server, /x-codex-pwa-directory/);
  assert.match(server, /entry\.isDirectory\(\)/);
  assert.match(server, /MAX_DIRECTORY_ENTRIES/);
  assert.match(app, /loadDirectory/);
  assert.match(app, /codex-pwa-last-directory/);
});

test("streaming upload API is bounded, CSRF-marked, and atomically claims new names", async () => {
  const [server, app, html, worker] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(server, /Busboy/);
  assert.match(server, /x-codex-pwa-upload/);
  assert.match(server, /pipeline\(stream, meter, createWriteStream/);
  assert.match(server, /await link\(tempPath, destination\)/);
  assert.match(server, /MAX_UPLOAD_FILE_SIZE = 256 \* 1024 \* 1024/);
  assert.match(server, /MAX_UPLOAD_BATCH_SIZE = 512 \* 1024 \* 1024/);
  assert.match(app, /XMLHttpRequest/);
  assert.match(app, /appendUploadedFileReferences/);
  for (const id of [
    "attachButton", "fileInput", "photoInput", "attachmentTray", "newAttachButton", "newFileInput",
    "newPhotoInput", "newAttachmentTray", "attachmentSourceDialog", "choosePhotoButton", "chooseFileButton",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /id="photoInput"[^>]*accept="image\/\*"[^>]*multiple/);
  assert.match(html, /id="newPhotoInput"[^>]*accept="image\/\*"[^>]*multiple/);
  assert.doesNotMatch(html, /id="(?:new)?[Pp]hotoInput"[^>]*\bcapture(?:=|\s|>)/);
  assert.match(app, /openAttachmentSource/);
  assert.match(app, /chooseAttachmentSource\("photo"\)/);
  assert.match(worker, /\/upload-utils\.js/);
});

test("V2 interface exposes the core mobile task controls", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of [
    "threadSearch", "recentTab", "allHistoryTab", "archivedTab", "contextPanel", "changesPanel", "newModelSelect",
    "settingsDialog", "renameDialog", "approvalArea", "scrollBottomButton", "historyControls",
    "loadMoreHistoryButton", "loadCompleteHistoryButton", "historyNodesButton", "releaseThreadButton",
    "attachButton", "fileInput", "photoInput", "attachmentTray", "newAttachButton", "newFileInput",
    "newPhotoInput", "newAttachmentTray", "attachmentSourceDialog", "choosePhotoButton", "chooseFileButton",
    "authGate", "loginForm", "rememberDevice", "logoutButton", "logoutAllButton", "refreshWebUiButton",
    "newPermissionSelect", "settingsPermissionSelect",
    "serverFilesButton", "fileBrowserDialog", "fileBrowserSearch", "showHiddenFiles",
    "trustedDevicesButton", "devicesDialog", "devicesList", "logoutOtherDevicesButton",
    "threadActionDialog", "actionPinThreadButton", "actionRenameThreadButton", "actionCopyThreadIdButton", "actionArchiveThreadButton",
    "goalBar", "helpButton", "helpDialog", "askWebUiButton", "requestUiChangeButton",
    "historyNodesDialog", "historyNodesSearch", "historyNodesList", "historyNodesLoadMoreButton", "historyNodesLoadAllButton",
    "confirmDialog", "submitConfirmButton",
    "deviceRenameDialog", "deviceRenameForm",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test("bridge exposes thread organization and model APIs", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  for (const method of [
    "model/list", "thread/name/set", "thread/archive", "thread/unarchive",
    "thread/turns/list", "thread/unsubscribe", "thread/metadata/update",
    "thread/goal/get", "thread/goal/set", "thread/goal/clear",
  ]) {
    assert.match(source, new RegExp(method.replace("/", "\\/")));
  }
  assert.match(source, /experimentalApi:\s*true/);
  assert.match(source, /\/release/);
  assert.match(source, /codex\.recycle\(reason\)/);
  assert.match(source, /threadSource:\s*"codex-pwa-mobile"/);
});

test("resuming an existing task preserves its recorded permissions", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const metadataOnlyResume = [...source.matchAll(/codex\.request\("thread\/resume",\s*\{ threadId, excludeTurns: true \}\)/g)];
  const legacyResume = [...source.matchAll(/codex\.request\("thread\/resume",\s*\{ threadId \}\)/g)];
  assert.equal(metadataOnlyResume.length, 1);
  assert.equal(legacyResume.length, 1);
  assert.match(source, /const resumed = await subscribeThread\(threadId, allowed\)/);
  assert.doesNotMatch(source, /thread\/resume[\s\S]{0,180}(?:approvalPolicy|sandbox)/);
  assert.match(source, /thread\/resume[\s\S]{0,120}excludeTurns:\s*true/);
  assert.match(source, /-32602[\s\S]{0,120}excludeTurns\|unknown field/);
  assert.match(source, /IDLE_SUBSCRIPTION_LEASE_MS/);
  assert.match(source, /idle-subscription-lease/);
});

test("task reads retain recorded model settings without a live subscription", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(source, /let settings = serializeThreadSettings\(thread\);/);
  assert.match(source, /settings = subscribed\.settings \|\| settings;/);
});

test("task list pagination and persisted pins use app-server metadata", async () => {
  const [server, app, html] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(server, /thread\/list[\s\S]*cursor/);
  assert.match(server, /thread\/metadata\/update/);
  assert.match(server, /isPinned: Boolean\(thread\.isPinned\)/);
  assert.match(app, /threadCursor/);
  assert.match(app, /loadThreads\(\{ silent: true, append: true \}\)/);
  assert.match(html, /id="loadMoreThreadsButton"/);
});

test("long histories use summary-first loading with bounded on-demand activity details", async () => {
  const [server, app, html, css] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(server, /itemsView = "summary"/);
  assert.match(server, /HISTORY_ACTIVITY_LIMIT_PER_TURN = 40/);
  assert.match(server, /MAX_HISTORY_OUTPUT_CACHE_BYTES/);
  assert.match(server, /outputTruncated: true/);
  assert.match(server, /historyOutputMatch/);
  assert.match(server, /readActiveNarrative/);
  assert.match(server, /narrativeHistoryPage/);
  assert.match(app, /loadActivityDetails/);
  assert.match(app, /loadMoreHistory/);
  assert.match(app, /加载更多历史对话/);
  assert.match(app, /加载完整历史对话/);
  assert.match(app, /openHistoryNodes/);
  assert.match(app, /appendHistoryNodes/);
  assert.match(app, /mergeActiveTranscript/);
  assert.match(app, /toggleCommandOutput/);
  assert.match(app, /replaceItems: true/);
  assert.match(app, /MAX_RETAINED_HISTORY_TURNS = 2_500/);
  assert.match(app, /MAX_RETAINED_HISTORY_CHARS = 32 \* 1024 \* 1024/);
  assert.match(app, /MAX_RETAINED_HISTORY_NODES = 5_000/);
  assert.match(app, /markHistoryMemoryLimited/);
  assert.match(html, /id="loadMoreHistoryButton"/);
  assert.match(html, /id="loadMoreHistoryButton"[^>]*>加载更多历史对话/);
  assert.match(html, /id="loadCompleteHistoryButton"[^>]*>加载完整历史对话/);
  assert.match(html, /id="historyNodesButton"/);
  assert.match(html, /询问 Codex 在使用本 Web UI 过程中遇到的问题/);
  assert.match(html, /新建 Web UI 使用帮助对话/);
  assert.match(html, /提出 Web UI 改进建议/);
  assert.match(css, /\.history-controls\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.history-controls button\s*\{[^}]*min-width:\s*0[^}]*white-space:\s*normal/);
});

test("sidebar utility menu is a unified 3x2 layout with inline connection status", async () => {
  const [app, html, css, worker] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /class="sidebar-menu-grid"/);
  assert.match(html, /服务器文件/);
  assert.match(html, /深\/浅色模式/);
  assert.match(html, /使用帮助/);
  assert.match(html, /已登录设备管理/);
  assert.match(html, /退出当前设备/);
  assert.match(html, /刷新 Web UI/);
  assert.match(html, /class="server-status-copy"/);
  assert.match(html, /id="networkLabel"/);
  assert.doesNotMatch(html, /id="fileBrowserBreadcrumbs"/);
  assert.doesNotMatch(app, /renderFileBrowserBreadcrumbs/);
  assert.match(html, /id="logoutAllButton"[^>]*>注销全部设备/);
  assert.match(css, /\.sidebar-menu-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2/);
  assert.match(css, /\.sidebar-utility\s*\{[^}]*font-size:\s*11px/);
  assert.match(css, /\.file-browser-actions button, \.devices-actions button\s*\{[^}]*font-size:\s*11px/);
  assert.match(css, /\.history-nodes-actions button\s*\{[^}]*font-size:\s*11px/);
  assert.match(css, /\.sidebar-menu-grid \.sidebar-utility > span:first-child\s*\{[^}]*flex:\s*0 0 16px/);
  assert.match(css, /\.server-status-copy\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.directory-current code\s*\{[^}]*direction:\s*rtl[^}]*text-align:\s*left/);
  assert.match(app, /refreshWebUiButton\.addEventListener/);
  assert.match(app, /registration\.waiting\.postMessage\(\{ type: "SKIP_WAITING" \}\)/);
  assert.match(worker, /codex-pwa-v49/);
});

test("conversation list separates recent, all-history, and archived sessions", async () => {
  const [app, html, css] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="recentTab"[^>]*>近7天会话/);
  assert.match(html, /id="allHistoryTab"[^>]*>全部历史会话/);
  assert.match(html, /id="archivedTab"[^>]*>已归档会话/);
  assert.match(app, /threadListMode:\s*"recent"/);
  assert.match(app, /RECENT_THREAD_WINDOW_SECONDS = 7 \* 24 \* 60 \* 60/);
  assert.match(app, /isRecentThread/);
  assert.match(app, /mode === "all"/);
  assert.match(app, /state\.threadListMode === "archived"/);
  assert.match(app, /page\.some\(\(thread\) => !isRecentThread\(thread\)\)/);
  assert.match(css, /\.list-tab\s*\{[^}]*flex:\s*1 1 0/);
});

test("selected task archive state is independent from the sidebar list mode", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /state\.archived/);
  assert.match(app, /thread\.archived \? "恢复" : "归档"/);
  assert.match(app, /if \(!state\.selectedThread\.archived\) params\.set\("subscribe", "true"\)/);
  assert.match(app, /routeThreadArchived/);
});

test("live output, server caches, and uncertain writes have explicit safety bounds", async () => {
  const [server, app] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(server, /MAX_HISTORY_OUTPUT_ENTRY_BYTES/);
  assert.match(server, /RPC_OUTCOME_UNKNOWN/);
  assert.match(server, /RPC_MUTATION_TIMEOUT_MS/);
  assert.match(server, /MAX_ORIGINATOR_CACHE_ENTRIES/);
  assert.match(server, /MAX_ARTIFACT_INDEX_CACHE_ENTRIES/);
  assert.match(server, /MAX_LIVE_ARTIFACT_CACHE_BYTES = 96 \* 1024 \* 1024/);
  assert.match(server, /liveArtifactCacheBytes/);
  assert.match(server, /copyToFinalPath/);
  assert.match(server, /error\.code !== "EXDEV"/);
  assert.match(app, /MAX_LIVE_COMMAND_CHARS/);
  assert.match(app, /appendBoundedLiveText/);
  assert.match(app, /if \(error\.outcomeUnknown && rendered\)/);
  assert.match(app, /reconcileUnknownTaskStart/);
});

test("history node failures remain distinguishable from confirmed empty history", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /error:\s*""/);
  assert.match(app, /历史节点加载失败/);
  assert.match(app, /canRetryInitialLoad/);
});

test("menu transitions close open popovers before switching or replacing views", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /function closeOpenMenus\(event\)[\s\S]*target\.closest\("\.floating-popover"\)[\s\S]*closeFloatingMenu\(\)/);
  assert.match(app, /document\.addEventListener\("pointerdown", closeOpenMenus, true\)/);
  assert.match(app, /document\.addEventListener\("scroll", closeAllMenus, true\)/);
  assert.match(app, /document\.addEventListener\("touchmove", closeAllMenus/);
  assert.match(app, /function openFloatingMenu\(anchor, owner, actions\)/);
  assert.match(app, /function closeSidebar\(\)[\s\S]*closeAllMenus\(\)/);
  assert.match(app, /function setListMode\(mode\)[\s\S]*closeAllMenus\(\)/);
  assert.match(app, /async function loadThreads\([\s\S]*const sequence = \+\+state\.threadLoadSequence;\n  if \(!silent \|\| append\) closeAllMenus\(\)/);
  assert.match(app, /function openThreadActionMenu\(thread\)[\s\S]*closeAllMenus\(\)/);
  assert.match(app, /function openFileBrowser\([\s\S]*closeAllMenus\(\)/);
  assert.match(app, /function openDevices\([\s\S]*closeAllMenus\(\)/);
  assert.match(app, /function openHelp\([\s\S]*closeAllMenus\(\)/);
});

test("mobile task settings are bilingual, per-task, and committed only after turn start succeeds", async () => {
  const [server, app, html] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(app, /threadSettings:\s*new Map/);
  assert.match(app, /轻度（low）/);
  assert.match(app, /极高（xhigh）/);
  assert.match(app, /极致（ultra，自动委派）/);
  assert.match(app, /settings:\s*pendingSettings\(threadId\)/);
  assert.match(app, /commitEffectiveSettings\(threadId, result\.settings\)/);
  assert.match(server, /parseSettingsOverrides\(body\.settings, currentSettings\)/);
  assert.match(server, /const effectiveSettings = mergeThreadSettings\(currentSettings, overrides\.applied\)/);
  assert.match(server, /settings:\s*effectiveSettings/);
  assert.match(html, /请求批准/);
  assert.match(html, /帮我批准/);
  assert.match(html, /完全批准/);
});

test("browser authentication uses trusted-device cookies and CSRF without native Basic prompts", async () => {
  const [server, app, html, worker] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(server, /\/api\/auth\/login/);
  assert.match(server, /\/api\/auth\/logout-all/);
  assert.match(server, /x-codex-pwa-csrf/);
  assert.doesNotMatch(server, /www-authenticate/);
  assert.match(app, /X-Codex-PWA-CSRF/);
  assert.match(app, /\/api\/auth\/session/);
  assert.match(app, /!state\.auth\.authenticated \|\| document\.visibilityState === "hidden"/);
  assert.match(server, /globalLoginRateLimiter/);
  assert.match(server, /loginRateLimitKey/);
  assert.match(html, /记住此设备 90 天/);
  assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
});

test("mobile client preserves drafts, routes tasks, throttles streams, and previews images", async () => {
  const [app, css, worker, html, manifest] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
  ]);
  assert.match(app, /codex-pwa-draft:/);
  assert.match(app, /pushState/);
  assert.match(app, /popstate/);
  assert.match(app, /STREAM_RENDER_INTERVAL_MS/);
  assert.match(app, /mergeTurnsPage/);
  assert.match(app, /URL\.createObjectURL\(file\)/);
  assert.match(css, /\.send-button\s*\{[^}]*width:\s*42px[^}]*height:\s*42px/s);
  assert.match(css, /\.attachment-thumbnail/);
  assert.match(app, /visualViewport/);
  assert.match(app, /--app-height/);
  assert.match(app, /window\.scrollTo\(0, 0\)/);
  assert.match(css, /\.composer textarea\s*\{[^}]*min-height:\s*58px/s);
  assert.match(html, /mobile-web-app-capable/);
  assert.match(html, /icon-192\.png\?v=27/);
  assert.match(manifest, /"purpose": "any"/);
  assert.match(worker, /SKIP_WAITING/);
  assert.doesNotMatch(worker, /install[\s\S]{0,180}skipWaiting/);
});

test("critical client actions require explicit confirmation and stop control lives by send", async () => {
  const [app, html, css] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /class="composer-submit-actions"[\s\S]*id="stopButton"[\s\S]*id="sendButton"/);
  assert.match(app, /async function sendPrompt[\s\S]*requestConfirmation/);
  assert.match(app, /async function createTask[\s\S]*requestConfirmation/);
  assert.match(app, /async function stopTurn[\s\S]*requestConfirmation/);
  assert.match(app, /async function answerApproval[\s\S]*requestConfirmation/);
  assert.match(app, /async function saveGoal[\s\S]*requestConfirmation/);
  assert.match(app, /async function uploadFilesToBrowserDirectory[\s\S]*requestConfirmation/);
  assert.match(app, /RENAME FILE/);
  assert.match(css, /\.composer-submit-actions\s*\{/);
});

test("context compaction and warning notices are rendered in the owning turn", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /item\.type === "ContextCompaction"/);
  assert.match(app, /function renderTurnNotice[\s\S]*turnGroup\(turnId, \{ create: Boolean\(turnId\) \}\)/);
  assert.match(app, /const turnId = notificationTurnId\(params\);[\s\S]*renderTurnNotice\(messageText/);
  assert.doesNotMatch(app, /elements\.messages\.append\(el\("div", "turn-error", messageText\)\)/);
  assert.match(css, /\.turn-notice\s*\{/);
});

test("shared-daemon mode uses the Unix WebSocket without recycling the daemon", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const unit = await readFile(new URL("../systemd/codex-pwa.service", import.meta.url), "utf8");
  const installer = await readFile(new URL("../scripts/install-user.sh", import.meta.url), "utf8");
  assert.match(source, /CODEX_PWA_APP_SERVER_MODE/);
  assert.match(source, /createConnection\(\{ path: daemonSocket \}\)/);
  assert.match(source, /perMessageDeflate:\s*false/);
  assert.match(source, /SHARED_DAEMON_HEARTBEAT_MS/);
  assert.match(source, /socket\.ping\(\)/);
  assert.match(source, /scheduleSharedReconnect/);
  assert.match(source, /subscribedThreads/);
  assert.match(source, /RPC_OVERLOAD_RETRY_LIMIT/);
  assert.match(source, /error\?\.details\?\.code === -32001/);
  assert.match(source, /if \(usesSharedDaemon\) return false/);
  assert.match(unit, /EnvironmentFile=%h\/\.config\/codex-pwa\/codex-pwa\.env/);
  assert.match(unit, /MemoryHigh=768M/);
  assert.match(unit, /MemoryMax=1G/);
  assert.match(installer, /CODEX_PWA_APP_SERVER_MODE/);
  assert.match(installer, /app-server daemon bootstrap/);
  assert.match(installer, /app-server daemon start/);
  assert.match(installer, /CODEX_PWA_DAEMON_SOCKET/);
});

test("per-user installer generates isolated roots, daemon socket, port, and private-network units", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-pwa-installer-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const child = spawn("bash", [
    "scripts/install-user.sh",
    "--dry-run",
    "--yes",
    "--port", "4266",
    "--private-ip", "172.16.2.99",
    "--root", home,
    "--instance-name", "researcher 的 Codex",
  ], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      HOME: home,
      USER: "researcher",
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_PWA_SETUP_DRY_RUN: "1",
      CODEX_BIN: "/usr/local/bin/codex",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, errors);
  assert.match(output, /http:\/\/172\.16\.2\.99:4266/);

  const config = await readFile(join(home, ".config", "codex-pwa", "codex-pwa.env"), "utf8");
  assert.match(config, new RegExp(`CODEX_PWA_ROOTS="${home.replaceAll("/", "\\/")}"`));
  assert.match(config, /CODEX_PWA_PORT="4266"/);
  assert.match(config, new RegExp(`CODEX_HOME="${home.replaceAll("/", "\\/")}\\/.codex"`));
  assert.match(config, /CODEX_PWA_APP_SERVER_MODE="shared-daemon"/);
  assert.match(config, /CODEX_PWA_INSTANCE_NAME="researcher 的 Codex"/);
  assert.match(config, /CODEX_PWA_PRIVATE_IP="172\.16\.2\.99"/);
  assert.match(config, /CODEX_PWA_LOOPBACK_ONLY="0"/);
  assert.doesNotMatch(config, /home\/dell/);

  const unitRoot = join(home, ".config", "systemd", "user");
  const [service, socket, proxy] = await Promise.all([
    readFile(join(unitRoot, "codex-pwa.service"), "utf8"),
    readFile(join(unitRoot, "codex-pwa-private.socket"), "utf8"),
    readFile(join(unitRoot, "codex-pwa-private.service"), "utf8"),
  ]);
  assert.match(service, /EnvironmentFile=/);
  assert.match(service, /MemoryHigh=768M/);
  assert.match(service, /MemoryMax=1G/);
  assert.match(socket, /ListenStream=172\.16\.2\.99:4266/);
  assert.match(socket, /FreeBind=true/);
  assert.match(proxy, /127\.0\.0\.1:4266/);
  assert.equal((await stat(join(home, ".config", "codex-pwa", "access-password"))).mode & 0o777, 0o600);

  const reinstall = spawn("bash", ["scripts/install-user.sh", "--dry-run", "--yes"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      HOME: home,
      USER: "researcher",
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_PWA_SETUP_DRY_RUN: "1",
      CODEX_BIN: "/usr/local/bin/codex",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let reinstallErrors = "";
  reinstall.stderr.on("data", (chunk) => { reinstallErrors += chunk; });
  const [reinstallCode] = await once(reinstall, "exit");
  assert.equal(reinstallCode, 0, reinstallErrors);
  const preserved = await readFile(join(home, ".config", "codex-pwa", "codex-pwa.env"), "utf8");
  assert.match(preserved, new RegExp(`CODEX_PWA_ROOTS="${home.replaceAll("/", "\\/")}"`));
  assert.match(preserved, /CODEX_PWA_PORT="4266"/);
  assert.match(preserved, /CODEX_PWA_INSTANCE_NAME="researcher 的 Codex"/);
  assert.match(preserved, /CODEX_PWA_PRIVATE_IP="172\.16\.2\.99"/);
  t.diagnostic("installer dry-run generated an isolated per-user deployment");
});

test("opening a task subscribes to live events and recovers missed output", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(server, /url\.searchParams\.get\("subscribe"\) === "true"/);
  assert.match(server, /subscribeThread\(threadId, thread\)/);
  assert.match(server, /syncActiveTurnFromHistory\(threadId, history, thread\.status\)/);
  assert.match(client, /params\.set\("subscribe", "true"\)/);
  assert.match(client, /recoverVisibleState/);
  assert.match(client, /visibleRecoveryPromise/);
  assert.match(client, /runVisibleRecovery[\s\S]*await Promise\.all\(\[loadStatus\(\), loadThreads[\s\S]*await openThread\(selectedId/);
  assert.match(client, /const pendingApprovals = new Map[\s\S]*state\.approvals = pendingApprovals/);
  assert.match(client, /approvalRevision === state\.approvalRevision/);
  assert.match(client, /sequence !== state\.openThreadSequence \|\| state\.selectedThread\?\.id !== threadId/);
  assert.match(client, /if \(params\.threadId && params\.threadId !== selectedId\) return/);
  assert.match(client, /historyRetainedChars/);
  assert.match(client, /historyTurnChars/);
  assert.match(client, /canRetainHistoryPage\(\[result\.turn\]\)/);
  assert.match(client, /events\.onopen[\s\S]*runVisibleRecovery\(\)/);
});

test("slow SSE clients are bounded and allowed to reconnect", async () => {
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /MAX_SSE_QUEUE_BYTES/);
  assert.match(server, /queueSseFrame/);
  assert.match(server, /flushSseClient/);
  assert.match(server, /closeSseClient\(response, \{ destroy: true \}\)/);
  assert.match(server, /for \(const client of \[\.\.\.sseClients\.keys\(\)\]\) closeSseClient\(client\)/);
});

test("generated images, server files, trusted devices, and long-press task actions are wired end to end", async () => {
  const [server, app, html, css] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(server, /\/api\/files\/list/);
  assert.match(server, /\/api\/auth\/devices/);
  assert.match(server, /\/api\/auth\/logout-others/);
  assert.match(server, /threadArtifactsMatch/);
  assert.match(server, /sanitizeNotificationForBrowser/);
  assert.match(app, /renderImageGeneration/);
  assert.match(app, /loadThreadArtifacts/);
  assert.match(app, /const group = turnGroup\(turnId\)/);
  assert.doesNotMatch(app, /turnGroup\(artifact\.turnId\) \|\| groups\.at\(-1\)/);
  assert.match(app, /loadFileBrowser/);
  assert.match(app, /renderDevices/);
  assert.match(app, /pointerdown[\s\S]*setTimeout[\s\S]*520/);
  assert.match(app, /contextmenu/);
  assert.match(html, /服务器文件/);
  assert.match(html, /可信设备/);
  assert.match(css, /\.artifact-card/);
  assert.match(css, /\.file-entry/);
  assert.match(css, /\.file-entry-menu/);
  assert.match(css, /\.file-browser > \.directory-heading\s*\{[^}]*border-bottom:\s*0/);
  assert.match(css, /\.file-browser-roots[^}]*display:\s*none/);
  assert.match(css, /\.device-card/);
  assert.match(css, /\.thread-main[^}]*touch-action:\s*pan-y/s);
});

test("Goal state, confirmation actions, and top-level task menus are wired", async () => {
  const [server, app, html, css, worker] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(server, /goalSupported/);
  assert.match(server, /GOAL_STATUSES/);
  assert.match(server, /goalSetParams/);
  assert.match(server, /requestThreadGoalBestEffort/);
  assert.match(server, /Goal objective is limited/);
  assert.match(app, /thread\/goal\/updated/);
  assert.match(app, /thread\/goal\/cleared/);
  assert.match(app, /requestConfirmation/);
  assert.match(app, /copyThreadId/);
  assert.match(app, /openFloatingMenu/);
  assert.match(html, /id="goalBar"/);
  assert.match(html, /id="helpDialog"/);
  assert.match(html, /id="historyNodesDialog"/);
  assert.match(html, /id="historyNodesLoading"/);
  assert.match(html, /id="historyNodesCanvas"/);
  assert.match(html, /id="historyNodesRows"/);
  assert.match(html, /id="confirmDialog"/);
  assert.match(css, /\.thread-card\.menu-open/);
  assert.match(css, /#chatMenu\s*\{[^}]*flex:\s*0\s+0\s+40px/);
  assert.match(css, /#chatMenu\s*>\s*summary\s*\{[^}]*display:\s*inline-grid/);
  assert.match(html, /<summary class="icon-button" aria-label="更多操作">⋮<\/summary>/);
  assert.doesNotMatch(html, /topNewTaskButton/);
  assert.doesNotMatch(app, /topNewTaskButton/);
  assert.match(css, /\.floating-popover/);
  assert.match(css, /\.thread-menu-button:hover/);
  assert.match(css, /\.goal-bar/);
  assert.match(css, /\.history-nodes-canvas/);
  assert.match(css, /\.history-nodes-rows/);
  assert.match(css, /\.history-nodes-loading/);
  assert.match(css, /\.history-nodes-loading-banner\s*\{/);
  assert.match(css, /\.history-nodes-list\.focus-loading/);
  assert.match(css, /touch-action:\s*pan-y/);
  assert.match(css, /--action-bg:\s*#/);
  assert.match(css, /\.confirm-actions > button\.primary-button\s*\{[^}]*background:\s*var\(--action-bg\)/);
  assert.match(css, /\.confirm-actions > button\.danger-button\s*\{[^}]*background:\s*var\(--red\)/);
  assert.doesNotMatch(css, /\.directory-create button\.primary-button\s*\{[^}]*var\(--accent\)/);
  assert.match(css, /\.toast\.loading\s*\{/);
  assert.match(css, /\.toast\.loading::before\s*\{/);
  assert.match(app, /function showLoadingToast\(/);
  assert.match(app, /function finishLoadingToast\(/);
  assert.match(app, /function setHistoryNodesFocusLoading\(/);
  assert.match(app, /正在加载历史对话节点/);
  assert.match(app, /正在加载完整历史上下文/);
  assert.match(app, /正在加载任务/);
  assert.match(app, /正在保存 Goal/);
  assert.match(app, /加载中……/);
  assert.match(app, /historyNodesList\.setAttribute\("aria-busy"/);
  assert.match(worker, /codex-pwa-v49/);
});

test("history pages are normalized to chronological order", () => {
  const turns = [{ id: "newest" }, { id: "middle" }, { id: "oldest" }];
  assert.deepEqual(chronologicalTurns(turns, "desc").map((turn) => turn.id), ["oldest", "middle", "newest"]);
  assert.deepEqual(turns.map((turn) => turn.id), ["newest", "middle", "oldest"]);
});

test("history node navigation opens a bidirectional chronological context", async () => {
  const [server, app, css] = await Promise.all([
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);
  const focusSource = app.slice(app.indexOf("async function focusHistoryNode"), app.indexOf("function updateChatHeader"));
  const notificationSource = app.slice(app.indexOf("function historyContextDefersNotification"), app.indexOf("function connectEvents"));
  const sendSource = app.slice(app.indexOf("async function sendPrompt"), app.indexOf("async function stopTurn"));

  assert.match(server, /const sortDirection = url\.searchParams\.get\("sort"\) === "asc" \? "asc" : "desc"/);
  assert.match(server, /codex\.request\("thread\/turns\/list",\s*\{[\s\S]*sortDirection: direction/);
  assert.match(app, /pageCursor/);
  assert.match(focusSource, /items:\s*"full"/);
  assert.match(focusSource, /replaceHistoryContextTurns\(turns, node, page\)/);
  assert.doesNotMatch(focusSource, /mergeTurnsPage/);
  assert.match(app, /sort:\s*direction === "newer" \? "asc" : "desc"/);
  assert.match(app, /history-context-turn/);
  assert.match(app, /elements\.messages\.replaceChildren\(fragment, elements\.historyControls\)/);
  assert.match(notificationSource, /markHistoryContextUpdated\(\);\s*return;/);
  assert.match(sendSource, /await returnToLatestConversation\(\)/);
  assert.match(css, /\.history-context-banner/);
  assert.match(css, /\.history-context-feedback/);
  assert.match(css, /\.toast\s*\{[^}]*top:\s*calc\(var\(--viewport-offset-top\)/);
  assert.doesNotMatch(css, /\.toast\s*\{[^}]*bottom:\s*max\(/);
  assert.match(css, /\.history-context-turn/);
  assert.match(css, /\.turn-group\.history-context-target/);
});

test("diff rendering is chunked without miscounting lines", () => {
  assert.equal(countDiffLines(""), 0);
  assert.equal(countDiffLines("one"), 1);
  assert.equal(countDiffLines("one\ntwo\nthree"), 3);
  assert.equal(nextDiffChunkEnd(1_000, 0, 240), 240);
  assert.equal(nextDiffChunkEnd(1_000, 960, 240), 1_000);
});

test("optimistic user messages reconcile by thread and normalized text", () => {
  const pending = [
    { id: "local-1", threadId: "thread-a", text: normalizeUserMessageText("你好\r\n世界") },
    { id: "local-2", threadId: "thread-b", text: normalizeUserMessageText("你好\n世界") },
  ];
  assert.equal(findPendingUserMessageIndex(pending, "thread-a", "你好\n世界"), 0);
  assert.equal(findPendingUserMessageIndex(pending, "thread-b", "你好\r\n世界"), 1);
  assert.equal(findPendingUserMessageIndex(pending, "thread-c", "你好\n世界"), -1);
});

test("reconciliation reuses and rekeys the optimistic message node", () => {
  const node = { type: "user", element: {}, body: {} };
  const pendingMessages = [{ id: "local-1", threadId: "thread-a", text: "只显示一次" }];
  const itemNodes = new Map([["local-1", node]]);
  const itemTurns = new Map([["local-1", "turn-1"]]);
  const result = reconcilePendingUserMessage({
    pendingMessages,
    itemNodes,
    itemTurns,
    threadId: "thread-a",
    itemId: "server-1",
    text: "只显示一次",
  });
  assert.equal(result, node);
  assert.equal(pendingMessages.length, 0);
  assert.equal(itemNodes.has("local-1"), false);
  assert.equal(itemNodes.get("server-1"), node);
  assert.equal(itemTurns.has("local-1"), false);
  assert.equal(itemTurns.get("server-1"), "turn-1");
});

test("client refreshes task state after foreground recovery", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /visibilitychange/);
  assert.match(source, /setInterval\(refreshVisibleState, 15_000\)/);
  assert.match(source, /thread\/started/);
  assert.match(source, /historyCompleteCursor/);
  assert.match(source, /pages < 25/);
  assert.match(source, /renderHistoryWindow/);
  assert.match(source, /fixedVirtualRange/);
  assert.match(source, /点击左侧主菜单查看历史会话/);
});

test("mobile layout constrains long task titles and dynamic controls", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.main-panel\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.topbar-title\s*\{[^}]*flex:\s*1\s+1\s+0[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.topbar-actions\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(css, /\.topbar-actions\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(css, /\.topbar-title\s*\{[^}]*width:\s*min\(calc\(100%\s*-\s*176px\),\s*76vw\)/s);
  assert.match(css, /\.topbar-title h1\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.chat-view\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(css, /\.context-panel:not\(\.open\)|\.context-panel\s*\{[^}]*visibility:\s*hidden/s);
  assert.match(css, /html\s*\{[^}]*overflow:\s*hidden[^}]*overscroll-behavior:\s*none/s);
  assert.match(css, /\.app-shell\s*\{[^}]*position:\s*fixed[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.sidebar\s*\{[^}]*overflow:\s*hidden[^}]*overscroll-behavior:\s*none/s);
  assert.match(css, /\.sidebar\s*\{\s*right:\s*7%/s);
});
