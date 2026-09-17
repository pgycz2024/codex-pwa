import { uiText } from "./public/ui-copy.js";
import { open, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPathWithinRoots } from "./file-access.mjs";
import { inferClientOrigin, narrativeHistoryPage } from "./thread-history.mjs";
import { serializeThreadSettings } from "./thread-settings.mjs";
import { isUnsupportedRpcError, isThreadWriteConflict, protocolWriterEvidence, resumeThread } from "./protocol-adapter.mjs";
import { lruGet, lruSet } from "./bounded-cache.mjs";

export function createThreadService({
  codex,
  codexHome,
  usesSharedDaemon,
  runtime,
  taskRecovery,
  isAllowedThreadPath
}) {
  const { activeTurns, clearThreadReleaseTimer, markThreadOwned } = runtime;
  const HISTORY_PAGE_SIZE = 6;
  const MAX_HISTORY_PAGE_SIZE = 20;
  const HISTORY_ACTIVITY_LIMIT_PER_TURN = 40;
  const HISTORY_COMMAND_PREVIEW_CHARS = 4_000;
  const MAX_HISTORY_OUTPUT_CACHE_BYTES = 32 * 1024 * 1024;
  const MAX_HISTORY_OUTPUT_ENTRY_BYTES = 4 * 1024 * 1024;
  const MAX_ORIGINATOR_CACHE_ENTRIES = 2_048;
  const MAX_WRITER_CONFLICT_EVIDENCE = 512;
  const WRITER_CONFLICT_EVIDENCE_TTL_MS = 10 * 60 * 1000;
  const historyOutputCache = new Map();
  let historyOutputCacheBytes = 0;
  const originatorCache = new Map();
  const writerConflictEvidence = new Map();
  const sessionsRoot = join(codexHome, "sessions");
  const GOAL_STATUSES = new Set([
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ]);
  const MAX_GOAL_OBJECTIVE_LENGTH = 4_000;

  function threadWriteConflictError(error, { threadId = "", turnId = "" } = {}) {
    if (!isThreadWriteConflict(error)) return error;
    recordWriterConflictEvidence(threadId, error, turnId);
    const conflict = new Error(uiText("taskData.threadWriteConflictError.text"));
    conflict.statusCode = 409;
    conflict.details = {
      ...(error.details || {}),
      code: "THREAD_WRITE_CONFLICT",
      threadId,
      ...(turnId ? { turnId } : {}),
      retryable: true,
    };
    return conflict;
  }

  async function allowedThread(threadId, includeTurns = false) {
    const result = await codex.request("thread/read", { threadId, includeTurns });
    if (!result?.thread || !await isAllowedThreadPath(result.thread.cwd)) {
      const error = new Error(uiText("taskErrors.handleTaskApi.text3"));
      error.statusCode = 403;
      throw error;
    }
    return result.thread;
  }

  async function requestThreadGoal(threadId) {
    try {
      const result = await codex.request("thread/goal/get", { threadId });
      return { supported: true, goal: result?.goal || null };
    } catch (error) {
      if (isUnsupportedRpcError(error)) return { supported: false, goal: null };
      throw error;
    }
  }

  async function requestThreadGoalBestEffort(threadId) {
    try {
      return await requestThreadGoal(threadId);
    } catch (error) {
      console.warn(`[app-server] Unable to read Goal for ${threadId}: ${error.message}`);
      return { supported: null, goal: null, error: error.message };
    }
  }

  function goalUnsupportedError() {
    const error = new Error(uiText("taskData.goalUnsupportedError.text"));
    error.statusCode = 501;
    return error;
  }

  function goalSetParams(threadId, body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error(uiText("taskData.goalSetParams.text3"));
    }
    const params = { threadId };
    if (Object.hasOwn(body, "objective")) {
      if (body.objective === null) {
        params.objective = null;
      } else {
        const objective = String(body.objective || "").trim();
        if (!objective) throw new Error(uiText("goals.saveGoal.showToast4"));
        if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
          throw new Error(uiText("goals.objectiveTooLong", MAX_GOAL_OBJECTIVE_LENGTH));
        }
        params.objective = objective;
      }
    }
    if (Object.hasOwn(body, "status")) {
      if (body.status === null) {
        params.status = null;
      } else {
        const status = String(body.status || "");
        if (!GOAL_STATUSES.has(status)) throw new Error(uiText("taskData.goalSetParams.text2"));
        params.status = status;
      }
    }
    if (Object.hasOwn(body, "tokenBudget")) {
      if (body.tokenBudget === null || body.tokenBudget === "") {
        params.tokenBudget = null;
      } else {
        const tokenBudget = Number(body.tokenBudget);
        if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0) {
          throw new Error(uiText("common.goalBudgetInvalid"));
        }
        params.tokenBudget = tokenBudget;
      }
    }
    if (Object.keys(params).length === 1) throw new Error(uiText("taskData.goalSetParams.text"));
    return params;
  }

  function historyPageLimit(value) {
    const parsed = Number.parseInt(String(value || HISTORY_PAGE_SIZE), 10);
    if (!Number.isFinite(parsed)) return HISTORY_PAGE_SIZE;
    return Math.min(MAX_HISTORY_PAGE_SIZE, Math.max(1, parsed));
  }

  function collapsedHistoryOutput(value, limit = HISTORY_COMMAND_PREVIEW_CHARS) {
    const text = String(value || "");
    if (text.length <= limit) return text;
    const headLength = Math.floor(limit * 0.68);
    const tailLength = limit - headLength;
    return uiText("taskData.collapsedHistoryOutput.text", text.slice(0, headLength), text.length - limit, text.slice(-tailLength));
  }

  function cacheHistoryOutput(threadId, itemId, output) {
    if (!threadId || !itemId || !output) return false;
    const key = `${threadId}:${itemId}`;
    const existing = historyOutputCache.get(key);
    if (existing) historyOutputCacheBytes -= existing.bytes;
    const bytes = Buffer.byteLength(output);
    historyOutputCache.delete(key);
    if (bytes > MAX_HISTORY_OUTPUT_ENTRY_BYTES) return false;
    historyOutputCache.set(key, { output, bytes });
    historyOutputCacheBytes += bytes;
    while (historyOutputCacheBytes > MAX_HISTORY_OUTPUT_CACHE_BYTES && historyOutputCache.size) {
      const oldestKey = historyOutputCache.keys().next().value;
      const oldest = historyOutputCache.get(oldestKey);
      historyOutputCache.delete(oldestKey);
      historyOutputCacheBytes -= oldest?.bytes || 0;
    }
    return historyOutputCache.has(key);
  }

  function compactHistoryTurn(threadId, turn) {
    const items = turn?.items || [];
    const activityIndexes = [];
    items.forEach((item, index) => {
      if (item?.type !== "userMessage" && item?.type !== "agentMessage") activityIndexes.push(index);
    });
    const retainedActivity = new Set(activityIndexes.slice(-HISTORY_ACTIVITY_LIMIT_PER_TURN));
    items.forEach((item, index) => {
      if (item?.type === "fileChange") retainedActivity.add(index);
    });
    const selected = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const isConversation = item?.type === "userMessage" || item?.type === "agentMessage";
      if (!isConversation && !retainedActivity.has(index)) continue;
      if (item?.type === "commandExecution" && String(item.aggregatedOutput || "").length > HISTORY_COMMAND_PREVIEW_CHARS) {
        const output = String(item.aggregatedOutput || "");
        const fullOutputAvailable = cacheHistoryOutput(threadId, item.id, output);
        selected.push({
          ...item,
          aggregatedOutput: collapsedHistoryOutput(output),
          outputTruncated: true,
          fullOutputAvailable,
          outputLength: output.length,
        });
      } else {
        selected.push(item);
      }
    }
    const omittedActivityCount = Math.max(0, activityIndexes.length - retainedActivity.size);
    if (omittedActivityCount) {
      selected.push({
        type: "historyNotice",
        id: `${turn.id}-history-notice`,
        text: uiText("taskData.compactHistoryTurn.text", omittedActivityCount.toLocaleString("zh-CN")),
      });
    }
    return { ...turn, items: selected, omittedActivityCount };
  }

  function compactHistoryPage(threadId, page) {
    return {
      ...page,
      data: (page.data || []).map((turn) => compactHistoryTurn(threadId, turn)),
    };
  }

  async function readThreadTurnsPage(threadId, {
    cursor = null,
    limit = HISTORY_PAGE_SIZE,
    validate = true,
    itemsView = "summary",
    complete = false,
    sortDirection = "desc",
  } = {}) {
    if (validate) await allowedThread(threadId, false);
    const direction = sortDirection === "asc" ? "asc" : "desc";
    const result = await codex.request("thread/turns/list", {
      threadId,
      limit: historyPageLimit(limit),
      sortDirection: direction,
      itemsView,
      ...(cursor ? { cursor: String(cursor).slice(0, 2_048) } : {}),
    });
    const page = {
      data: result?.data || [],
      nextCursor: result?.nextCursor || null,
      backwardsCursor: result?.backwardsCursor || null,
      sortDirection: direction,
    };
    return itemsView === "full" && !complete ? compactHistoryPage(threadId, page) : page;
  }

  async function readActiveNarrative(threadId, activeTurnId) {
    if (!activeTurnId) return null;
    const result = await codex.request("thread/turns/list", {
      threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "full",
    });
    const page = narrativeHistoryPage({
      data: result?.data || [],
      nextCursor: null,
      backwardsCursor: result?.backwardsCursor || null,
    });
    return page.data.find((turn) => turn?.id === activeTurnId) || null;
  }

  function syncActiveTurnFromHistory(threadId, history, threadStatus) {
    const activeTurn = (history?.data || []).find((turn) => turn?.status === "inProgress");
    if (activeTurn?.id) {
      activeTurns.set(threadId, activeTurn.id);
      if (threadStatus?.type === "active") taskRecovery.observe({ kind: "app-server/notification",
        message: { method: "turn/started", params: { threadId, turn: activeTurn } } });
    } else if (threadStatus?.type !== "active") {
      activeTurns.delete(threadId);
    }
    return activeTurn?.id || null;
  }

  async function subscribeThread(threadId, fallbackThread) {
    clearThreadReleaseTimer(threadId);
    if (usesSharedDaemon && codex.subscribedThreads.has(threadId)) {
      return {
        thread: fallbackThread,
        settings: codex.subscriptionSettings.get(threadId) || null,
      };
    }
    const result = await resumeThread(codex, threadId);
    if (usesSharedDaemon) {
      codex.subscribedThreads.add(threadId);
      codex.subscriptionSettings.set(threadId, serializeThreadSettings(result || {}));
    }
    markThreadOwned(threadId);
    return {
      thread: result?.thread || fallbackThread,
      settings: serializeThreadSettings(result || {}),
    };
  }

  function serializeThread(thread) {
    return {
      id: thread.id,
      name: thread.name,
      preview: thread.preview?.slice(0, 360) || "",
      cwd: thread.cwd,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      recencyAt: thread.recencyAt,
      status: thread.status,
      source: thread.source,
      threadSource: thread.threadSource,
      parentThreadId: thread.parentThreadId,
      forkedFromId: thread.forkedFromId,
      agentNickname: thread.agentNickname,
      agentRole: thread.agentRole,
      gitInfo: thread.gitInfo,
      cliVersion: thread.cliVersion,
      canAcceptDirectInput: thread.canAcceptDirectInput,
      writerEvidence: readWriterConflictEvidence(thread.id),
      isPinned: Boolean(thread.isPinned),
    };
  }

  function readWriterConflictEvidence(threadId) {
    const key = String(threadId || "");
    if (!key) return null;
    const now = Date.now();
    for (const [id, evidence] of writerConflictEvidence) {
      if (now - evidence.observedAtMs > WRITER_CONFLICT_EVIDENCE_TTL_MS) writerConflictEvidence.delete(id);
    }
    const evidence = writerConflictEvidence.get(key);
    if (!evidence) return null;
    const { observedAtMs, ...publicEvidence } = evidence;
    return { ...publicEvidence, observedAt: observedAtMs / 1000 };
  }

  function recordWriterConflictEvidence(threadId, error, turnId = "") {
    const key = String(threadId || "");
    if (!key) return;
    const reportedWriter = protocolWriterEvidence(error);
    writerConflictEvidence.set(key, {
      source: "app-server",
      kind: "active-writer-conflict",
      observedAtMs: Date.now(),
      ...(turnId ? { turnId: String(turnId).slice(0, 160) } : {}),
      code: String(error?.details?.code || "ACTIVE_WRITER_CONFLICT").slice(0, 80),
      ...(reportedWriter ? { reportedWriter } : {}),
    });
    while (writerConflictEvidence.size > MAX_WRITER_CONFLICT_EVIDENCE) {
      writerConflictEvidence.delete(writerConflictEvidence.keys().next().value);
    }
  }

  async function readThreadOriginator(thread) {
    if (!thread?.path || thread.threadSource === "codex-pwa-mobile") return "";
    let actualPath;
    let actualSessionsRoot;
    try {
      [actualPath, actualSessionsRoot] = await Promise.all([realpath(thread.path), realpath(sessionsRoot)]);
    } catch {
      return "";
    }
    if (!isPathWithinRoots(actualPath, [actualSessionsRoot])) return "";
    if (originatorCache.has(actualPath)) return lruGet(originatorCache, actualPath);
    const details = await stat(actualPath);

    const handle = await open(actualPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, details.size)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
      const parsed = JSON.parse(firstLine || "{}");
      const originator = String(parsed?.payload?.originator || "").slice(0, 120);
      lruSet(originatorCache, actualPath, originator, MAX_ORIGINATOR_CACHE_ENTRIES);
      return originator;
    } catch {
      lruSet(originatorCache, actualPath, "", MAX_ORIGINATOR_CACHE_ENTRIES);
      return "";
    } finally {
      await handle.close();
    }
  }

  async function serializeThreadWithOrigin(thread) {
    const originator = await readThreadOriginator(thread);
    return {
      ...serializeThread(thread),
      clientOrigin: inferClientOrigin(thread, originator),
    };
  }

  function readHistoryOutput(threadId, itemId) {
    const key = `${threadId}:${itemId}`;
    const cached = lruGet(historyOutputCache, key);
    if (!cached) {
      const error = new Error(uiText("taskData.readHistoryOutput.text"));
      error.statusCode = 404;
      throw error;
    }
    return cached.output;
  }

  return { allowedThread, requestThreadGoal, requestThreadGoalBestEffort, goalUnsupportedError, goalSetParams, readThreadTurnsPage, readActiveNarrative, syncActiveTurnFromHistory, subscribeThread, serializeThreadWithOrigin, threadWriteConflictError, readHistoryOutput };
}
