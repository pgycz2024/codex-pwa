import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const projectDirectory = dirname(fileURLToPath(new URL("../server.mjs", import.meta.url)));
const chromeCandidates = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

async function executableChrome() {
  for (const candidate of chromeCandidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  return null;
}

async function reservePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForJson(url, { attempts = 120, child = null, diagnostics = null } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    if (child?.exitCode !== null) {
      const detail = String(diagnostics?.() || "").trim();
      throw new Error(
        `Process exited with code ${child.exitCode} while waiting for ${url}${detail ? `\n${detail}` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = String(diagnostics?.() || "").trim();
  throw new Error(`Timed out waiting for ${url}${detail ? `\n${detail}` : ""}`);
}

class CdpSession {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
    });
  }

  async open() { await once(this.socket, "open"); }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  close() { this.socket.close(); }
}

function jsonRoute(url) {
  const parsed = new URL(url);
  const now = Date.now() / 1000;
  const title = "这是一个用于检查手机屏幕超长标题省略和右侧操作按钮间距的测试任务名称";
  const thread = {
    id: "mobile-e2e-thread",
    name: title,
    preview: "移动端布局回归测试",
    cwd: "/srv/example/project",
    createdAt: now - 120,
    updatedAt: now,
    recencyAt: now,
    status: { type: "idle" },
    source: "vscode",
    threadSource: "codex-pwa-mobile",
    canAcceptDirectInput: true,
    isPinned: false,
  };
  if (parsed.pathname === "/api/auth/session") {
    return { authenticated: true, authEnabled: false, csrfToken: null };
  }
  if (parsed.pathname === "/api/status") {
    return {
      bridge: "ready", roots: ["/srv/example"], appRoot: projectDirectory,
      instanceName: "Mobile Test", networkLabel: "受控测试私网", version: "0.18.15",
      activeTurns: {}, ownedThreads: [], releasingThreads: [], pendingApprovals: [],
    };
  }
  if (parsed.pathname === "/api/models") return { data: [] };
  if (parsed.pathname === "/api/threads") return { data: [thread], nextCursor: null };
  if (parsed.pathname === `/api/threads/${thread.id}`) {
    return {
      thread,
      history: {
        data: [{
          id: "turn-mobile-1", status: "completed",
          createdAt: "2026-09-15T00:00:00Z", completedAt: "2026-09-15T00:00:10Z",
          items: [
            { id: "user-mobile-1", type: "userMessage", text: "检查移动端布局", sentAt: "2026-09-15T00:00:01Z" },
            { id: "user-mobile-fallback", type: "userMessage", text: "没有独立时间的历史消息" },
            {
              id: "agent-mobile-1",
              type: "agentMessage",
              startedAt: "2026-09-15T00:00:02Z", completedAtMs: Date.parse("2026-09-15T00:00:05Z"),
              text: "布局检查已完成。\n\n## 结果概览\n\n移动端标题和操作区域保持稳定。\n\n## 图片预览\n\n![标注后的图片](/srv/example/project/annotated.png)\n\n## 后续建议\n\n图片应显示在这段文字之前。",
            },
          ],
        }],
        nextCursor: null,
      },
      goal: null, goalSupported: false, activeTurnId: null,
      activeTranscriptAvailable: false, settings: null, liveSubscribed: true, ownership: "owned",
    };
  }
  if (parsed.pathname === `/api/threads/${thread.id}/turns`) {
    return {
      data: Array.from({ length: 800 }, (_, index) => ({
        id: `history-node-${index}`,
        createdAt: now - index * 60,
        status: "completed",
        items: [{
          id: `history-user-${index}`,
          type: "userMessage",
          text: `第 ${index + 1} 个历史节点，用于验证移动端长列表滚动不会回弹到顶部。`,
        }, {
          id: `history-agent-${index}`,
          type: "agentMessage",
          text: `第 ${index + 1} 个历史节点的完整 Codex 回复。${index === 123 ? '\n\n' + '长回复示例'.repeat(2600) : ''}`,
        }],
      })),
      nextCursor: null,
      backwardsCursor: null,
      sortDirection: "desc",
    };
  }
  if (parsed.pathname === "/api/files/list") {
    return {
      path: "/srv/example",
      parent: null,
      roots: [{ name: "example", path: "/srv/example" }],
      entries: [{
        name: "report.txt",
        path: "/srv/example/report.txt",
        type: "file",
        size: 128,
        modifiedAt: Date.now(),
        previewKind: "text",
      }, { name: 'folder', path: '/srv/example/folder', type: 'directory' }],
      truncated: false,
    };
  }
  if (parsed.pathname.endsWith("/artifacts")) {
    return { data: [{
      id: "generated-mobile-image",
      type: "image",
      turnId: "turn-mobile-1",
      name: "generated-mobile-image.png",
      byteLength: 68,
      previewUrl: `/api/threads/${thread.id}/artifacts/generated-mobile-image/raw`,
      downloadUrl: `/api/threads/${thread.id}/artifacts/generated-mobile-image/raw?download=1`,
    }] };
  }
  return {};
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
  }
  return result.result?.value;
}

async function waitForExpression(cdp, expression) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}

test("mobile Chrome viewport keeps core navigation, dialogs, and long titles stable", async (t) => {
  const chrome = await executableChrome();
  if (!chrome) return t.skip("Chrome/Chromium is not installed");

  const root = await mkdtemp(join(tmpdir(), "codex-pwa-browser-test-"));
  const appPort = await reservePort();
  const debugPort = await reservePort();
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      CODEX_PWA_HOST: "127.0.0.1",
      CODEX_PWA_PORT: String(appPort),
      CODEX_PWA_ROOTS: root,
      CODEX_PWA_PASSWORD_FILE: "",
      CODEX_PWA_APP_SERVER_MODE: "shared-daemon",
      CODEX_PWA_DAEMON_SOCKET: join(root, "missing-daemon.sock"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverDiagnostics = "";
  const retainServerDiagnostics = (chunk) => {
    serverDiagnostics = `${serverDiagnostics}${chunk}`.slice(-16_384);
  };
  server.stdout.on("data", retainServerDiagnostics);
  server.stderr.on("data", retainServerDiagnostics);
  const browser = spawn(chrome, [
    "--headless=new",
    ...(process.env.CI ? ["--no-sandbox"] : []),
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${join(root, "chrome-profile")}`,
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-sync",
    "--no-first-run",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let browserDiagnostics = "";
  browser.stderr.on("data", (chunk) => {
    browserDiagnostics = `${browserDiagnostics}${chunk}`.slice(-16_384);
  });
  let cdp = null;
  let workerCdp = null;
  t.after(async () => {
    workerCdp?.close();
    if (cdp) {
      await Promise.race([
        cdp.send("Browser.close").catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      cdp.close();
    }
    if (browser.exitCode === null) browser.kill("SIGKILL");
    if (server.exitCode === null) server.kill("SIGTERM");
    if (browser.exitCode === null) await once(browser, "exit");
    if (server.exitCode === null) await once(server, "exit");
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await waitForJson(`http://127.0.0.1:${appPort}/api/auth/session`, {
    child: server,
    diagnostics: () => serverDiagnostics,
  });
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`, {
    attempts: 600,
    child: browser,
    diagnostics: () => browserDiagnostics,
  });
  const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" }).then((response) => response.json());
  cdp = new CdpSession(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] });
  let writeScenario = null;
  let threadListOverride = null;
  let threadReads = 0;
  let statusFailures = 0;
  let statusReads = 0;
  let delayedStatus = null;
  const approvalWrites = [];
  const fixtureApprovals = new Map();
  let heldInteractive = null;
  let activityFixture = null;
  let paginatedContext = false;
  let fileListReads = 0;
  let writeAttempts = 0;
  let messageCorrelationEnabled = false;
  const writeDiagnostics = [];
  cdp.on("Runtime.exceptionThrown", (params) => writeDiagnostics.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text));
  const identifiedWrites = new Map();
  const fulfillWrite = (requestId, payload, responseCode = 200) => cdp.send("Fetch.fulfillRequest", {
    requestId, responseCode, responsePhrase: responseCode === 499 ? "Client Closed Request" : "OK",
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    body: Buffer.from(JSON.stringify(payload)).toString("base64"),
  }).catch((error) => writeDiagnostics.push(error.message));
  cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
    const parsed = new URL(request.url);
    if (request.method === "POST" && /^\/api\/(?:approvals\/[^/]+|requests\/[^/]+\/respond)$/.test(parsed.pathname)) {
      approvalWrites.push({ path: parsed.pathname, body: JSON.parse(request.postData) });
      if (heldInteractive) heldInteractive.requestId = requestId;
      else {
        fixtureApprovals.delete(decodeURIComponent(parsed.pathname.split('/')[3]));
        fulfillWrite(requestId, { ok: true });
      }
      return;
    }
    if (parsed.pathname === "/api/status") {
      statusReads += 1;
      if (delayedStatus) {
        delayedStatus.requestId = requestId;
        return;
      }
      if (statusFailures > 0) {
        statusFailures -= 1;
        fulfillWrite(requestId, { error: "测试：状态读取暂时失败" }, 503);
        return;
      }
    }
    if (parsed.pathname === "/api/threads/mobile-e2e-other") {
      const result = jsonRoute(new URL("/api/threads/mobile-e2e-thread", parsed).href);
      result.thread = { ...result.thread, id: "mobile-e2e-other", name: "另一个任务" };
      result.history = { data: [], nextCursor: null };
      fulfillWrite(requestId, result);
      return;
    }
    if (writeScenario && request.method === "POST" && /\/(turns|steer)$/.test(parsed.pathname)) {
      const id = Object.entries(request.headers).find(([key]) => key.toLowerCase() === "x-codex-pwa-write-id")?.[1];
      writeAttempts += 1;
      const record = { originalRequest: requestId, state: writeScenario === "lost-reply" ? "succeeded" : "queued",
        clientUserMessageId: JSON.parse(request.postData).clientUserMessageId,
        position: 1, waitingOn: { label: "工作电脑", currentDevice: false },
        resultAvailable: true, result: { turn: { id: "recovered-write", status: "inProgress" }, settings: {} },
      };
      identifiedWrites.set(id, record);
      if (writeScenario === "lost-reply") cdp.send("Fetch.failRequest", { requestId, errorReason: "ConnectionClosed" }).catch(() => {});
      return;
    }
    const writeId = parsed.pathname.match(/\/writes\/([^/]+)$/)?.[1];
    if (writeId && identifiedWrites.has(writeId)) {
      const record = identifiedWrites.get(writeId);
      if (request.method === "DELETE" && record.state === "queued") {
        record.state = "cancelled";
        record.error = "请求已取消，尚未发送给 Codex";
        record.details = { code: "THREAD_WRITE_CANCELLED", dispatched: false, outcomeUnknown: false };
        fulfillWrite(record.originalRequest, { error: record.error, details: record.details }, 499);
      }
      const { originalRequest, ...snapshot } = record;
      fulfillWrite(requestId, snapshot);
      return;
    }
    if (parsed.pathname === "/api/events") {
      cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "text/event-stream" }],
        body: Buffer.from('data: {"kind":"bridge/status","status":"ready"}\n\n').toString("base64"),
      }).catch(() => {});
      return;
    }
    if (parsed.pathname === "/api/files/raw" || parsed.pathname.endsWith("/artifacts/generated-mobile-image/raw")) {
      cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "image/png" }],
        body: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      }).catch(() => {});
      return;
    }
    const fulfillJson = () => {
      const result = jsonRoute(request.url);
      if (parsed.pathname === '/api/status') {
        result.pendingApprovals = [...fixtureApprovals.values()];
        if (messageCorrelationEnabled) result.protocol = { bridgeCapabilities: { clientMessageCorrelation: true } };
      }
      if (parsed.pathname === '/api/files/list') fileListReads += 1;
      if (activityFixture && parsed.pathname === '/api/threads/mobile-e2e-thread') result.history.data.push(activityFixture);
      if (activityFixture && parsed.pathname.endsWith('/turns') && parsed.searchParams.get('items') === 'full') {
        result.data = [activityFixture];
      } else if (paginatedContext && parsed.pathname.endsWith('/turns')) {
        const older = parsed.searchParams.has('cursor');
        result.data = result.data.slice(older ? 20 : 0, older ? 40 : 20);
        result.nextCursor = older ? null : 'context-older-20';
      }
      if (parsed.pathname === "/api/threads/mobile-e2e-thread") threadReads += 1;
      if (parsed.pathname === "/api/threads" && threadListOverride) result.data = threadListOverride;
      const body = Buffer.from(JSON.stringify(result)).toString("base64");
      cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body,
      }).catch(() => {});
    };
    if (parsed.pathname.endsWith("/turns")) setTimeout(fulfillJson, 250);
    else if (parsed.pathname.endsWith("/artifacts")) setTimeout(fulfillJson, 150);
    else fulfillJson();
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  // This fixture exercises the page's event handlers. A fulfilled Fetch response
  // immediately closes native SSE, so use a stable connection instead of an
  // accidental reconnect loop. Real SSE transport has separate HTTP coverage.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.EventSource = class {
      constructor() { this.openTimer = setTimeout(() => this.onopen?.(), 0); }
      close() { clearTimeout(this.openTimer); }
    };`,
  });
  const recoveryBase = jsonRoute(`http://127.0.0.1:${appPort}/api/threads`).data[0];
  threadListOverride = [recoveryBase, ...[
    ["recover-running", { type: "active" }],
    ["recover-waiting", { type: "active", activeFlags: ["waitingOnApproval"] }],
    ["recover-error", { type: "systemError" }],
    ["recover-saved", { type: "notLoaded" }],
    ["recover-unknown", { type: "futureStatus" }],
  ].map(([id, status]) => ({ ...recoveryBase, id, name: id, status }))];
  const startupSnapshot = [...threadListOverride.map((thread) => thread.id), "recover-missing"]
    .map((id) => ({ id, status: "active", at: 10 }));
  const seedSnapshot = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem("codex-pwa-active-task-snapshot", ${JSON.stringify(JSON.stringify(startupSnapshot))})`,
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/` });
  await waitForExpression(cdp, `Boolean(document.getElementById("appShell") && !document.getElementById("appShell").classList.contains("hidden") && document.querySelector(".thread-card"))`);
  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: seedSnapshot.identifier });
  const recoveryToast = await evaluate(cdp, `document.getElementById("toast").textContent`);
  for (const phrase of ["仍在运行", "等待操作", "已空闲", "出现异常", "3 个后台任务状态待核实"]) assert.ok(recoveryToast.includes(phrase), recoveryToast);
  assert.doesNotMatch(recoveryToast, /已完成/);
  assert.equal(await evaluate(cdp, `JSON.parse(localStorage.getItem("codex-pwa-active-task-snapshot")).filter(item => item.status === "unconfirmed").length`), 3);
  for (const [filter, expected] of [["saved", "recover-saved"], ["unknown", "recover-unknown"], ["idle", "mobile-e2e-thread"]]) {
    await evaluate(cdp, `(() => { const select = document.getElementById("threadFilter"); select.value = ${JSON.stringify(filter)}; select.dispatchEvent(new Event("change")); })()`);
    assert.deepEqual(await evaluate(cdp, `[...document.querySelectorAll('.thread-card')].map(node => node.dataset.threadId)`), [expected]);
  }
  await evaluate(cdp, `(() => { const select = document.getElementById("threadFilter"); select.value = "all"; select.dispatchEvent(new Event("change")); })()`);
  threadListOverride = null;
  await evaluate(cdp, `document.getElementById("refreshButton").click()`);
  await waitForExpression(cdp, `document.querySelectorAll('.thread-card').length === 1`);
  assert.equal(await evaluate(cdp, `JSON.parse(localStorage.getItem("codex-pwa-active-task-snapshot")).some(item => item.id === "recover-missing" && item.status === "unconfirmed")`), true,
    "a partial list refresh keeps the earlier unresolved task");

  const shellGeometry = await evaluate(cdp, `({
    innerHeight,
    documentHeight: document.documentElement.scrollHeight,
    bodyHeight: document.body.scrollHeight,
    cardCount: document.querySelectorAll(".thread-card").length
  })`);
  assert.equal(shellGeometry.cardCount, 1);
  assert.ok(shellGeometry.documentHeight <= shellGeometry.innerHeight + 1);
  assert.ok(shellGeometry.bodyHeight <= shellGeometry.innerHeight + 1);
  assert.equal(
    await evaluate(cdp, `document.getElementById("chatMeta").textContent`),
    "点击左侧主菜单查看历史任务",
  );

  const accessibleNode = async (selector) => {
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    assert.ok(nodeId, selector);
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    return nodes[0];
  };
  const key = async (key, modifiers = 0) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key === ' ' ? 'Space' : key, modifiers,
      windowsVirtualKeyCode: { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35, ' ': 32 }[key] });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key === ' ' ? 'Space' : key, modifiers });
  };
  const touchFindings = [];
  const tapSelectionMargin = async (selector) => {
    await waitForExpression(cdp, `(() => {
      const sidebar = document.querySelector(${JSON.stringify(selector)}).closest('#sidebar');
      return !sidebar || sidebar.getBoundingClientRect().left >= -0.5;
    })()`);
    const point = await evaluate(cdp, `(() => {
      const target = document.querySelector(${JSON.stringify(selector)}).closest('label');
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      const box = target.getBoundingClientRect(); return { x: box.left + 3, y: box.top + box.height / 2 };
    })()`);
    assert.equal(await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).closest('label').contains(document.elementFromPoint(${point.x}, ${point.y}))`), true,
      `the selection label margin is hittable at ${JSON.stringify(point)}`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 1, radiusY: 1, force: 1, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const inspectTouchTargets = async (root) => {
    touchFindings.push(...await evaluate(cdp, `(() => {
      const root = document.querySelector(${JSON.stringify(root)});
      return [...root.querySelectorAll('button, summary, input:not([type="hidden"]), select, textarea, [role="button"], a[role="menuitem"]')]
        .filter(node => node.getClientRects().length && !node.closest('[inert]') && getComputedStyle(node).visibility === 'visible')
        .map(node => {
          const target = node.matches('input[type="checkbox"], input[type="radio"]') ? node.closest('label') || node : node;
          const rect = target.getBoundingClientRect();
          return { root: ${JSON.stringify(root)}, name: node.id || node.getAttribute('aria-label') || node.textContent.trim().slice(0, 25), width: rect.width, height: rect.height };
        }).filter(item => item.width < 43.5 || item.height < 43.5);
    })()`));
  };
  assert.equal((await accessibleNode("#sidebar")).ignored, true,
    "a closed mobile drawer must be absent from the accessibility tree");
  await evaluate(cdp, `document.getElementById("menuButton").focus(); document.getElementById("menuButton").click()`);
  assert.equal((await accessibleNode("#sidebar")).role.value, "dialog");
  assert.equal((await accessibleNode("#menuButton")).ignored, true, "background controls are inert while the mobile drawer is open");
  await evaluate(cdp, `document.getElementById("closeSidebarButton").focus()`);
  await key("Tab", 8);
  assert.equal(await evaluate(cdp, `document.getElementById("sidebar").contains(document.activeElement)`), true);
  await key("Escape");
  assert.equal(await evaluate(cdp, `document.activeElement.id`), "menuButton");
  assert.equal((await accessibleNode("#sidebar")).ignored, true);
  await evaluate(cdp, `document.getElementById("menuButton").click()`);
  await inspectTouchTargets('#sidebar');
  await tapSelectionMargin('.thread-select');
  await waitForExpression(cdp, `document.querySelector('.thread-select').checked`);
  assert.equal(await evaluate(cdp, `document.getElementById('chatView').classList.contains('hidden')`), true,
    'tapping the checkbox label margin selects the task without opening it');
  await tapSelectionMargin('.thread-select');
  await waitForExpression(cdp, `!document.querySelector('.thread-select').checked`);

  const baseThread = jsonRoute(`http://127.0.0.1:${appPort}/api/threads`).data[0];
  threadListOverride = Array.from({ length: 80 }, (_, index) => ({ ...baseThread, id: `list-task-${index}`,
    name: `列表焦点 ${index}`, updatedAt: baseThread.updatedAt - index, recencyAt: baseThread.recencyAt - index }));
  await evaluate(cdp, `window.dispatchEvent(new Event("focus"))`);
  await waitForExpression(cdp, `document.querySelectorAll('.thread-card').length === 80`);
  await evaluate(cdp, `(() => {
    const target = [...document.querySelectorAll('.thread-card')].find(card => card.querySelector('.thread-title').textContent === '列表焦点 30');
    target.scrollIntoView({ block: 'center' });
    window.__listFocus = target.querySelector('.thread-select'); window.__listFocus.focus({ preventScroll: true });
    window.__listReadingOffset = target.getBoundingClientRect().top;
  })()`);
  threadListOverride[30] = { ...threadListOverride[30], status: { type: "active", activeFlags: [] } };
  threadListOverride.unshift({ ...baseThread, id: "list-new-task", name: "新增任务", recencyAt: baseThread.recencyAt + 1 });
  await evaluate(cdp, `window.dispatchEvent(new Event("focus"))`);
  await waitForExpression(cdp, `document.querySelectorAll('.thread-card').length === 81`);
  assert.equal(await evaluate(cdp, `document.activeElement === window.__listFocus && window.__listFocus.isConnected`), true,
    "background list updates must preserve the focused checkbox node");
  assert.ok(await evaluate(cdp, `Math.abs(window.__listFocus.closest('.thread-card').getBoundingClientRect().top - window.__listReadingOffset) < 3`),
    "inserting newer tasks must keep the currently read card at the same screen position");
  await evaluate(cdp, `(() => {
    window.__listFocus.click();
    document.getElementById('clearSearchButton').click();
  })()`);
  assert.equal(await evaluate(cdp, `window.__listFocus.isConnected && document.activeElement === window.__listFocus && window.__listFocus.checked`), true,
    "an explicit list reload must retain selection and focus while fetching");
  await waitForExpression(cdp, `document.getElementById('threadList').getAttribute('aria-busy') !== 'true'`);
  assert.equal(await evaluate(cdp, `window.__listFocus.isConnected && window.__listFocus.checked`), true);
  threadListOverride = null;
  await evaluate(cdp, `window.dispatchEvent(new Event("focus"))`);
  await waitForExpression(cdp, `document.querySelectorAll('.thread-card').length === 1`);
  assert.equal(await evaluate(cdp, `document.querySelector('.thread-time').textContent`), "刚刚");
  assert.equal(await evaluate(cdp, `document.activeElement === document.querySelector('.thread-select')`), true,
    "when the focused task disappears, focus moves to the nearest remaining equivalent control");

  const openedMenu = await evaluate(cdp, `(() => {
    const button = document.querySelector(".thread-menu-button");
    button.click();
    return {
      popover: Boolean(document.querySelector(".floating-popover")),
      expanded: button.getAttribute("aria-expanded"),
      cardClass: button.closest(".thread-card").className,
    };
  })()`);
  assert.deepEqual(openedMenu, { popover: true, expanded: "true", cardClass: "thread-card menu-open" });
  await waitForExpression(cdp, `document.activeElement?.getAttribute("role") === "menuitem"`);
  await key("End");
  assert.equal(await evaluate(cdp, `document.activeElement === document.querySelector('.floating-popover').lastElementChild`), true);
  await key("Home");
  await key("ArrowDown");
  assert.equal(await evaluate(cdp, `document.activeElement === document.querySelector('.floating-popover').children[1]`), true);
  await key("Escape");
  assert.equal(await evaluate(cdp, `document.activeElement.classList.contains("thread-menu-button")`), true);
  assert.equal(await evaluate(cdp, `document.getElementById("sidebar").classList.contains("open")`), true,
    "Escape closes only the menu, preserving its parent drawer");
  await evaluate(cdp, `document.querySelector(".thread-menu-button").click()`);
  await evaluate(cdp, `new Promise((resolve) => setTimeout(resolve, 700))`);
  assert.equal(await evaluate(cdp, `document.querySelector(".floating-popover") !== null`), true);
  await evaluate(cdp, `document.getElementById("threadList").dispatchEvent(new Event("scroll"))`);
  assert.equal(await evaluate(cdp, `document.querySelector(".floating-popover") === null`), true);
  await evaluate(cdp, `document.querySelector(".thread-menu-button").click()`);
  await waitForExpression(cdp, `document.querySelector(".floating-popover")`);
  await evaluate(cdp, `document.getElementById("threadSearch").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  assert.equal(await evaluate(cdp, `document.querySelector(".floating-popover") === null`), true);

  await evaluate(cdp, `(() => {
    document.querySelector(".thread-menu-button").click();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    return document.querySelector(".floating-popover") === null;
  })()`);
  assert.equal(await evaluate(cdp, `document.querySelector(".floating-popover") === null`), true);
  await evaluate(cdp, `Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange"))`);

  await evaluate(cdp, `document.querySelector(".thread-menu-button").click()`);
  await waitForExpression(cdp, `[...document.querySelectorAll(".floating-popover button")].some((button) => button.textContent.includes("编辑本机标签"))`);
  await evaluate(cdp, `([...document.querySelectorAll(".floating-popover button")].find((button) => button.textContent.includes("编辑本机标签"))).click()`);
  await waitForExpression(cdp, `document.getElementById("tagDialog").open`);
  await evaluate(cdp, `(() => {
    document.getElementById("tagInput").value = "待复核, 移动端";
    document.getElementById("tagForm").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  })()`);
  await waitForExpression(cdp, `!document.getElementById("tagDialog").open && document.querySelector(".thread-tag")`);
  assert.deepEqual(await evaluate(cdp, `({
    tags: [...document.querySelectorAll(".thread-tag")].map((node) => node.textContent),
    stored: JSON.parse(localStorage.getItem("codex-pwa-thread-tags")),
  })`), {
    tags: ["待复核", "移动端"],
    stored: { "mobile-e2e-thread": ["待复核", "移动端"] },
  });
  await evaluate(cdp, `(() => {
    const filter = document.getElementById("threadTagFilter");
    filter.value = "移动端";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  assert.equal(await evaluate(cdp, `document.querySelectorAll(".thread-card").length`), 1);

  await evaluate(cdp, `document.getElementById("menuButton").click(); document.getElementById("trustedDevicesButton").focus(); document.getElementById("trustedDevicesButton").click()`);
  await waitForExpression(cdp, `document.getElementById("devicesDialog").open`);
  const actionBarFonts = await evaluate(cdp, `Object.fromEntries([
    ".directory-actions",
    ".file-browser-actions",
    ".devices-actions",
    ".help-actions",
    ".history-nodes-actions",
    ".confirm-actions",
  ].map((selector) => [
    selector,
    [...document.querySelectorAll(\`\${selector} button\`)].map((button) => getComputedStyle(button).fontSize),
  ]))`);
  for (const [selector, fontSizes] of Object.entries(actionBarFonts)) {
    assert.ok(fontSizes.length >= 2, `${selector} should contain same-level actions`);
    assert.equal(new Set(fontSizes).size, 1, `${selector} should use a consistent font size`);
  }
  await evaluate(cdp, `document.getElementById("devicesDialog").close()`);
  assert.equal(await evaluate(cdp, `document.activeElement?.id`), "menuButton",
    "return to the visible drawer trigger when the original dialog trigger is now hidden");
  await evaluate(cdp, `document.getElementById("menuButton").click()`);

  await evaluate(cdp, `document.querySelector(".thread-main").click()`);
  await waitForExpression(cdp, `document.getElementById("chatTitle").textContent.includes("超长标题")`);
  await waitForExpression(cdp, `!document.getElementById("sidebar").classList.contains("open")`).catch(async (error) => {
    t.diagnostic(JSON.stringify({ writeDiagnostics, ui: await evaluate(cdp, `({ toast: document.getElementById("toast").textContent, sidebar: document.getElementById("sidebar").outerHTML.slice(0, 180), focus: document.activeElement?.id })`) }));
    throw error;
  });
  assert.equal((await accessibleNode("#promptInput")).name.value, "发送给 Codex 的消息");
  assert.equal((await accessibleNode("#contextPanel")).ignored, true);
  await inspectTouchTargets('.topbar');
  await inspectTouchTargets('.composer-zone');
  await evaluate(cdp, `document.getElementById("contextButton").focus(); document.getElementById("contextButton").click()`);
  assert.equal((await accessibleNode("#contextPanel")).role.value, "dialog");
  await inspectTouchTargets('#contextPanel');
  assert.equal((await accessibleNode("#promptInput")).ignored, true);
  await evaluate(cdp, `document.getElementById("changesTab").focus()`);
  await key("End");
  assert.equal(await evaluate(cdp, `document.getElementById("infoTab").getAttribute("aria-selected")`), "true");
  await key("Escape");
  assert.equal(await evaluate(cdp, `document.activeElement.id`), "contextButton");

  // Inspect native modal roles and accessible names using Chrome's real AX tree.
  // This covers programmatic semantics, not VoiceOver/TalkBack audio output.
  const dialogIds = await evaluate(cdp, `[...document.querySelectorAll('dialog')].map((node) => node.id)`);
  for (const id of dialogIds) {
    await evaluate(cdp, `document.getElementById(${JSON.stringify(id)}).showModal()`);
    const dialogNode = await accessibleNode(`#${id}`);
    await inspectTouchTargets(`#${id}`);
    assert.equal(dialogNode.role.value, "dialog", id);
    assert.ok(dialogNode.name?.value?.trim(), `${id} has an accessible title`);
    assert.equal((await accessibleNode("#promptInput")).ignored, true, `${id} keeps background conversation inert`);
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    for (const node of nodes.filter((node) => !node.ignored && ["button", "textbox", "searchbox", "combobox", "checkbox", "spinbutton"].includes(node.role?.value))) {
      assert.ok(node.name?.value?.trim(), `${id}: ${node.role?.value} has an accessible name`);
    }
    if (id === "helpDialog") {
      await evaluate(cdp, `document.getElementById("askWebUiButton").click()`);
      const announcement = await accessibleNode("#helpDialog [data-status-announcement]");
      assert.equal(announcement.ignored, false, "feedback remains accessible inside a native modal");
      assert.equal(announcement.role.value, "status");
      assert.equal(await evaluate(cdp, `document.querySelector('#helpDialog [data-status-announcement]').textContent`), "请先填写想咨询的问题");
    }
    await key("Escape");
    assert.equal(await evaluate(cdp, `document.getElementById(${JSON.stringify(id)}).open`), false, id);
  }
  assert.deepEqual(touchFindings, [], 'primary mobile controls need a 44 CSS pixel touch target or a linked label of that size');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 480, deviceScaleFactor: 2, mobile: true });
  await evaluate(cdp, `document.documentElement.style.fontSize = '32px'`);
  // Font metrics differ on fresh Linux accounts. Exercise a taller line box so
  // text-based close icons cannot depend on this user's installed system font.
  await evaluate(cdp, `document.querySelectorAll('.icon-button').forEach(button => { button.style.lineHeight = '1.5'; })`);
  assert.ok(await evaluate(cdp, `parseFloat(getComputedStyle(document.querySelector('.message-body')).fontSize) >= 24`),
    'conversation text respects a 200% browser default font size');
  const enlargedFailures = [];
  for (const id of dialogIds) {
    await evaluate(cdp, `document.getElementById(${JSON.stringify(id)}).showModal()`);
    enlargedFailures.push(...await evaluate(cdp, `(() => {
      const dialog = document.getElementById(${JSON.stringify(id)});
      const failures = [];
      if (dialog.scrollWidth > dialog.clientWidth + 1) failures.push({ dialog: dialog.id, overflow: dialog.scrollWidth - dialog.clientWidth });
      for (const button of dialog.querySelectorAll('button')) {
        if (!button.getClientRects().length) continue;
        if (button.scrollHeight > button.clientHeight + 1) failures.push({ dialog: dialog.id, clippedButton: button.id || button.textContent, pixels: button.scrollHeight - button.clientHeight });
      }
      const last = [...dialog.querySelectorAll('button')].filter(node => node.getClientRects().length).at(-1);
      if (last) {
        last.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        const rect = last.getBoundingClientRect(); const box = dialog.getBoundingClientRect();
        if (rect.top < box.top - 1 || rect.bottom > box.bottom + 1) failures.push({ dialog: dialog.id, unreachable: last.id || last.textContent });
      }
      return failures;
    })()`));
    await key('Escape');
  }
  await evaluate(cdp, `document.documentElement.style.fontSize = ''`);
  await evaluate(cdp, `document.querySelectorAll('.icon-button').forEach(button => { button.style.lineHeight = ''; })`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  assert.deepEqual(enlargedFailures, [], '200% text at 320 CSS pixels keeps modal actions readable and reachable');
  // Native close watchers group multiple programmatic opens without user
  // activation. Open the child through a real pointer action, as users do.
  await evaluate(cdp, `(() => {
    document.getElementById("helpDialog").showModal();
    const button = document.getElementById("askWebUiButton");
    button.addEventListener("click", () => document.getElementById("confirmDialog").showModal(), { once: true, capture: true });
    queueMicrotask(() => button.focus());
  })()`);
  await waitForExpression(cdp, `document.activeElement.id === "askWebUiButton"`).catch(async (error) => {
    t.diagnostic(JSON.stringify(await evaluate(cdp, `({ focus: document.activeElement.id, open: [...document.querySelectorAll('dialog[open]')].map(node => node.id), disabled: document.getElementById('askWebUiButton').disabled })`)));
    throw error;
  });
  const nestedTrigger = await evaluate(cdp, `(() => { const button = document.getElementById("askWebUiButton");
    button.scrollIntoView({ block: "center" }); const box = button.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...nestedTrigger, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...nestedTrigger, button: "left", clickCount: 1 });
  const nestedAnnouncement = await evaluate(cdp, `({ message: document.querySelector('#confirmDialog [data-status-announcement]').textContent,
    helpOpen: document.getElementById('helpDialog').open, confirmOpen: document.getElementById('confirmDialog').open, focus: document.activeElement.id })`);
  assert.equal(nestedAnnouncement.message, "请先填写想咨询的问题",
    `announcements follow modal opening order: ${JSON.stringify(nestedAnnouncement)}`);
  assert.equal((await accessibleNode("#helpDialog")).ignored, true);
  await key("Escape");
  const nestedFocus = await evaluate(cdp, `({ helpOpen: document.getElementById("helpDialog").open, confirmOpen: document.getElementById("confirmDialog").open,
    focus: document.activeElement.id, parent: document.activeElement.closest('dialog')?.id })`);
  assert.equal(nestedFocus.helpOpen && nestedFocus.parent === "helpDialog", true, JSON.stringify(nestedFocus));
  await key("Escape");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForExpression(cdp, `!document.getElementById("sidebar").inert`);
  assert.equal((await accessibleNode("#sidebar")).role.value, "complementary");
  assert.equal((await accessibleNode("#contextPanel")).ignored, true);
  await evaluate(cdp, `document.getElementById("contextButton").click()`);
  assert.equal((await accessibleNode("#contextPanel")).role.value, "complementary");
  assert.equal((await accessibleNode("#promptInput")).ignored, false,
    "desktop details are a nonmodal panel, so the composer remains accessible");
  await evaluate(cdp, `document.getElementById("closeContextButton").click()`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await waitForExpression(cdp, `document.getElementById("sidebar").inert`);
  const messageTimes = () => evaluate(cdp, `(() => {
    const time = (selector) => {
      const meta = document.querySelector(selector + " .message-meta");
      return { datetime: meta?.dateTime, estimated: meta?.dataset.estimated, source: meta?.dataset.source, startedAt: meta?.dataset.startedAt, completedAt: meta?.dataset.completedAt };
    };
    return { user: time('[data-item-id="user-mobile-1"]'), fallback: time('[data-item-id="user-mobile-fallback"]'), reply: time('.message-row.assistant') };
  })()`);
  const beforeReloadTimes = await messageTimes();
  assert.equal(beforeReloadTimes.user.datetime, "2026-09-15T00:00:01.000Z");
  assert.equal(beforeReloadTimes.user.estimated, "false");
  assert.equal(beforeReloadTimes.fallback.datetime, "2026-09-15T00:00:00.000Z");
  assert.equal(beforeReloadTimes.fallback.source, "turn-start");
  assert.equal(beforeReloadTimes.fallback.estimated, "true");
  assert.equal(await evaluate(cdp, `document.querySelector('[data-item-id="user-mobile-fallback"] .message-meta').textContent.startsWith("约 ")`), true);
  assert.equal(beforeReloadTimes.reply.datetime, "2026-09-15T00:00:05.000Z");
  assert.equal(beforeReloadTimes.reply.startedAt, "2026-09-15T00:00:02.000Z");
  assert.equal(beforeReloadTimes.reply.completedAt, "2026-09-15T00:00:05.000Z");
  const reloaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  await cdp.send("Page.reload", { ignoreCache: true });
  await reloaded;
  await waitForExpression(cdp, `document.querySelector('[data-item-id="user-mobile-1"] .message-meta')`).catch(async (error) => {
    t.diagnostic(JSON.stringify({ writeDiagnostics, ui: await evaluate(cdp, `({ href: location.href, title: document.getElementById("chatTitle")?.textContent, auth: document.getElementById("authGate")?.className, toast: document.getElementById("toast")?.textContent, messages: document.getElementById("messages")?.textContent.slice(0, 200) })`) }));
    throw error;
  });
  assert.deepEqual(await messageTimes(), beforeReloadTimes);
  await waitForExpression(cdp, `document.querySelector(".inline-server-image") && !document.querySelector(".image-artifact")`);
  const outline = await evaluate(cdp, `(() => {
    const navigation = document.querySelector(".message-outline");
    const links = [...document.querySelectorAll(".message-outline-link")];
    return {
      present: Boolean(navigation),
      open: navigation?.open || false,
      count: links.length,
      targetExists: links[0] ? Boolean(document.querySelector(links[0].getAttribute("href"))) : false,
    };
  })()`);
  assert.deepEqual(outline, { present: true, open: false, count: 3, targetExists: true });
  await evaluate(cdp, `(() => {
    const outline = document.querySelector('.message-outline'); outline.open = true;
    window.__messageLink = outline.querySelector('a'); window.__messageLink.focus();
    window.__messageText = document.querySelector('.message-row.assistant .message-body p').firstChild;
    const selection = getSelection(); const range = document.createRange();
    range.setStart(window.__messageText, 0); range.setEnd(window.__messageText, 4);
    selection.removeAllRanges(); selection.addRange(range);
  })()`);
  const readsBeforeRefresh = threadReads;
  await evaluate(cdp, `window.dispatchEvent(new Event('focus'))`);
  for (let attempt = 0; attempt < 100 && threadReads <= readsBeforeRefresh; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(threadReads > readsBeforeRefresh, "the selected task was reloaded");
  await evaluate(cdp, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  assert.deepEqual(await evaluate(cdp, `({
    connected: window.__messageLink.isConnected, focused: document.activeElement === window.__messageLink,
    expanded: document.querySelector('.message-outline').open,
    selection: getSelection().toString(), textConnected: window.__messageText.isConnected,
  })`), { connected: true, focused: true, expanded: true, selection: "布局检查", textConnected: true },
  "unchanged message refreshes must preserve reading controls and text selection");
  const primaryMessageTimes = await evaluate(cdp, `(() => ({
    count: document.querySelectorAll(".message-meta").length,
    values: [...document.querySelectorAll(".message-meta")].map((node) => node.textContent),
    allHaveSeconds: [...document.querySelectorAll(".message-meta")].every((node) => /:\\d{2}$/.test(node.textContent)),
  }))()`);
  assert.equal(primaryMessageTimes.count, 3);
  assert.equal(primaryMessageTimes.allHaveSeconds, true);
  assert.ok(primaryMessageTimes.values.every(Boolean));
  const inlineImage = await evaluate(cdp, `(() => {
    const image = document.querySelector(".inline-server-image");
    return {
      src: image.getAttribute("src"),
      path: image.dataset.serverPath,
      parentClass: image.parentElement.className,
      artifactCount: document.querySelectorAll(".image-artifact").length,
    };
  })()`);
  assert.match(inlineImage.src, /^\/api\/files\/raw\?path=/);
  assert.equal(inlineImage.path, "/srv/example/project/annotated.png");
  assert.match(inlineImage.parentClass, /inline-server-image-link/);
  assert.equal(inlineImage.artifactCount, 0);
  const titleGeometry = await evaluate(cdp, `(() => {
    const title = document.getElementById("chatTitle").getBoundingClientRect();
    const actions = document.querySelector(".topbar-actions").getBoundingClientRect();
    return { titleRight: title.right, actionsLeft: actions.left, overflow: getComputedStyle(document.getElementById("chatTitle")).textOverflow };
  })()`);
  assert.equal(titleGeometry.overflow, "ellipsis");
  assert.ok(titleGeometry.titleRight <= titleGeometry.actionsLeft + 1);
  const topbarMenuGeometry = await evaluate(cdp, `(() => {
    const summary = document.querySelector("#chatMenu > summary");
    const activeThread = document.querySelector(".thread-card.active");
    return {
      newTaskButtonExists: Boolean(document.getElementById("topNewTaskButton")),
      menuText: summary.textContent.trim(),
      menuFits: summary.scrollWidth <= summary.clientWidth && summary.scrollHeight <= summary.clientHeight,
      activeThreadRadius: getComputedStyle(activeThread).borderRadius,
      activeThreadBackground: getComputedStyle(activeThread).backgroundColor,
    };
  })()`);
  assert.equal(topbarMenuGeometry.newTaskButtonExists, false);
  assert.equal(topbarMenuGeometry.menuText, "⋮");
  assert.equal(topbarMenuGeometry.menuFits, true);
  assert.equal(topbarMenuGeometry.activeThreadRadius, "0px");
  assert.notEqual(topbarMenuGeometry.activeThreadBackground, "rgba(0, 0, 0, 0)");

  await evaluate(cdp, `document.getElementById("menuButton").click(); document.getElementById("serverFilesButton").click()`);
  await waitForExpression(cdp, `document.getElementById("fileBrowserDialog").open && document.querySelector(".file-entry-menu-button")`);
  const fileReadsBeforeSelection = fileListReads;
  await tapSelectionMargin('.file-entry[title="/srv/example/folder"] .file-entry-select');
  await waitForExpression(cdp, `document.querySelector('.file-entry[title="/srv/example/folder"] .file-entry-select').checked`);
  await evaluate(cdp, `document.querySelector('.file-entry[title="/srv/example/folder"] .file-entry-select').focus()`);
  await key(' ');
  assert.equal(await evaluate(cdp, `document.querySelector('.file-entry[title="/srv/example/folder"] .file-entry-select').checked`), false);
  assert.equal(fileListReads, fileReadsBeforeSelection, 'selecting a folder by label or Space must not navigate into it');
  await inspectTouchTargets('#fileBrowserDialog');
  assert.deepEqual(touchFindings, []);
  const fileRowGeometry = await evaluate(cdp, `(() => {
    const row = document.querySelector(".file-entry");
    const menu = row.querySelector(".file-entry-menu-button");
    menu.click();
    const rowBox = row.getBoundingClientRect();
    const menuBox = menu.getBoundingClientRect();
    return {
      radius: getComputedStyle(row).borderRadius,
      rightInset: rowBox.right - menuBox.right,
      background: getComputedStyle(row).backgroundColor,
    };
  })()`);
  assert.equal(fileRowGeometry.radius, "0px");
  assert.ok(fileRowGeometry.rightInset >= 12);
  assert.notEqual(fileRowGeometry.background, "rgba(0, 0, 0, 0)");
  await waitForExpression(cdp, `document.activeElement?.getAttribute("role") === "menuitem"`);
  await evaluate(cdp, `document.getElementById('messages').dispatchEvent(new Event('scroll'))`);
  assert.equal(await evaluate(cdp, `Boolean(document.querySelector('.floating-popover'))`), true,
    "background conversation scrolling must not dismiss actions in the file dialog");
  assert.equal((await accessibleNode(".floating-popover")).ignored, false,
    "a file action menu must remain in the native dialog's accessible subtree");
  assert.equal(await evaluate(cdp, `(() => { const menu = document.querySelector('.floating-popover');
    const box = menu.firstElementChild.getBoundingClientRect();
    return menu.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })()`), true,
    "the native modal must not cover its file actions");
  await key("Escape");
  assert.equal(await evaluate(cdp, `document.getElementById("fileBrowserDialog").open`), true);
  await evaluate(cdp, `document.getElementById("fileBrowserDialog").close()`);

  await evaluate(cdp, `document.getElementById("menuButton").click(); document.getElementById("helpButton").click()`);
  await waitForExpression(cdp, `document.getElementById("helpDialog").open`);
  assert.equal(await evaluate(cdp, `document.activeElement === document.getElementById("helpQuestionInput")`), false);
  await evaluate(cdp, `document.getElementById("helpDialog").close(); document.getElementById("historyNodesButton").click()`);
  await waitForExpression(cdp, `document.querySelector(".history-nodes-loading")?.textContent.includes("加载中")`);
  assert.equal(await evaluate(cdp, `document.querySelector(".history-nodes-empty:not(.history-nodes-loading)") !== null`), false);
  assert.equal(await evaluate(cdp, `document.getElementById("historyNodesList").getAttribute("aria-busy")`), "true");
  await waitForExpression(cdp, `document.getElementById("historyNodesDialog").open && document.querySelectorAll(".history-node").length > 10`);
  assert.equal(await evaluate(cdp, `document.getElementById("historyNodesList").getAttribute("aria-busy")`), "false");

  const initialHistoryGeometry = await evaluate(cdp, `(() => {
    const list = document.getElementById("historyNodesList");
    const canvas = document.getElementById("historyNodesCanvas");
    const rows = [...document.querySelectorAll(".history-node")];
    const datesFit = rows.every((row) => {
      const rowRect = row.getBoundingClientRect();
      const timeRect = row.querySelector(".history-node-time").getBoundingClientRect();
      return timeRect.top >= rowRect.top - 0.5 && timeRect.bottom <= rowRect.bottom + 0.5;
    });
    return {
      rendered: rows.length,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      canvasHeight: canvas.getBoundingClientRect().height,
      datesFit,
    };
  })()`);
  assert.ok(initialHistoryGeometry.rendered < 80, JSON.stringify(initialHistoryGeometry));
  assert.ok(initialHistoryGeometry.scrollHeight > initialHistoryGeometry.clientHeight * 20);
  assert.ok(initialHistoryGeometry.canvasHeight >= 800 * 74);
  assert.equal(initialHistoryGeometry.datesFit, true);
  await evaluate(cdp, `window.__scaledHistoryFocus = document.querySelector('[data-history-node-index="18"]');
    window.__scaledHistoryFocus.focus({ preventScroll: true }); document.documentElement.style.fontSize = '32px'`);
  await waitForExpression(cdp, `document.getElementById('historyNodesCanvas').getBoundingClientRect().height >= 800 * 124`);
  assert.equal(await evaluate(cdp, `window.__scaledHistoryFocus.isConnected && document.activeElement === window.__scaledHistoryFocus`), true,
    'changing the font size preserves the same focused history node');
  assert.equal(await evaluate(cdp, `[...document.querySelectorAll('.history-node')].every(row => {
    const box = row.getBoundingClientRect(); const date = row.querySelector('.history-node-time').getBoundingClientRect();
    return date.top >= box.top && date.bottom <= box.bottom && row.clientHeight >= row.scrollHeight;
  })`), true, 'enlarged history text and dates remain inside each virtual row');
  assert.ok(await evaluate(cdp, `document.querySelectorAll('.history-node').length < 80`));
  await evaluate(cdp, `document.documentElement.style.fontSize = ''`);
  await waitForExpression(cdp, `document.getElementById('historyNodesCanvas').getBoundingClientRect().height === 800 * 74`);

  await evaluate(cdp, `(() => {
    window.__historyFocused = document.querySelector('[data-history-node-index="18"]');
    window.__historyFocused.focus({ preventScroll: true });
    const list = document.getElementById('historyNodesList'); list.scrollTop = 18 * 74;
    list.dispatchEvent(new Event('scroll'));
  })()`);
  await waitForExpression(cdp, `document.querySelector('.history-node')?.dataset.historyNodeIndex > 0`);
  assert.equal(await evaluate(cdp, `document.activeElement === window.__historyFocused && window.__historyFocused.isConnected`), true,
    "a virtual range shift must not replace the still-visible focused history node");
  for (let index = 0; index < 35; index += 1) await key("ArrowDown");
  assert.equal(await evaluate(cdp, `document.activeElement.dataset.historyNodeIndex`), "53");
  await key("End");
  assert.equal(await evaluate(cdp, `document.activeElement.dataset.historyNodeIndex`), "799");
  assert.equal((await accessibleNode('.history-node-slot:last-child')).role.value, "listitem");
  assert.deepEqual(await evaluate(cdp, `(() => { const slot = document.activeElement.parentElement;
    return [slot.getAttribute('aria-posinset'), slot.getAttribute('aria-setsize')]; })()`), ["800", "800"]);
  await key("Home");
  assert.equal(await evaluate(cdp, `document.activeElement.dataset.historyNodeIndex`), "0");
  assert.ok(await evaluate(cdp, `document.querySelectorAll('.history-node').length < 80`));
  await key("PageDown");
  const pageIndex = Number(await evaluate(cdp, `document.activeElement.dataset.historyNodeIndex`));
  assert.ok(pageIndex > 1 && pageIndex < 20);
  await key("PageUp");
  assert.equal(await evaluate(cdp, `document.activeElement.dataset.historyNodeIndex`), "0");
  await evaluate(cdp, `(() => {
    window.__offscreenHistory = document.activeElement;
    const list = document.getElementById('historyNodesList'); list.scrollTop = 12000;
    list.dispatchEvent(new Event('scroll'));
  })()`);
  await waitForExpression(cdp, `[...document.querySelectorAll('.history-node')].some(node => Number(node.dataset.historyNodeIndex) > 150)`);
  assert.equal(await evaluate(cdp, `document.activeElement === window.__offscreenHistory && window.__offscreenHistory.isConnected`), true,
    "pointer scrolling keeps a single offscreen focused node mounted without growing the entire range");
  assert.ok(await evaluate(cdp, `document.querySelectorAll('.history-node').length < 80`));
  await evaluate(cdp, `(() => {
    const search = document.getElementById('historyNodesSearch'); search.focus(); search.value = '第 800 个';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForExpression(cdp, `document.querySelectorAll('.history-node').length === 1`);
  assert.equal(await evaluate(cdp, `document.activeElement.id`), "historyNodesSearch");
  assert.equal(await evaluate(cdp, `document.querySelector('.history-node').title.includes('第 800 个')`), true);
  await evaluate(cdp, `(() => {
    const search = document.getElementById('historyNodesSearch'); search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  await evaluate(cdp, `(() => {
    const list = document.getElementById("historyNodesList");
    list.scrollTop = 12000;
    list.dispatchEvent(new Event("scroll"));
  })()`);
  await waitForExpression(cdp, `document.querySelector(".history-node")?.dataset.historyNodeIndex > 100`);
  const scrolledHistoryGeometry = await evaluate(cdp, `(() => {
    const list = document.getElementById("historyNodesList");
    const first = document.querySelector(".history-node");
    const rows = [...document.querySelectorAll(".history-node")];
    return {
      scrollTop: list.scrollTop,
      firstIndex: Number(first.dataset.historyNodeIndex),
      rendered: rows.length,
      datesFit: rows.every((row) => {
        const rowRect = row.getBoundingClientRect();
        const timeRect = row.querySelector(".history-node-time").getBoundingClientRect();
        return timeRect.top >= rowRect.top - 0.5 && timeRect.bottom <= rowRect.bottom + 0.5;
      }),
    };
  })()`);
  assert.ok(scrolledHistoryGeometry.scrollTop > 11000);
  assert.ok(scrolledHistoryGeometry.firstIndex > 100);
  assert.ok(scrolledHistoryGeometry.rendered < 80);
  assert.equal(scrolledHistoryGeometry.datesFit, true);

  const selectedHistoryNodeId = await evaluate(cdp, `(() => {
    const node = document.querySelector(".history-node");
    window.__selectedHistoryNodeId = node.title.match(/第 (\\d+) 个历史节点/)?.[1];
    node.click();
    return window.__selectedHistoryNodeId;
  })()`);
  await waitForExpression(cdp, `!document.getElementById("historyNodesDialog").open && document.querySelector(".history-context-banner")`);
  const historyFeedbackGeometry = await evaluate(cdp, `(() => {
    const banner = document.querySelector(".history-context-banner");
    const feedback = document.querySelector(".history-context-feedback");
    const composer = document.querySelector(".composer-zone");
    const bannerBox = banner?.getBoundingClientRect();
    const feedbackBox = feedback?.getBoundingClientRect();
    const composerBox = composer?.getBoundingClientRect();
    return {
      feedbackText: feedback?.textContent || "",
      bannerBottom: bannerBox?.bottom || 0,
      feedbackTop: feedbackBox?.top || 0,
      feedbackBottom: feedbackBox?.bottom || 0,
      composerTop: composerBox?.top || 0,
      messagesTopPadding: getComputedStyle(document.getElementById("messages")).paddingTop,
    };
  })()`);
  assert.equal(historyFeedbackGeometry.feedbackText, "已定位到所选历史节点");
  assert.ok(historyFeedbackGeometry.feedbackTop >= historyFeedbackGeometry.bannerBottom - 1, JSON.stringify(historyFeedbackGeometry));
  assert.ok(historyFeedbackGeometry.feedbackBottom <= historyFeedbackGeometry.composerTop + 1);
  assert.equal(historyFeedbackGeometry.messagesTopPadding, "0px");
  const historyContext = await evaluate(cdp, `(() => {
    const numericId = Number(window.__selectedHistoryNodeId) - 1;
    const targetId = "history-node-" + numericId;
    const target = document.querySelector('.turn-group[data-turn-id="' + targetId + '"]');
    const olderNeighbor = document.querySelector('.turn-group[data-turn-id="history-node-' + (numericId + 1) + '"]');
    const newerNeighbor = document.querySelector('.turn-group[data-turn-id="history-node-' + (numericId - 1) + '"]');
    const groups = [...document.querySelectorAll(".turn-group")];
    return {
      targetId,
      targetIndex: groups.indexOf(target),
      groupCount: groups.length,
      targetClass: target?.className || "",
      targetText: target?.textContent || "",
      targetFolded: Boolean(target?.closest("details.history-context-turn")),
      olderNeighborFolded: Boolean(olderNeighbor?.closest("details.history-context-turn")),
      newerNeighborFolded: Boolean(newerNeighbor?.closest("details.history-context-turn")),
      foldedCount: document.querySelectorAll("details.history-context-turn").length,
      controlsLast: document.getElementById("messages").lastElementChild?.id === "historyControls",
      controls: [...document.querySelectorAll("#historyControls button")].map((button) => button.textContent.trim()),
      latestLabel: document.querySelector(".history-context-banner button")?.textContent.trim(),
    };
  })()`);
  assert.match(historyContext.targetClass, /history-context-target/);
  assert.match(historyContext.targetText, new RegExp(`第 ${selectedHistoryNodeId} 个历史节点`));
  assert.match(historyContext.targetText, /完整 Codex 回复/);
  assert.equal(historyContext.targetFolded, false);
  assert.equal(historyContext.olderNeighborFolded, false);
  assert.equal(historyContext.newerNeighborFolded, false);
  assert.ok(historyContext.foldedCount > 10);
  assert.ok(historyContext.targetIndex > 0 && historyContext.targetIndex < historyContext.groupCount - 1);
  assert.equal(historyContext.controlsLast, true);
  assert.deepEqual(historyContext.controls, ["已载入全部上下文", "已加载完整历史对话", "显示历史对话节点"]);
  assert.equal(historyContext.latestLabel, "返回最新对话");

  const windowStartId = await evaluate(cdp, `(() => {
    const groups = [...document.querySelectorAll('.turn-group')];
    window.__overlapTurn = groups[10].closest('.history-context-turn');
    window.__overlapTurn.open = true;
    const longReply = document.querySelector('.long-reply-toggle'); longReply.click();
    const longTurn = longReply.closest('.turn-group');
    window.__evictedTurn = longTurn.closest('.history-context-turn');
    window.__evictedTurn.open = true;
    window.__evictedTurnId = longTurn.dataset.turnId;
    window.__overlapTurn.querySelector('summary').focus({ preventScroll: true });
    return groups[0].dataset.turnId;
  })()`);
  await evaluate(cdp, `document.querySelector('.history-window-nav[data-direction="older"] button').click()`);
  await waitForExpression(cdp, `document.querySelector('.turn-group').dataset.turnId !== ${JSON.stringify(windowStartId)}`);
  assert.equal(await evaluate(cdp, `window.__overlapTurn.isConnected && window.__overlapTurn.open`), true,
    "overlapping history windows must retain the same expanded turn wrapper");
  assert.equal(await evaluate(cdp, `window.__evictedTurn.isConnected`), false,
    "offscreen turn DOM is evicted to keep the history window bounded");
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.turn-group').length`), 160);
  assert.equal(await evaluate(cdp, `document.getElementById('messages').contains(document.activeElement)`), true,
    "keyboard paging must keep a reading destination focused inside the transcript");
  await evaluate(cdp, `document.querySelector('.history-window-nav[data-direction="newer"] button').click()`);
  await waitForExpression(cdp, `document.querySelector('.turn-group').dataset.turnId === ${JSON.stringify(windowStartId)}`);
  assert.equal(await evaluate(cdp, `window.__overlapTurn.isConnected && window.__overlapTurn.open`), true);
  assert.equal(await evaluate(cdp, `document.querySelector('[data-turn-id="' + window.__evictedTurnId + '"]').closest('.history-context-turn').open`), true,
    "returning to a previously evicted window restores the reader's expanded turn");
  assert.equal(await evaluate(cdp, `document.querySelector('[data-turn-id="' + window.__evictedTurnId + '"] .long-reply-toggle').getAttribute('aria-expanded')`), "true",
    "lightweight history state also restores an evicted long reply's expansion");

  await evaluate(cdp, `document.querySelector(".history-context-banner button").click()`);
  await waitForExpression(cdp, `!document.querySelector(".history-context-banner") && document.querySelector('.turn-group[data-turn-id="turn-mobile-1"]')`);

  activityFixture = {
    id: 'reading-activity-turn', status: 'failed', error: { message: '可恢复的测试错误' },
    items: [
      { id: 'reading-user', type: 'userMessage', text: '保留活动阅读状态' },
      { id: 'reading-command', type: 'commandExecution', command: 'printf fixture', status: 'completed', aggregatedOutput: '原始输出'.repeat(4000), exitCode: 0 },
      { id: 'reading-tool', type: 'mcpToolCall', server: 'fixture', tool: 'read', status: 'completed', result: { text: '工具输出'.repeat(2400) } },
      { id: 'reading-file', type: 'fileChange', status: 'completed', changes: [{ path: '/srv/example/project/file.txt', kind: 'update', diff: Array.from({ length: 600 }, (_, index) => '+line ' + index).join('\n') }] },
    ],
  };
  await evaluate(cdp, `window.dispatchEvent(new Event('focus'))`);
  await waitForExpression(cdp, `document.querySelector('[data-item-id="reading-command"]')`);
  await evaluate(cdp, `(() => {
    window.__commandCard = document.querySelector('[data-item-id="reading-command"]');
    window.__commandCard.open = true;
    window.__commandToggle = window.__commandCard.querySelector('.output-toggle'); window.__commandToggle.click();
    window.__toolCard = document.querySelector('[data-item-id="reading-tool"]'); window.__toolCard.open = true;
    window.__toolCard.querySelector('.output-toggle').click();
    window.__fileCard = document.querySelector('[data-item-id="reading-file"]'); window.__fileCard.open = true;
    window.__fileCard.querySelector('.file-change').open = true;
  })()`);
  await waitForExpression(cdp, `document.querySelector('.diff-load-more')`);
  await evaluate(cdp, `document.querySelector('.diff-load-more').click(); window.__commandToggle.focus({ preventScroll: true })`);
  const beforeActivityRefresh = threadReads;
  await evaluate(cdp, `window.dispatchEvent(new Event('focus'))`);
  for (let attempt = 0; attempt < 100 && threadReads <= beforeActivityRefresh; attempt += 1) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(threadReads > beforeActivityRefresh);
  await evaluate(cdp, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  assert.deepEqual(await evaluate(cdp, `({ command: window.__commandCard.isConnected && window.__commandCard.open,
    tool: window.__toolCard.isConnected && window.__toolCard.open, file: window.__fileCard.isConnected && window.__fileCard.open,
    focused: document.activeElement === window.__commandToggle,
    output: window.__commandCard.querySelector('.terminal-output').textContent.length,
    diff: window.__fileCard.querySelectorAll('.diff-line').length })`),
  { command: true, tool: true, file: true, focused: true, output: 16000, diff: 480 },
  'unchanged history refresh preserves expanded activity output, diff pages and focus');
  await evaluate(cdp, `(() => {
    window.__retryButton = document.querySelector('[data-turn-id="reading-activity-turn"] .turn-retry');
    window.__retryButton.focus({ preventScroll: true });
    document.getElementById('loadMoreHistoryButton').click();
  })()`);
  await waitForExpression(cdp, `document.getElementById('loadMoreHistoryButton').classList.contains('hidden') && !document.getElementById('loadMoreHistoryButton').disabled`);
  assert.equal(await evaluate(cdp, `window.__retryButton.isConnected && document.activeElement === window.__retryButton && window.__commandCard.isConnected && window.__toolCard.isConnected && window.__fileCard.isConnected`), true,
    'replacing a turn with its full activity snapshot preserves unchanged controls and the retry button');
  assert.equal(await evaluate(cdp, `window.__fileCard.querySelectorAll('.diff-line').length`), 480);
  activityFixture = null;
  await evaluate(cdp, `document.getElementById('menuButton').click(); document.querySelector('.thread-main').click()`);
  await waitForExpression(cdp, `!document.querySelector('[data-turn-id="reading-activity-turn"]') && !document.getElementById('sidebar').classList.contains('open')`);

  await evaluate(cdp, `document.getElementById("historyNodesButton").click()`);
  await waitForExpression(cdp, `document.getElementById("historyNodesDialog").open && document.querySelector(".history-node")`);
  paginatedContext = true;
  await evaluate(cdp, `document.querySelector(".history-node").click()`);
  assert.equal(await evaluate(cdp, `!document.getElementById("historyNodesLoading").classList.contains("hidden")`), true);
  await waitForExpression(cdp, `document.querySelector(".history-context-banner")`);
  await evaluate(cdp, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await evaluate(cdp, `(() => {
    const group = document.querySelector('.turn-group'); group.closest('.history-context-turn').open = true;
    window.__contextRead = group.querySelector('.message-copy'); window.__contextRead.focus({ preventScroll: true });
    window.__contextRow = window.__contextRead.closest('.message-row');
    window.__contextRow.scrollIntoView({ block: 'center', behavior: 'instant' });
    window.__contextOffset = window.__contextRow.getBoundingClientRect().top;
    document.querySelector('.history-context-boundary button').click();
  })()`);
  assert.equal(await evaluate(cdp, `window.__contextRead.isConnected && document.activeElement === window.__contextRead`), true,
    'starting a context page request must not rebuild the current reading window');
  await waitForExpression(cdp, `document.querySelectorAll('.turn-group').length === 40`);
  await evaluate(cdp, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const contextReading = await evaluate(cdp, `({ connected: window.__contextRead.isConnected,
    focused: document.activeElement === window.__contextRead,
    expanded: window.__contextRead.closest('.history-context-turn').open,
    delta: window.__contextRow.getBoundingClientRect().top - window.__contextOffset })`);
  const { delta, ...contextControls } = contextReading;
  assert.deepEqual(contextControls,
  { connected: true, focused: true, expanded: true },
  'prepending a context page preserves the current reading position, control and expansion');
  assert.ok(Math.abs(delta) < 3, `context reading row moved by ${delta} pixels`);
  paginatedContext = false;
  await evaluate(cdp, `(() => {
    const input = document.getElementById("promptInput");
    input.value = "从历史节点返回最新位置后发送";
    document.getElementById("composer").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  })()`);
  await waitForExpression(cdp, `document.getElementById("confirmDialog").open`);
  assert.equal(await evaluate(cdp, `document.getElementById("confirmTitle").textContent`), "返回最新对话并发送？");
  assert.equal(await evaluate(cdp, `document.getElementById("confirmEyebrow").textContent`), "返回最新对话");
  assert.equal(await evaluate(cdp, `document.getElementById("confirmEyebrow").lang`), "zh-CN");
  const confirmationColors = await evaluate(cdp, `(() => {
    const button = document.getElementById("submitConfirmButton");
    const style = getComputedStyle(button);
    return { background: style.backgroundColor, color: style.color };
  })()`);
  assert.notEqual(confirmationColors.background, "rgba(0, 0, 0, 0)");
  assert.notEqual(confirmationColors.background, confirmationColors.color);
  await evaluate(cdp, `document.getElementById("submitConfirmButton").click()`);
  await waitForExpression(cdp, `!document.querySelector(".history-context-banner") && [...document.querySelectorAll(".message-row.user .message-body")].some((node) => node.textContent.includes("从历史节点返回最新位置后发送"))`);
  await waitForExpression(cdp, `!document.getElementById("sendButton").disabled`);

  writeScenario = "queued";
  await evaluate(cdp, `(() => {
    document.getElementById("promptInput").value = "排队后取消的消息";
    document.getElementById("composer").requestSubmit();
  })()`);
  await waitForExpression(cdp, `document.getElementById("confirmDialog").open`);
  await evaluate(cdp, `document.getElementById("submitConfirmButton").click()`);
  await waitForExpression(cdp, `document.querySelector("#writeQueueStatus button:not(:disabled)")`);
  const queueGeometry = await evaluate(cdp, `(() => {
    const banner = document.getElementById("writeQueueStatus");
    const button = banner.querySelector("button");
    const box = banner.getBoundingClientRect();
    button.focus();
    return { copy: banner.textContent, left: box.left, right: box.right, width: innerWidth, buttonHeight: button.getBoundingClientRect().height };
  })()`);
  assert.match(queueGeometry.copy, /等待工作电脑的操作完成/);
  assert.ok(queueGeometry.left >= 0 && queueGeometry.right <= queueGeometry.width + 1);
  assert.ok(queueGeometry.buttonHeight >= 36);
  // Polling must keep the cancel button node, preserving keyboard focus.
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(await evaluate(cdp, `document.activeElement === document.querySelector("#writeQueueStatus button")`), true);
  await evaluate(cdp, `(() => {
    const input = document.getElementById("promptInput");
    input.value = "等待期间的新草稿";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#writeQueueStatus button").click();
  })()`);
  await waitForExpression(cdp, `document.getElementById("writeQueueStatus").classList.contains("hidden") && !document.getElementById("sendButton").disabled`).catch(async (error) => {
    t.diagnostic(JSON.stringify({ writeDiagnostics, records: [...identifiedWrites], ui: await evaluate(cdp, `({ banner: document.getElementById("writeQueueStatus").outerHTML, toast: document.getElementById("toast").textContent, draft: document.getElementById("promptInput").value })`) }));
    throw error;
  });
  assert.equal(await evaluate(cdp, `document.getElementById("promptInput").value`), "排队后取消的消息\n\n等待期间的新草稿");
  assert.equal(await evaluate(cdp, `[...document.querySelectorAll(".message-row.user .message-body")].some((node) => node.textContent.includes("排队后取消的消息"))`), false);
  assert.equal(writeAttempts, 1);

  for (const outcome of ["cancelled", "succeeded"]) {
    await evaluate(cdp, `(() => {
      document.getElementById("promptInput").value = "切换任务前发送的消息";
      document.getElementById("composer").requestSubmit();
    })()`);
    await waitForExpression(cdp, `document.getElementById("confirmDialog").open`);
    await evaluate(cdp, `document.getElementById("submitConfirmButton").click()`);
    await waitForExpression(cdp, `document.querySelector("#writeQueueStatus button:not(:disabled)")`).catch(async (error) => {
      t.diagnostic(JSON.stringify({ outcome, writeDiagnostics, records: [...identifiedWrites], ui: await evaluate(cdp, `({ title: document.getElementById("chatTitle").textContent, banner: document.getElementById("writeQueueStatus").outerHTML, toast: document.getElementById("toast").textContent })`) }));
      throw error;
    });
    const record = [...identifiedWrites.values()].at(-1);
    await evaluate(cdp, `(() => {
      document.getElementById("promptInput").value = "原任务的新草稿";
      document.getElementById("promptInput").dispatchEvent(new Event("input", { bubbles: true }));
      history.pushState(null, "", "/?thread=mobile-e2e-other");
      dispatchEvent(new PopStateEvent("popstate"));
    })()`);
    await waitForExpression(cdp, `document.getElementById("chatTitle").textContent === "另一个任务"`);
    await evaluate(cdp, `document.getElementById("promptInput").value = "另一个任务的草稿"`);
    record.state = outcome;
    if (outcome === "cancelled") {
      record.error = "请求已取消";
      record.details = { code: "THREAD_WRITE_CANCELLED", dispatched: false };
      await fulfillWrite(record.originalRequest, { error: record.error, details: record.details }, 499);
    } else await fulfillWrite(record.originalRequest, record.result, 202);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await evaluate(cdp, `document.getElementById("promptInput").value`), "另一个任务的草稿");
    assert.equal(await evaluate(cdp, `document.getElementById("stopButton").classList.contains("hidden")`), true);
    assert.equal(await evaluate(cdp, `localStorage.getItem("codex-pwa-draft:mobile-e2e-thread")`),
      outcome === "cancelled" ? "切换任务前发送的消息\n\n原任务的新草稿" : "原任务的新草稿");
    await evaluate(cdp, `history.pushState(null, "", "/?thread=mobile-e2e-thread"); dispatchEvent(new PopStateEvent("popstate"))`);
    await waitForExpression(cdp, `document.getElementById("chatTitle").textContent.startsWith("这是一个用于检查手机屏幕") && !document.getElementById("sendButton").disabled`);
  }

  writeScenario = "lost-reply";
  await evaluate(cdp, `(() => {
    document.getElementById("promptInput").value = "回复丢失后按凭据核对的消息";
    document.getElementById("composer").requestSubmit();
  })()`);
  await waitForExpression(cdp, `document.getElementById("confirmDialog").open`);
  await evaluate(cdp, `document.getElementById("submitConfirmButton").click()`);
  await waitForExpression(cdp, `!document.getElementById("sendButton").disabled && document.getElementById("promptInput").value === ""`);
  assert.equal(writeAttempts, 4, "lost response recovery must not send the message again");
  assert.equal([...identifiedWrites.values()].at(-1).clientUserMessageId, null,
    "updated frontend keeps legacy reconciliation until the running backend advertises correlation support");
  assert.equal(await evaluate(cdp, `document.querySelector(".message-row.user.outcome-unknown") !== null`), false);
  assert.equal(await evaluate(cdp, `document.getElementById("stopButton").classList.contains("hidden")`), false);
  writeScenario = null;

  // Feed controlled live events through the browser's actual SSE handler.
  messageCorrelationEnabled = true;
  // HTTP bridge delivery and replay are exercised separately with a WebSocket daemon fixture.
  await evaluate(cdp, `(() => {
    window.EventSource = class {
      constructor() { window.__testEventSource = this; }
      close() {}
    };
    dispatchEvent(new Event("online"));
  })()`);
  await waitForExpression(cdp, `window.__testEventSource?.onmessage && document.getElementById("stopButton").classList.contains("hidden") && document.querySelector('[data-item-id="user-mobile-1"]')`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const readsBeforeFailure = statusReads;
  statusFailures = 1;
  await evaluate(cdp, `window.__testEventSource.onopen()`);
  await waitForExpression(cdp, `document.getElementById("toast").textContent.includes("任务状态尚未同步")`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(await evaluate(cdp, `document.getElementById("toast").textContent.includes("任务状态已同步")`), false);
  await waitForExpression(cdp, `document.getElementById("toast").textContent.includes("任务状态已同步")`);
  assert.ok(statusReads >= readsBeforeFailure + 2, "recovery retries the failed status read before reporting synchronization");
  const delayedReply = delayedStatus = {};
  await evaluate(cdp, `window.__staleEventSource = window.__testEventSource; window.__testEventSource.onopen()`);
  for (let attempt = 0; attempt < 60 && !delayedReply.requestId; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(delayedReply.requestId, "the browser starts a status read that can be delayed across disconnect");
  await evaluate(cdp, `window.__staleEventSource.onerror()`);
  delayedStatus = null;
  await fulfillWrite(delayedReply.requestId, jsonRoute(`http://127.0.0.1:${appPort}/api/status`));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await evaluate(cdp, `document.getElementById("connectionLabel").textContent`), "正在重新连接…",
    "a late successful HTTP snapshot cannot mark a disconnected event connection ready");
  await waitForExpression(cdp, `window.__testEventSource !== window.__staleEventSource && Boolean(window.__testEventSource.onmessage)`);
  await evaluate(cdp, `window.__testEventSource.onopen()`);
  await waitForExpression(cdp, `document.getElementById("toast").textContent.includes("任务状态已同步") && document.getElementById("connectionLabel").textContent === "服务器已连接"`);
  const sendEvent = (payload) => {
    if (payload.kind === "app-server/request") fixtureApprovals.set(String(payload.requestId), payload);
    if (payload.kind === "app-server/notification" && payload.message.method === "serverRequest/resolved") {
      const id = String(payload.message.params.requestId);
      const pending = fixtureApprovals.get(id);
      if (!pending?.params?.threadId || pending.params.threadId === payload.message.params.threadId) fixtureApprovals.delete(id);
    }
    return evaluate(cdp, `window.__testEventSource.onmessage({ data: JSON.stringify(${JSON.stringify(payload)}) })`);
  };
  const threadId = "mobile-e2e-thread";
  const turnId = "turn-emission-time";
  const emission = Date.parse("2026-09-15T00:01:00.123Z");
  const sendNotification = (method, params, emittedAtMs = emission) => sendEvent({
    kind: "app-server/notification", message: { method, params, emittedAtMs, pwaReceivedAt: (emission + 60_000) / 1000 },
  });
  writeScenario = "queued";
  await evaluate(cdp, `(() => {
    document.getElementById("promptInput").value = "多端相同正文关联验收";
    document.getElementById("composer").requestSubmit();
  })()`);
  await waitForExpression(cdp, `document.getElementById("confirmDialog").open`);
  await evaluate(cdp, `document.getElementById("submitConfirmButton").click()`);
  await waitForExpression(cdp, `document.querySelector("#writeQueueStatus button:not(:disabled)")`);
  const correlatedWrite = [...identifiedWrites.values()].at(-1);
  assert.match(correlatedWrite.clientUserMessageId, /^pwa-[a-f0-9]{32}$/);
  await evaluate(cdp, `window.__pendingCorrelatedMessage = [...document.querySelectorAll(".message-row.user.optimistic")].find((row) => row.textContent.includes("多端相同正文关联验收"))`);
  for (const [id, clientId] of [["external-same-text", "external-browser-message"], ["unattributed-same-text", null]]) {
    await sendNotification("item/started", { threadId, turnId: "recovered-write",
      item: { id, type: "userMessage", clientId, content: [{ type: "text", text: "多端相同正文关联验收" }] } });
    assert.equal(await evaluate(cdp, `window.__pendingCorrelatedMessage.isConnected && window.__pendingCorrelatedMessage.classList.contains("optimistic")`), true,
      "an external identical message must leave this browser's send pending");
  }
  correlatedWrite.state = "succeeded";
  await fulfillWrite(correlatedWrite.originalRequest, correlatedWrite.result, 202);
  await waitForExpression(cdp, `!document.getElementById("sendButton").disabled`);
  writeScenario = null;
  await sendNotification("item/started", { threadId, turnId: "recovered-write",
    item: { id: "own-correlated-echo", type: "userMessage", clientId: correlatedWrite.clientUserMessageId,
      content: [{ type: "text", text: "多端相同正文关联验收" }] } });
  assert.equal(await evaluate(cdp, `document.querySelector('[data-item-id="own-correlated-echo"]') === window.__pendingCorrelatedMessage && !window.__pendingCorrelatedMessage.classList.contains("optimistic")`), true);
  assert.equal(await evaluate(cdp, `[...document.querySelectorAll(".message-row.user .message-body")].filter((body) => body.textContent === "多端相同正文关联验收").length`), 3,
    "two external messages and one local message remain distinct without duplicating the local echo");
  await evaluate(cdp, `Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })`);
  await sendNotification("turn/started", { threadId, turn: { id: "new-live-turn", status: "inProgress" } });
  await sendNotification("turn/completed", { threadId, turn: { id: "new-live-turn", status: "futureStatus" } });
  assert.equal(await evaluate(cdp, `document.getElementById("stopButton").classList.contains("hidden")`), false,
    "an unrecognized outcome cannot clear a known active turn");
  await sendNotification("turn/completed", { threadId, turn: { id: "old-live-turn", status: "completed" } });
  assert.equal(await evaluate(cdp, `document.getElementById("stopButton").classList.contains("hidden")`), false,
    "a late completion cannot clear the newer live turn");
  await sendEvent({ kind: "bridge/taskRecovered", threadId, turnId: "old-recovered-turn", status: "completed", checkedAt: Date.now() });
  assert.equal(await evaluate(cdp, `document.getElementById("stopButton").classList.contains("hidden")`), false,
    "recovered results do not replace the current turn while the page is hidden");
  await evaluate(cdp, `Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange"))`);
  await waitForExpression(cdp, `document.getElementById("stopButton").classList.contains("hidden")`);
  await sendNotification("item/started", { threadId, turnId, item: { id: "live-user", type: "userMessage", text: "事件时间测试" } });
  await sendNotification("item/completed", { threadId, turnId, item: { id: "live-user", type: "userMessage", text: "事件时间测试" } }, emission + 10_000);
  assert.equal(await evaluate(cdp, `document.querySelector('[data-item-id="live-user"] .message-meta').dateTime`), "2026-09-15T00:01:00.123Z");
  await sendNotification("item/agentMessage/delta", { threadId, turnId, itemId: "live-reply", delta: "通知时间回归" }, emission + 1_000);
  await waitForExpression(cdp, `[...document.querySelectorAll(".message-row.assistant")].some((node) => node.textContent.includes("通知时间回归"))`);
  await sendNotification("item/completed", { threadId, turnId, item: { id: "live-reply", type: "agentMessage", text: "通知时间回归" } }, emission + 5_000);
  const liveTiming = await evaluate(cdp, `(() => {
    const row = [...document.querySelectorAll(".message-row.assistant")].find((node) => node.textContent.includes("通知时间回归"));
    const meta = row.querySelector(".message-meta");
    return { datetime: meta.dateTime, startedAt: meta.dataset.startedAt, completedAt: meta.dataset.completedAt,
      source: meta.dataset.source, estimated: meta.dataset.estimated, label: meta.getAttribute("aria-label") };
  })()`);
  assert.equal(liveTiming.datetime, "2026-09-15T00:01:05.123Z");
  assert.equal(liveTiming.startedAt, "2026-09-15T00:01:01.123Z");
  assert.equal(liveTiming.completedAt, liveTiming.datetime);
  assert.equal(liveTiming.source, "emitted");
  assert.equal(liveTiming.estimated, "true");
  assert.match(liveTiming.label, /事件发出时间/);

  await sendNotification("turn/started", { threadId, turn: { id: "failed-without-details", status: "inProgress" } });
  await sendNotification("turn/completed", { threadId, turn: { id: "failed-without-details", status: "failed" } });
  assert.equal(await evaluate(cdp, `document.querySelector('[data-turn-id="failed-without-details"] .turn-error')?.textContent`), "任务执行失败",
    "a failed turn without an error object still displays its outcome");

  await sendEvent({ kind: "app-server/request", requestId: "preceding-approval", method: "item/commandExecution/requestApproval",
    params: { threadId, command: "pwd" } });
  await sendEvent({ kind: "app-server/request", requestId: "typing-question", method: "item/tool/requestUserInput",
    params: { threadId, questions: [{ id: "destination", question: "结果保存到哪里？" }] } });
  await evaluate(cdp, `(() => { const input = document.querySelector('.question-card input[data-freeform]');
    input.value = "正在填写的答案"; input.focus(); input.setSelectionRange(2, 5); })()`);
  await sendEvent({ kind: "app-server/request", requestId: "another-approval", method: "item/commandExecution/requestApproval",
    params: { threadId, command: "pwd" } });
  assert.deepEqual(await evaluate(cdp, `(() => { const input = document.querySelector('.question-card input[data-freeform]');
    return { value: input.value, focused: document.activeElement === input, selection: [input.selectionStart, input.selectionEnd] }; })()`),
    { value: "正在填写的答案", focused: true, selection: [2, 5] }, "a new approval must not erase an answer or move its keyboard focus");
  assert.equal((await accessibleNode('.question-card input[data-freeform]')).name.value, "结果保存到哪里？");
  await inspectTouchTargets('#approvalArea');
  assert.deepEqual(touchFindings, [], 'dynamic question and approval controls keep the same touch target minimum');
  await sendNotification("serverRequest/resolved", { threadId, requestId: "preceding-approval" });
  assert.equal(await evaluate(cdp, `document.activeElement?.value`), "正在填写的答案",
    "removing a preceding approval must preserve focus in the answer");
  await sendNotification("serverRequest/resolved", { threadId, requestId: "another-approval" });
  await sendNotification("serverRequest/resolved", { threadId, requestId: "typing-question" });

  const restrictedApproval = (availableDecisions, requestToken) => ({ kind: "app-server/request", requestId: "decision-list", requestToken,
    method: "item/commandExecution/requestApproval", params: { threadId, command: "pwd", availableDecisions,
      additionalPermissions: { fileSystem: { write: ["/srv/example/reports"] }, network: { enabled: true } } } });
  await sendEvent(restrictedApproval(["decline", "accept"], "restricted-token"));
  assert.deepEqual(await evaluate(cdp, `[...document.querySelectorAll('.approval-card .approval-actions button')].map(button => button.textContent)`),
    ["拒绝", "仅批准一次"], "buttons follow the offered order and cannot grant an unoffered session approval");
  assert.match(await evaluate(cdp, `document.querySelector('.approval-card .approval-context').textContent`), /请求额外权限.*\/srv\/example\/reports/);
  await evaluate(cdp, `document.querySelector('.approval-card button.approve').click()`);
  await waitForExpression(cdp, `document.getElementById('confirmDialog').open`);
  assert.match(await evaluate(cdp, `document.getElementById('confirmDialog').textContent`), /请求额外权限：[\s\S]*\/srv\/example\/reports/);
  await evaluate(cdp, `document.getElementById('cancelConfirmButton').click()`);
  await waitForExpression(cdp, `!document.getElementById('confirmDialog').open && !document.querySelector('.approval-card button').disabled`);
  await sendEvent(restrictedApproval([{ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } }], "rules-only-token"));
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.approval-card .approval-actions button').length`), 0);
  assert.match(await evaluate(cdp, `document.querySelector('.approval-card').textContent`), /没有可在本页提交的审批选项/);
  assert.equal(approvalWrites.length, 0);
  await sendNotification("serverRequest/resolved", { threadId, requestId: "decision-list" });

  const fileRequest = (requestToken, fileChangeContext) => ({ kind: "app-server/request", requestId: "v2-file-context", requestToken,
    method: "item/fileChange/requestApproval", params: { threadId, turnId: "file-turn", itemId: "patch", reason: "确认文件更新" }, fileChangeContext });
  await sendEvent(fileRequest("file-before-context", { status: "unavailable" }));
  assert.match(await evaluate(cdp, `document.querySelector('.approval-card .approval-detail').textContent`), /尚未取得/);
  await evaluate(cdp, `document.querySelector('.approval-card button.approve').click()`);
  await waitForExpression(cdp, `document.getElementById('confirmDialog').open`);
  const fileContext = { status: "available", source: "app-server/fileChange", totalFiles: 2, destructive: true,
    incomplete: false, truncated: false, fingerprint: "test-patch-digest", changes: [
      { path: "/srv/example/project/removed.txt", kind: { type: "delete" } },
      { path: "/srv/example/project/original.txt", kind: { type: "update", move_path: "/srv/example/project/moved.txt" } },
    ] };
  await sendEvent(fileRequest("file-with-context", fileContext));
  await evaluate(cdp, `document.getElementById('submitConfirmButton').click()`);
  await waitForExpression(cdp, `!document.getElementById('confirmDialog').open`);
  assert.equal(approvalWrites.length, 0, "late file details invalidate the old confirmation");
  assert.equal(await evaluate(cdp, `document.querySelector('.approval-card .approval-risk.high').textContent`), "可能覆盖或删除");
  const associatedFiles = await evaluate(cdp, `document.querySelector('.approval-card .approval-context').textContent`);
  assert.match(associatedFiles, /removed\.txt/);
  assert.match(associatedFiles, /moved\.txt/);
  assert.match(associatedFiles, /已关联 2 项/);
  await evaluate(cdp, `document.querySelector('.approval-card button.approve').click()`);
  await waitForExpression(cdp, `document.getElementById('confirmDialog').open`);
  const associatedConfirmation = await evaluate(cdp, `document.getElementById('confirmDialog').textContent`);
  await evaluate(cdp, `document.getElementById('confirmDialog').dispatchEvent(new Event('close'))`);
  assert.equal(await evaluate(cdp, `document.getElementById('confirmDialog').open`), true,
    "a delayed close event from the previous opening cannot close the new confirmation");
  assert.match(associatedConfirmation, /删除：\/srv\/example\/project\/removed\.txt/);
  assert.match(associatedConfirmation, /original\.txt → \/srv\/example\/project\/moved\.txt/);
  await evaluate(cdp, `document.getElementById('cancelConfirmButton').click()`);
  await waitForExpression(cdp, `!document.getElementById('confirmDialog').open && !document.querySelector('.approval-card button').disabled`);
  await sendNotification("serverRequest/resolved", { threadId, requestId: "v2-file-context" });

  // Legacy wire parameters retain conversationId; the bridge adds the verified
  // threadId before exposing the request to the browser.
  await sendEvent({ kind: "app-server/request", requestId: "legacy-file-risk", requestToken: "legacy-file-token",
    method: "applyPatchApproval", params: { conversationId: threadId, threadId, callId: "patch-call",
      reason: "应用文件变更", grantRoot: "/srv/example/project",
      fileChanges: {
        "/srv/example/project/removed.txt": { type: "delete", content: "old" },
        "/srv/example/project/before.txt": { type: "update", unified_diff: "-old\\n+new", move_path: "/srv/example/project/after.txt" },
      } } });
  assert.equal(await evaluate(cdp, `document.querySelector('.approval-card .approval-risk.high')?.textContent`), "可能覆盖或删除");
  const legacyFileContext = await evaluate(cdp, `document.querySelector('.approval-card .approval-context').textContent`);
  assert.match(legacyFileContext, /removed\.txt/);
  assert.match(legacyFileContext, /before\.txt/);
  assert.match(legacyFileContext, /after\.txt/);
  assert.match(legacyFileContext, /请求写入范围/);
  await evaluate(cdp, `document.querySelector('.approval-card button.approve').click()`);
  await waitForExpression(cdp, `document.getElementById('confirmDialog').open`);
  const fileConfirmation = await evaluate(cdp, `document.getElementById('confirmDialog').textContent`);
  assert.match(fileConfirmation, /removed\.txt/);
  assert.match(fileConfirmation, /应用文件变更/);
  await evaluate(cdp, `document.getElementById('cancelConfirmButton').click()`);
  await waitForExpression(cdp, `!document.getElementById('confirmDialog').open && !document.querySelector('.approval-card button').disabled`);
  assert.equal(approvalWrites.length, 0, "cancelling file confirmation sends no decision");
  await sendNotification("serverRequest/resolved", { threadId, requestId: "legacy-file-risk" });

  const replacementApproval = (requestToken) => ({ kind: "app-server/request", requestId: "reused-confirmation", requestToken,
    method: "item/commandExecution/requestApproval", params: { threadId, command: "pwd" } });
  await sendEvent(replacementApproval("original-token"));
  await evaluate(cdp, `document.querySelector('.approval-card button.approve').click()`);
  await waitForExpression(cdp, `document.getElementById('confirmDialog').open`);
  await sendEvent(replacementApproval("replacement-token"));
  await evaluate(cdp, `document.getElementById('submitConfirmButton').click()`);
  await waitForExpression(cdp, `!document.getElementById('confirmDialog').open`);
  assert.equal(approvalWrites.length, 0, "a stale confirmation must never post a decision");
  const heldApproval = heldInteractive = {};
  await evaluate(cdp, `document.querySelector('.approval-card button.approve').click()`);
  await waitForExpression(cdp, `document.getElementById('confirmDialog').open`);
  await evaluate(cdp, `document.getElementById('submitConfirmButton').click()`);
  await waitForExpression(cdp, `document.querySelector('.approval-card')?.getAttribute('aria-busy') === 'true'`).catch(async (error) => {
    t.diagnostic(JSON.stringify({ approvalWrites, pending: [...fixtureApprovals.keys()], ui: await evaluate(cdp, `({
      cards: document.getElementById('approvalArea').innerHTML, toast: document.getElementById('toast').textContent,
      confirmation: document.getElementById('confirmDialog').open })`) }));
    throw error;
  });
  await evaluate(cdp, `window.__busyApprovalCard = document.querySelector('.approval-card'); document.querySelector('.approval-card button.approve').dispatchEvent(new MouseEvent('click'))`);
  await sendEvent(replacementApproval("replacement-token"));
  assert.equal(await evaluate(cdp, `document.querySelector('.approval-card') === window.__busyApprovalCard && [...document.querySelectorAll('.approval-card button')].every(button => button.disabled)`), true);
  assert.equal(await evaluate(cdp, `document.getElementById('confirmDialog').open`), false);
  for (let attempt = 0; attempt < 60 && !heldApproval.requestId; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(approvalWrites.length, 1);
  assert.equal(approvalWrites[0].body.requestToken, "replacement-token");
  await sendEvent(replacementApproval("third-token"));
  heldInteractive = null;
  await fulfillWrite(heldApproval.requestId, { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.approval-card').length`), 1, "a late acknowledgement keeps the newer request visible");
  assert.equal(await evaluate(cdp, `document.querySelector('.approval-card button').disabled`), false);
  await sendNotification("serverRequest/resolved", { threadId, requestId: "reused-confirmation" });

  const heldQuestion = heldInteractive = {};
  await sendEvent({ kind: "app-server/request", requestId: "question-submit", requestToken: "question-token", method: "item/tool/requestUserInput",
    params: { threadId, questions: [{ id: "q", question: "确认回答？" }] } });
  await evaluate(cdp, `(() => { const form = document.querySelector('.question-card'); form.querySelector('input').value = '保留这个回答'; form.requestSubmit(); })()`);
  await waitForExpression(cdp, `document.getElementById('confirmDialog').open`);
  await evaluate(cdp, `document.getElementById('submitConfirmButton').click(); document.querySelector('.question-card').dispatchEvent(new Event('submit', { cancelable: true }))`);
  await waitForExpression(cdp, `document.querySelector('.question-card')?.getAttribute('aria-busy') === 'true'`);
  for (let attempt = 0; attempt < 60 && !heldQuestion.requestId; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(approvalWrites.length, 2);
  assert.deepEqual(approvalWrites[1].body, { answers: { q: { answers: ["保留这个回答"] } }, requestToken: "question-token" });
  heldInteractive = null;
  await fulfillWrite(heldQuestion.requestId, { error: "测试：本次回答未发送", details: { dispatched: false, outcomeUnknown: false } }, 503);
  await waitForExpression(cdp, `!document.querySelector('.question-card input').disabled`);
  assert.equal(await evaluate(cdp, `document.querySelector('.question-card input').value`), "保留这个回答");
  await sendNotification("serverRequest/resolved", { threadId, requestId: "question-submit" });

  await sendEvent({ kind: "app-server/request", requestId: 0, method: "item/commandExecution/requestApproval",
    params: { threadId, command: "pwd" },
  });
  assert.equal(await evaluate(cdp, `document.querySelectorAll(".approval-card").length`), 1);
  await sendNotification("serverRequest/resolved", { threadId: "unrelated", requestId: 0 });
  assert.equal(await evaluate(cdp, `document.querySelectorAll(".approval-card").length`), 1);
  await sendNotification("serverRequest/resolved", { threadId, requestId: 0 });
  assert.equal(await evaluate(cdp, `document.querySelectorAll(".approval-card").length`), 0);
  await sendEvent({ kind: "app-server/request", requestId: "background-request", method: "item/tool/requestUserInput",
    params: { threadId: "mobile-e2e-other", questions: [{ id: "q", question: "测试问题" }] },
  });
  await sendNotification("serverRequest/resolved", { threadId: "mobile-e2e-other", requestId: "background-request" });
  await evaluate(cdp, `history.pushState(null, "", "/?thread=mobile-e2e-other"); dispatchEvent(new PopStateEvent("popstate"))`);
  await waitForExpression(cdp, `document.getElementById("chatTitle").textContent === "另一个任务"`);
  assert.equal(await evaluate(cdp, `document.querySelectorAll(".approval-card, .question-card").length`), 0, "background resolutions must apply before opening that task");

  // Exercise the actual browser ServiceWorkerRegistration notification API.
  // The visibility state is controlled; this is not a physical phone sleep test.
  await cdp.send("Browser.grantPermissions", { origin: `http://127.0.0.1:${appPort}`, permissions: ["notifications"] });
  await evaluate(cdp, `(async () => {
    const registration = await navigator.serviceWorker.ready;
    for (const notification of await registration.getNotifications()) notification.close();
    window.__notificationCalls = [];
    const show = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      const record = { title, options, accepted: false };
      window.__notificationCalls.push(record);
      return show.call(this, title, options).then((result) => {
        record.accepted = true;
        return result;
      }).catch((error) => {
        record.error = error.name + ": " + error.message;
        throw error;
      });
    };
    window.__nativeNotification = window.Notification;
    window.Notification = class {
      static get permission() { return window.__nativeNotification.permission; }
      constructor() { throw new TypeError("Mobile browsers require showNotification"); }
    };
  })()`);
  await sendNotification("turn/completed", { threadId: "mobile-e2e-other", turn: { id: "visible-completed", status: "completed" } });
  assert.equal(await evaluate(cdp, `window.__notificationCalls.length`), 0);
  await evaluate(cdp, `Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })`);
  await sendNotification("turn/completed", { threadId: "unverified-outcome", turn: { id: "unknown-result", status: "futureStatus" } });
  assert.equal(await evaluate(cdp, `window.__notificationCalls.length`), 0, "an unknown completion payload must not notify success");
  await sendNotification("thread/status/changed", { threadId: "system-error-task", status: { type: "systemError" } });
  await waitForExpression(cdp, `window.__notificationCalls.some(notice => notice.accepted && notice.title === "Codex 任务出现异常")`);
  await sendNotification("turn/completed", { threadId: "stopped-task", turn: { id: "stopped-turn", status: "interrupted" } });
  await waitForExpression(cdp, `window.__notificationCalls.some(notice => notice.accepted && notice.title === "Codex 任务已停止")`);
  await sendNotification("turn/completed", { threadId: "mobile-e2e-other", turn: { id: "hidden-completed", status: "completed" } });
  await waitForExpression(cdp, `window.__notificationCalls.some((notice) => notice.accepted && notice.options.data.threadId === "mobile-e2e-other")`);
  const browserNotice = await evaluate(cdp, `(() => {
    const notification = window.__notificationCalls.find((notice) => notice.accepted && notice.options.data.threadId === "mobile-e2e-other");
    return { title: notification.title, tag: notification.options.tag, threadId: notification.options.data.threadId };
  })()`);
  assert.deepEqual(browserNotice, { title: "Codex 任务已完成", tag: "codex-pwa-mobile-e2e-other", threadId: "mobile-e2e-other" });
  assert.equal(await evaluate(cdp, `JSON.parse(localStorage.getItem("codex-pwa-unread-threads")).includes("mobile-e2e-other")`), true);
  // Native acceptance is observable in headless Chrome; actual notification
  // center display remains a device/OS acceptance step.
  await evaluate(cdp, `(async () => {
    for (const notification of await (await navigator.serviceWorker.ready).getNotifications()) notification.close();
  })()`);

  await evaluate(cdp, `history.pushState(null, "", "/?thread=mobile-e2e-thread"); dispatchEvent(new PopStateEvent("popstate"))`);
  await waitForExpression(cdp, `document.querySelector('[data-item-id="user-mobile-1"]')`);
  await sendEvent({ kind: "app-server/request", requestId: "hidden-selected-approval", method: "item/commandExecution/requestApproval",
    params: { threadId, command: "pwd" },
  });
  await waitForExpression(cdp, `window.__notificationCalls.some((notice) => notice.accepted && notice.options.data.threadId === "mobile-e2e-thread" && notice.title === "Codex 等待你的操作")`).catch(async (error) => {
    t.diagnostic(JSON.stringify({ writeDiagnostics, notifications: await evaluate(cdp, `(async () => ({ calls: window.__notificationCalls,
      times: localStorage.getItem("codex-pwa-notification-times"), visibility: document.visibilityState, permission: Notification.permission,
      route: location.search, title: document.getElementById("chatTitle").textContent,
      displayed: (await (await navigator.serviceWorker.ready).getNotifications()).map((notification) => ({ title: notification.title, tag: notification.tag, data: notification.data })) }))()`) }));
    throw error;
  });
  assert.equal(await evaluate(cdp, `JSON.parse(localStorage.getItem("codex-pwa-unread-threads")).includes("mobile-e2e-thread")`), true);
  await sendNotification("serverRequest/resolved", { threadId, requestId: "hidden-selected-approval" });
  await evaluate(cdp, `Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange"))`);
  assert.equal(await evaluate(cdp, `JSON.parse(localStorage.getItem("codex-pwa-unread-threads")).includes("mobile-e2e-thread")`), false);

  await evaluate(cdp, `(async () => {
    const input = document.getElementById("promptInput");
    input.value = "通知切换前的草稿";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
      data: { type: "OPEN_NOTIFICATION_THREAD", threadId: "mobile-e2e-other" },
      source: (await navigator.serviceWorker.ready).active,
    }));
  })()`);
  await waitForExpression(cdp, `document.getElementById("chatTitle").textContent === "另一个任务"`);
  assert.equal(await evaluate(cdp, `new URLSearchParams(location.search).get("thread")`), "mobile-e2e-other");
  await evaluate(cdp, `history.pushState(null, "", "/?thread=mobile-e2e-thread"); dispatchEvent(new PopStateEvent("popstate"))`);
  await waitForExpression(cdp, `document.getElementById("promptInput").value === "通知切换前的草稿"`);
  await evaluate(cdp, `(async () => {
    window.Notification = window.__nativeNotification;
    for (const notification of await (await navigator.serviceWorker.ready).getNotifications()) notification.close();
  })()`);
  await evaluate(cdp, `document.getElementById("notificationButton").click()`);
  await waitForExpression(cdp, `document.getElementById("notificationDialog").open && !document.getElementById("notificationStatus").textContent.includes("正在检查")`);
  const notificationSettings = await evaluate(cdp, `(() => {
    const dialog = document.getElementById("notificationDialog");
    const rect = dialog.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth,
      heights: [...dialog.querySelectorAll(".notification-actions button")].map((button) => button.getBoundingClientRect().height),
      pushDisabled: document.getElementById("enablePushButton").disabled,
      pageDisabled: document.getElementById("enablePageNotificationButton").disabled };
  })()`);
  assert.ok(notificationSettings.left >= 0 && notificationSettings.right <= notificationSettings.width);
  assert.ok(notificationSettings.heights.every((height) => height >= 40));
  assert.equal(notificationSettings.pushDisabled, true, "unconfigured server keeps push opt-in unavailable");
  assert.equal(notificationSettings.pageDisabled, false);
  await evaluate(cdp, `document.getElementById("closeNotificationButton").click()`);

  let pushRegistration;
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
    pushRegistration ||= registrations.find((registration) => registration.scopeURL === `http://127.0.0.1:${appPort}/` && !registration.isDeleted);
  });
  await cdp.send("ServiceWorker.enable");
  for (let attempt = 0; attempt < 100 && !pushRegistration; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(pushRegistration, "actual worker registration is inspectable");
  const workerTarget = (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json()))
    .find((item) => item.type === "service_worker" && item.url === `http://127.0.0.1:${appPort}/sw.js`);
  assert.ok(workerTarget, "real worker can be instrumented without substituting its notification API");
  workerCdp = new CdpSession(workerTarget.webSocketDebuggerUrl);
  await workerCdp.open();
  await workerCdp.send("Runtime.enable");
  await evaluate(workerCdp, `(() => {
    self.__acceptedPushNotices = [];
    const show = self.registration.showNotification.bind(self.registration);
    self.registration.showNotification = async (title, options) => {
      await show(title, options);
      self.__acceptedPushNotices.push({ title, options });
    };
  })()`);
  // DevTools injects a push event after the app page has gone away. The external
  // browser push provider is not involved; its transport is verified separately.
  await cdp.send("Page.navigate", { url: "about:blank" });
  await waitForExpression(cdp, `location.href === "about:blank"`);
  await cdp.send("ServiceWorker.deliverPushMessage", { origin: `http://127.0.0.1:${appPort}`,
    registrationId: pushRegistration.registrationId, data: JSON.stringify({ threadId: "mobile-e2e-other",
      title: "Codex 任务已完成", body: "页面关闭后的测试提醒", eventKey: "c".repeat(64) }),
  });
  await waitForExpression(workerCdp, `self.__acceptedPushNotices.some((notice) => notice.options.body === "页面关闭后的测试提醒" && notice.options.data.threadId === "mobile-e2e-other")`);
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/?thread=mobile-e2e-thread` });
  await waitForExpression(cdp, `document.querySelector('[data-item-id="user-mobile-1"]')`);
  await evaluate(cdp, `(async () => {
    for (const notification of await (await navigator.serviceWorker.ready).getNotifications()) notification.close();
  })()`);
});
