import { uiText } from "./public/ui-copy.js";
import { mergeThreadSettings, parseSettingsOverrides, serializeThreadSettings, threadStartPermission } from "./thread-settings.mjs";
import { approvalResponse, isUnsupportedRpcError } from "./protocol-adapter.mjs";
import { approvalRequestChangedError } from "./error-utils.mjs";

function messageIdentity(body) {
  const value = body.clientUserMessageId;
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(value)) {
    const error = new Error(uiText("taskErrors.invalidMessageId"));
    error.statusCode = 400;
    error.details = { code: "INVALID_CLIENT_MESSAGE_ID", dispatched: false, outcomeUnknown: false };
    throw error;
  }
  return { clientUserMessageId: value };
}

export function createTaskApi({
  codex,
  roots,
  usesSharedDaemon,
  service,
  runtime,
  artifacts,
  isAllowedThreadPath,
  resolveAllowedDirectory,
  broadcast,
  readBody,
  sendJson
}) {
  const { allowedThread, requestThreadGoal, requestThreadGoalBestEffort, goalUnsupportedError, goalSetParams, readThreadTurnsPage, readRecentThreadMessages, readActiveNarrative, syncActiveTurnFromHistory, subscribeThread, serializeThreadWithOrigin, threadWriteConflictError, readHistoryOutput } = service;
  const { activeTurns, ownedThreads, releasingThreads, threadMutationQueue, clearThreadReleaseTimer, markThreadOwned, hasPendingThreadRequest, releaseThread, scheduleThreadRelease } = runtime;
  const { listThreadArtifacts, sendThreadArtifact } = artifacts;
  const THREAD_LIST_PAGE_SIZE = 50;
  const MAX_THREAD_LIST_PAGE_SIZE = 100;
  const IDLE_SUBSCRIPTION_LEASE_MS = 90_000;
  const SEARCH_THREAD_LIMIT = 80;
  const SEARCH_CONCURRENCY = 6;

  async function mapWithConcurrency(values, concurrency, mapper) {
    const output = new Array(values.length);
    let next = 0;
    async function worker() {
      while (true) {
        const index = next++;
        if (index >= values.length) return;
        output[index] = await mapper(values[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
    return output;
  }

  function searchableText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function searchSnippet(text, query) {
    const source = searchableText(text);
    const index = source.toLocaleLowerCase("zh-CN").indexOf(query.toLocaleLowerCase("zh-CN"));
    if (index < 0) return source.slice(0, 180);
    const start = Math.max(0, index - 70);
    const end = Math.min(source.length, index + query.length + 110);
    return `${start ? "…" : ""}${source.slice(start, end)}${end < source.length ? "…" : ""}`;
  }

  async function listThreadsForSearch({ archived, query }) {
    const common = {
      limit: SEARCH_THREAD_LIMIT,
      sortKey: "recency_at",
      sortDirection: "desc",
      archived,
      sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
    };
    const [recentResult, titleResult] = await Promise.all([
      codex.request("thread/list", common),
      codex.request("thread/list", { ...common, searchTerm: query }),
    ]);
    const candidates = new Map();
    for (const thread of [...(recentResult?.data || []), ...(titleResult?.data || [])]) {
      if (thread?.id) candidates.set(String(thread.id), thread);
    }
    const allowed = (await Promise.all([...candidates.values()].map(async (thread) => (
      await isAllowedThreadPath(thread.cwd) ? thread : null
    )))).filter(Boolean);
    const rows = await mapWithConcurrency(allowed, SEARCH_CONCURRENCY, async (thread) => {
      const serialized = await serializeThreadWithOrigin(thread);
      const title = searchableText(thread.name || thread.preview);
      const titleMatch = title.toLocaleLowerCase("zh-CN").includes(query.toLocaleLowerCase("zh-CN"));
      let recentMessages = [];
      if (typeof readRecentThreadMessages === "function") {
        try { recentMessages = await readRecentThreadMessages(thread.id, 4); } catch {}
      }
      const matchedMessage = recentMessages.find((message) => searchableText(message.text)
        .toLocaleLowerCase("zh-CN").includes(query.toLocaleLowerCase("zh-CN")));
      if (!titleMatch && !matchedMessage) return null;
      return {
        ...serialized,
        archived: Boolean(archived),
        latestMessage: recentMessages[0]?.text || "",
        searchMatch: titleMatch
          ? { kind: "title", snippet: searchSnippet(title, query) }
          : { kind: "message", snippet: searchSnippet(matchedMessage.text, query) },
      };
    });
    return rows.filter(Boolean);
  }

  async function enrichThreadList(data, archived) {
    if (typeof readRecentThreadMessages !== "function") {
      return Promise.all(data.map(async (thread) => ({ ...await serializeThreadWithOrigin(thread), archived })));
    }
    return mapWithConcurrency(data, SEARCH_CONCURRENCY, async (thread) => {
      const serialized = await serializeThreadWithOrigin(thread);
      let messages = [];
      try { messages = await readRecentThreadMessages(thread.id, 1); } catch {}
      return { ...serialized, archived, latestMessage: messages[0]?.text || "" };
    });
  }

  function initialThreadName(prompt) {
    const singleLine = String(prompt || "").replace(/\s+/g, " ").trim();
    if (singleLine.length <= 88) return singleLine;
    return `${singleLine.slice(0, 87).trimEnd()}…`;
  }

  async function handleTaskApi(request, response, url, authentication, mutationSignal) {
    const writeOwnerId = authentication?.kind === "session" ? authentication.session.id : "unauthenticated";
    const mutationOptions = () => {
      const requestId = request.headers["x-codex-pwa-write-id"] || "";
      if (requestId && !/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) throw new Error(uiText("taskErrors.handleTaskApi.text11"));
      return { signal: mutationSignal, requestId, ownerId: writeOwnerId,
        deviceLabel: authentication?.session?.label || uiText("authentication.deviceLabel.text") };
    };
    const writeMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/writes\/([^/]+)$/);
    if (writeMatch && ["GET", "DELETE"].includes(request.method)) {
      const threadId = decodeURIComponent(writeMatch[1]);
      const requestId = decodeURIComponent(writeMatch[2]);
      await allowedThread(threadId, false);
      const snapshot = request.method === "DELETE"
        ? threadMutationQueue.cancel(threadId, requestId, writeOwnerId)
        : threadMutationQueue.inspect(threadId, requestId, writeOwnerId);
      if (!snapshot) {
        sendJson(response, 404, { error: uiText("taskErrors.handleTaskApi.error"), details: { code: "WRITE_REQUEST_NOT_FOUND" } });
      } else sendJson(response, 200, snapshot);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/models") {
      const result = await codex.request("model/list", { limit: 100 });
      const data = (result?.data || [])
        .filter((model) => !model.hidden)
        .map((model) => ({
          id: model.id,
          model: model.model,
          displayName: model.displayName,
          description: model.description,
          isDefault: model.isDefault,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: model.supportedReasoningEfforts || [],
          inputModalities: model.inputModalities || [],
        }));
      sendJson(response, 200, { data });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/threads") {
      const archived = url.searchParams.get("archived") === "true";
      const searchTerm = String(url.searchParams.get("search") || "").trim().slice(0, 160);
      const requestedLimit = Number.parseInt(url.searchParams.get("limit") || THREAD_LIST_PAGE_SIZE, 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(MAX_THREAD_LIST_PAGE_SIZE, Math.max(1, requestedLimit))
        : THREAD_LIST_PAGE_SIZE;
      const cursor = String(url.searchParams.get("cursor") || "").slice(0, 2_048);
      const result = await codex.request("thread/list", {
        limit,
        sortKey: "recency_at",
        sortDirection: "desc",
        archived,
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
        ...(searchTerm ? { searchTerm } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const allowedData = (await Promise.all((result?.data || []).map(async (thread) => (
        thread?.cwd && await isAllowedThreadPath(thread.cwd) ? thread : null
      )))).filter(Boolean);
      const data = await enrichThreadList(allowedData, archived);
      sendJson(response, 200, { ...result, data });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/thread-search") {
      const query = String(url.searchParams.get("query") || "").trim().slice(0, 160);
      if (!query) {
        sendJson(response, 200, { data: [] });
        return true;
      }
      const archivedMode = url.searchParams.get("archived") || "false";
      const archivedValues = archivedMode === "all" ? [false, true] : [archivedMode === "true"];
      const pages = await Promise.all(archivedValues.map((archived) => listThreadsForSearch({ archived, query })));
      // A daemon can return the same task from its ordinary and search-term
      // result sets, and an older daemon may briefly expose a task in both
      // archive buckets during an archive transition. Keep one safe row per
      // task so the dialog never shows duplicate results.
      const unique = new Map();
      for (const row of pages.flat()) {
        if (row?.id && !unique.has(String(row.id))) unique.set(String(row.id), row);
      }
      const data = [...unique.values()];
      data.sort((left, right) => Number(right.recencyAt || right.updatedAt || 0) - Number(left.recencyAt || left.updatedAt || 0));
      sendJson(response, 200, { data: data.slice(0, SEARCH_THREAD_LIMIT * archivedValues.length), limited: true });
      return true;
    }

    const threadTurnsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/turns$/);
    if (request.method === "GET" && threadTurnsMatch) {
      const threadId = decodeURIComponent(threadTurnsMatch[1]);
      const itemsView = url.searchParams.get("items") === "full" ? "full" : "summary";
      const complete = url.searchParams.get("complete") === "true";
      const sortDirection = url.searchParams.get("sort") === "asc" ? "asc" : "desc";
      const page = await readThreadTurnsPage(threadId, {
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
        itemsView,
        complete,
        sortDirection,
      });
      sendJson(response, 200, page);
      return true;
    }

    const threadArtifactsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/artifacts$/);
    if (request.method === "GET" && threadArtifactsMatch) {
      const threadId = decodeURIComponent(threadArtifactsMatch[1]);
      const thread = await allowedThread(threadId, false);
      const artifacts = await listThreadArtifacts(threadId, thread);
      sendJson(response, 200, { data: artifacts });
      return true;
    }

    const threadArtifactRawMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/artifacts\/([^/]+)\/raw$/);
    if ((request.method === "GET" || request.method === "HEAD") && threadArtifactRawMatch) {
      const threadId = decodeURIComponent(threadArtifactRawMatch[1]);
      const artifactId = decodeURIComponent(threadArtifactRawMatch[2]);
      await sendThreadArtifact(request, response, threadId, artifactId, url);
      return true;
    }

    const historyOutputMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/outputs\/([^/]+)$/);
    if (request.method === "GET" && historyOutputMatch) {
      const threadId = decodeURIComponent(historyOutputMatch[1]);
      const itemId = decodeURIComponent(historyOutputMatch[2]);
      await allowedThread(threadId, false);
      sendJson(response, 200, { output: readHistoryOutput(threadId, itemId) });
      return true;
    }

    const threadTranscriptMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/transcript$/);
    if (request.method === "GET" && threadTranscriptMatch) {
      const threadId = decodeURIComponent(threadTranscriptMatch[1]);
      await allowedThread(threadId, false);
      const turnId = String(url.searchParams.get("turnId") || activeTurns.get(threadId) || "").slice(0, 160);
      if (!turnId) throw new Error(uiText("taskErrors.handleTaskApi.text5"));
      const turn = await readActiveNarrative(threadId, turnId);
      if (!turn) {
        const error = new Error(uiText("taskErrors.handleTaskApi.text10"));
        error.statusCode = 404;
        throw error;
      }
      sendJson(response, 200, { turn });
      return true;
    }

    const threadGoalMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/goal$/);
    if (threadGoalMatch && request.method === "GET") {
      const threadId = decodeURIComponent(threadGoalMatch[1]);
      await allowedThread(threadId, false);
      const result = await requestThreadGoal(threadId);
      sendJson(response, 200, result);
      return true;
    }

    if (threadGoalMatch && request.method === "POST") {
      const threadId = decodeURIComponent(threadGoalMatch[1]);
      await allowedThread(threadId, false);
      const result = await requestThreadGoal(threadId);
      if (!result.supported) throw goalUnsupportedError();
      const body = await readBody(request);
      const params = goalSetParams(threadId, body);
      try {
        const updated = await codex.request("thread/goal/set", params);
        sendJson(response, 200, { supported: true, goal: updated?.goal || null });
      } catch (error) {
        if (isUnsupportedRpcError(error)) throw goalUnsupportedError();
        throw error;
      }
      return true;
    }

    if (threadGoalMatch && request.method === "DELETE") {
      const threadId = decodeURIComponent(threadGoalMatch[1]);
      await allowedThread(threadId, false);
      const result = await requestThreadGoal(threadId);
      if (!result.supported) throw goalUnsupportedError();
      try {
        await codex.request("thread/goal/clear", { threadId });
        sendJson(response, 200, { supported: true, goal: null });
      } catch (error) {
        if (isUnsupportedRpcError(error)) throw goalUnsupportedError();
        throw error;
      }
      return true;
    }

    const threadReadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
    if (request.method === "GET" && threadReadMatch) {
      const threadId = decodeURIComponent(threadReadMatch[1]);
      let thread = await allowedThread(threadId, false);
      let liveSubscribed = false;
      let subscriptionError = null;
      // `thread/read` carries the persisted model/effort even for archived
      // tasks. Use it as a read-only fallback when live subscription is not
      // requested or temporarily unavailable; a successful resume still
      // replaces it with the authoritative permission-aware settings.
      let settings = serializeThreadSettings(thread);
      if (usesSharedDaemon && url.searchParams.get("subscribe") === "true") {
        try {
          const subscribed = await subscribeThread(threadId, thread);
          thread = subscribed.thread;
          settings = subscribed.settings || settings;
          liveSubscribed = true;
        } catch (error) {
          subscriptionError = error.message;
          console.warn(`[app-server] Unable to subscribe to thread ${threadId}: ${error.message}`);
        }
      }
      const [history, goalState] = await Promise.all([
        readThreadTurnsPage(threadId, { validate: false }),
        requestThreadGoalBestEffort(threadId),
      ]);
      const activeTurnId = liveSubscribed
        ? syncActiveTurnFromHistory(threadId, history, thread.status)
        : activeTurns.get(threadId) || null;
      const hasLiveActivity = Boolean(activeTurnId)
        || thread.status?.type === "active"
        || hasPendingThreadRequest(threadId);
      if (liveSubscribed && !hasLiveActivity) {
        scheduleThreadRelease(threadId, IDLE_SUBSCRIPTION_LEASE_MS, "idle-subscription-lease");
      }
      sendJson(response, 200, {
        thread: await serializeThreadWithOrigin(thread),
        history,
        goal: goalState.goal,
        goalSupported: goalState.supported,
        activeTranscriptAvailable: Boolean(activeTurnId && hasLiveActivity),
        settings,
        activeTurnId,
        liveSubscribed,
        subscriptionError,
        ownership: releasingThreads.has(threadId) ? "releasing" : ownedThreads.has(threadId) ? "owned" : "released",
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/threads") {
      const body = await readBody(request);
      const identity = messageIdentity(body);
      const cwd = await resolveAllowedDirectory(body.cwd || roots[0]);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) throw new Error(uiText("taskErrors.handleTaskApi.text8"));
      const model = String(body.model || "").trim().slice(0, 120);
      const effort = String(body.effort || "").trim().slice(0, 32);
      const permission = threadStartPermission(String(body.permissionPreset || "request"));
      const started = await codex.request("thread/start", {
        cwd,
        ...permission,
        serviceName: "codex-pwa",
        threadSource: "codex-pwa-mobile",
        ...(model ? { model } : {}),
      });
      const threadId = started?.thread?.id;
      if (!threadId) throw new Error(uiText("taskErrors.handleTaskApi.text9"));
      if (usesSharedDaemon) {
        codex.subscribedThreads.add(threadId);
        codex.subscriptionSettings.set(threadId, serializeThreadSettings(started || {}));
      }
      markThreadOwned(threadId);
      let goalError = null;
      if (body.goal && typeof body.goal === "object" && !Array.isArray(body.goal)) {
        try {
          await codex.request("thread/goal/set", goalSetParams(threadId, body.goal));
        } catch (error) {
          goalError = error.message;
          console.warn(`[app-server] Unable to set initial Goal for ${threadId}: ${error.message}`);
          broadcast({ kind: "bridge/log", level: "warning", message: uiText("taskErrors.handleTaskApi.message2", error.message) });
        }
      }
      const name = initialThreadName(prompt);
      let thread = started.thread;
      try {
        await codex.request("thread/name/set", { threadId, name });
        thread = { ...thread, name };
      } catch (error) {
        console.warn(`[app-server] Unable to set initial thread name: ${error.message}`);
        broadcast({
          kind: "bridge/log",
          level: "warning",
          message: uiText("taskErrors.handleTaskApi.message"),
        });
      }
      let turn;
      try {
        turn = await codex.request("turn/start", {
          threadId,
          ...identity,
          input: [{ type: "text", text: prompt }],
          ...(effort ? { effort } : {}),
        });
      } catch (error) {
        scheduleThreadRelease(threadId, 0, "turn-start-failed");
        throw error;
      }
      const effectiveSettings = mergeThreadSettings(
        serializeThreadSettings(started),
        effort ? { effort } : {},
      );
      if (usesSharedDaemon) codex.subscriptionSettings.set(threadId, effectiveSettings);
      const goalState = await requestThreadGoalBestEffort(threadId);
      sendJson(response, 201, {
        thread: await serializeThreadWithOrigin(thread),
        turn: turn.turn,
        settings: effectiveSettings,
        goal: goalState.goal,
        goalSupported: goalState.supported,
        goalError,
      });
      return true;
    }

    if (request.method === "POST" && threadTurnsMatch) {
      const threadId = decodeURIComponent(threadTurnsMatch[1]);
      const allowed = await allowedThread(threadId, false);
      const body = await readBody(request);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) throw new Error(uiText("taskErrors.handleTaskApi.text8"));
      const identity = messageIdentity(body);
      const outcome = await threadMutationQueue.run(threadId, async () => {
        clearThreadReleaseTimer(threadId);
        const resumed = await subscribeThread(threadId, allowed);
        const currentSettings = resumed.settings || serializeThreadSettings(resumed.thread || {});
        const overrides = parseSettingsOverrides(body.settings, currentSettings);
        markThreadOwned(threadId);
        let result;
        try {
          result = await codex.request("turn/start", {
            threadId,
            ...identity,
            input: [{ type: "text", text: prompt }],
            ...overrides.rpc,
          });
        } catch (error) {
          scheduleThreadRelease(threadId, 0, "turn-start-failed");
          throw threadWriteConflictError(error, { threadId });
        }
        const effectiveSettings = mergeThreadSettings(currentSettings, overrides.applied);
        if (usesSharedDaemon) codex.subscriptionSettings.set(threadId, effectiveSettings);
        return { ...result, settings: effectiveSettings };
      }, mutationOptions());
      sendJson(response, 202, outcome);
      return true;
    }

    const releaseMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/release$/);
    if (request.method === "POST" && releaseMatch) {
      const threadId = decodeURIComponent(releaseMatch[1]);
      await allowedThread(threadId, false);
      const result = await releaseThread(threadId, { reason: "manual-unsubscribe" });
      sendJson(response, 200, { ...result, threadId });
      return true;
    }

    const pinMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/pin$/);
    if (request.method === "POST" && pinMatch) {
      const threadId = decodeURIComponent(pinMatch[1]);
      await allowedThread(threadId, false);
      const body = await readBody(request);
      if (typeof body.isPinned !== "boolean") throw new Error(uiText("taskErrors.handleTaskApi.text7"));
      const result = await codex.request("thread/metadata/update", {
        threadId,
        isPinned: body.isPinned,
      });
      sendJson(response, 200, {
        thread: await serializeThreadWithOrigin(result?.thread || { id: threadId, isPinned: body.isPinned }),
      });
      return true;
    }

    const steerMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/steer$/);
    if (request.method === "POST" && steerMatch) {
      const threadId = decodeURIComponent(steerMatch[1]);
      await allowedThread(threadId, false);
      const body = await readBody(request);
      const prompt = String(body.prompt || "").trim();
      const turnId = String(body.turnId || activeTurns.get(threadId) || "");
      if (!prompt || !turnId) throw new Error(uiText("taskErrors.handleTaskApi.text6"));
      const identity = messageIdentity(body);
      const result = await threadMutationQueue.run(threadId, async () => {
        try {
          return await codex.request("turn/steer", {
            threadId,
            ...identity,
            expectedTurnId: turnId,
            input: [{ type: "text", text: prompt }],
          });
        } catch (error) {
          throw threadWriteConflictError(error, { threadId, turnId });
        }
      }, mutationOptions());
      sendJson(response, 202, result);
      return true;
    }

    const interruptMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/interrupt$/);
    if (request.method === "POST" && interruptMatch) {
      const threadId = decodeURIComponent(interruptMatch[1]);
      await allowedThread(threadId, false);
      const body = await readBody(request);
      const turnId = String(body.turnId || activeTurns.get(threadId) || "");
      if (!turnId) throw new Error(uiText("taskErrors.handleTaskApi.text5"));
      const result = await threadMutationQueue.run(threadId, async () => {
        try {
          return await codex.request("turn/interrupt", { threadId, turnId });
        } catch (error) {
          throw threadWriteConflictError(error, { threadId, turnId });
        }
      }, mutationOptions());
      sendJson(response, 200, result);
      return true;
    }

    const renameMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/name$/);
    if (request.method === "POST" && renameMatch) {
      const threadId = decodeURIComponent(renameMatch[1]);
      await allowedThread(threadId, false);
      const body = await readBody(request);
      const name = String(body.name || "").trim().slice(0, 160);
      if (!name) throw new Error(uiText("taskErrors.handleTaskApi.text4"));
      await codex.request("thread/name/set", { threadId, name });
      sendJson(response, 200, { ok: true, name });
      return true;
    }

    const archiveMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/archive$/);
    if (request.method === "POST" && archiveMatch) {
      const threadId = decodeURIComponent(archiveMatch[1]);
      await allowedThread(threadId, false);
      await codex.request("thread/archive", { threadId });
      sendJson(response, 200, { ok: true });
      return true;
    }

    const unarchiveMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/unarchive$/);
    if (request.method === "POST" && unarchiveMatch) {
      const threadId = decodeURIComponent(unarchiveMatch[1]);
      await allowedThread(threadId, false);
      const result = await codex.request("thread/unarchive", { threadId });
      if (!result?.thread || !await isAllowedThreadPath(result.thread.cwd)) {
        const error = new Error(uiText("taskErrors.handleTaskApi.text3"));
        error.statusCode = 403;
        throw error;
      }
      sendJson(response, 200, { thread: await serializeThreadWithOrigin(result.thread) });
      return true;
    }

    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (request.method === "POST" && approvalMatch) {
      const requestId = decodeURIComponent(approvalMatch[1]);
      const pending = codex.serverRequests.get(requestId);
      if (!pending) throw approvalRequestChangedError();
      const threadId = pending.params?.threadId ? String(pending.params.threadId) : "";
      if (threadId) await allowedThread(threadId, false);
      const body = await readBody(request);
      if (!pending.requestToken || body.requestToken !== pending.requestToken) throw approvalRequestChangedError();
      const result = approvalResponse(pending, body.decision);

      const respond = async () => {
        codex.respondToServerRequest(requestId, result, pending);
        return { ok: true };
      };
      if (threadId) await threadMutationQueue.run(threadId, respond, mutationOptions());
      else await respond();
      sendJson(response, 200, { ok: true });
      return true;
    }

    const requestResponseMatch = url.pathname.match(/^\/api\/requests\/([^/]+)\/respond$/);
    if (request.method === "POST" && requestResponseMatch) {
      const requestId = decodeURIComponent(requestResponseMatch[1]);
      const pending = codex.serverRequests.get(requestId);
      if (!pending) throw approvalRequestChangedError();
      const threadId = pending.params?.threadId ? String(pending.params.threadId) : "";
      if (threadId) await allowedThread(threadId, false);
      if (pending.method !== "item/tool/requestUserInput" && pending.method !== "tool/requestUserInput") {
        throw new Error(uiText("taskErrors.handleTaskApi.text2"));
      }
      const body = await readBody(request);
      if (!pending.requestToken || body.requestToken !== pending.requestToken) throw approvalRequestChangedError();
      const answers = body.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
        throw new Error(uiText("taskErrors.handleTaskApi.text"));
      }
      const respond = async () => {
        codex.respondToServerRequest(requestId, { answers }, pending);
        return { ok: true };
      };
      if (threadId) await threadMutationQueue.run(threadId, respond, mutationOptions());
      else await respond();
      sendJson(response, 200, { ok: true });
      return true;
    }

    return false;
  }

  return { handleTaskApi };
}
