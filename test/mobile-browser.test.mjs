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
      instanceName: "Mobile Test", networkLabel: "受控测试私网", version: "0.18.12",
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
          items: [
            { id: "user-mobile-1", type: "userMessage", text: "检查移动端布局" },
            {
              id: "agent-mobile-1",
              type: "agentMessage",
              text: "布局检查已完成。\n\n![标注后的图片](/srv/example/project/annotated.png)\n\n图片应显示在这段文字之前。",
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
          text: `第 ${index + 1} 个历史节点的完整 Codex 回复。`,
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
      }],
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
  t.after(async () => {
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
  cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
    const parsed = new URL(request.url);
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
      const body = Buffer.from(JSON.stringify(jsonRoute(request.url))).toString("base64");
      cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body,
      }).catch(() => {});
    };
    if (parsed.pathname.endsWith("/turns")) setTimeout(fulfillJson, 250);
    else fulfillJson();
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appPort}/` });
  await waitForExpression(cdp, `Boolean(document.getElementById("appShell") && !document.getElementById("appShell").classList.contains("hidden") && document.querySelector(".thread-card"))`);

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
    "点击左侧主菜单查看历史会话",
  );

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
  await evaluate(cdp, `new Promise((resolve) => setTimeout(resolve, 700))`);
  assert.equal(await evaluate(cdp, `document.querySelector(".floating-popover") !== null`), true);
  await evaluate(cdp, `document.getElementById("threadList").dispatchEvent(new Event("scroll"))`);
  assert.equal(await evaluate(cdp, `document.querySelector(".floating-popover") === null`), true);
  await evaluate(cdp, `document.querySelector(".thread-menu-button").click()`);
  await waitForExpression(cdp, `document.querySelector(".floating-popover")`);
  await evaluate(cdp, `document.getElementById("threadSearch").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  assert.equal(await evaluate(cdp, `document.querySelector(".floating-popover") === null`), true);

  await evaluate(cdp, `document.getElementById("menuButton").click(); document.getElementById("trustedDevicesButton").click()`);
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

  await evaluate(cdp, `document.querySelector(".thread-main").click()`);
  await waitForExpression(cdp, `document.getElementById("chatTitle").textContent.includes("超长标题")`);
  await waitForExpression(cdp, `document.querySelector(".inline-server-image") && !document.querySelector(".image-artifact")`);
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
  assert.ok(initialHistoryGeometry.rendered < 80);
  assert.ok(initialHistoryGeometry.scrollHeight > initialHistoryGeometry.clientHeight * 20);
  assert.ok(initialHistoryGeometry.canvasHeight >= 800 * 74);
  assert.equal(initialHistoryGeometry.datesFit, true);

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
  assert.ok(historyFeedbackGeometry.feedbackTop >= historyFeedbackGeometry.bannerBottom - 1);
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

  await evaluate(cdp, `document.querySelector(".history-context-banner button").click()`);
  await waitForExpression(cdp, `!document.querySelector(".history-context-banner") && document.querySelector('.turn-group[data-turn-id="turn-mobile-1"]')`);

  await evaluate(cdp, `document.getElementById("historyNodesButton").click()`);
  await waitForExpression(cdp, `document.getElementById("historyNodesDialog").open && document.querySelector(".history-node")`);
  await evaluate(cdp, `document.querySelector(".history-node").click()`);
  assert.equal(await evaluate(cdp, `!document.getElementById("historyNodesLoading").classList.contains("hidden")`), true);
  await waitForExpression(cdp, `document.querySelector(".history-context-banner")`);
  await evaluate(cdp, `(() => {
    const input = document.getElementById("promptInput");
    input.value = "从历史节点返回最新位置后发送";
    document.getElementById("composer").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  })()`);
  await waitForExpression(cdp, `document.getElementById("confirmDialog").open`);
  assert.equal(await evaluate(cdp, `document.getElementById("confirmTitle").textContent`), "返回最新对话并发送？");
  const confirmationColors = await evaluate(cdp, `(() => {
    const button = document.getElementById("submitConfirmButton");
    const style = getComputedStyle(button);
    return { background: style.backgroundColor, color: style.color };
  })()`);
  assert.notEqual(confirmationColors.background, "rgba(0, 0, 0, 0)");
  assert.notEqual(confirmationColors.background, confirmationColors.color);
  await evaluate(cdp, `document.getElementById("submitConfirmButton").click()`);
  await waitForExpression(cdp, `!document.querySelector(".history-context-banner") && [...document.querySelectorAll(".message-row.user .message-body")].some((node) => node.textContent.includes("从历史节点返回最新位置后发送"))`);
});
