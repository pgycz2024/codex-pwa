export function createDiagnosticsApi({
  codex,
  appServerMode,
  daemonSocket,
  usesSharedDaemon,
  roots,
  rootAccess,
  appRoot,
  instanceName,
  networkLabel,
  appVersion,
  sseReplay,
  taskRecovery,
  runtime,
  sendJson
}) {
  const { activeTurns, ownedThreads, releasingThreads, threadMutationQueue } = runtime;
  async function handleDiagnosticsApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/status") {
      try {
        await codex.ensureReady();
      } catch {}
      sendJson(response, 200, {
        bridge: codex.status,
        appServerMode,
        daemonSocket: usesSharedDaemon ? daemonSocket : null,
        error: codex.lastError,
        roots,
        accessRoots: rootAccess.snapshot(),
        rootAccessPolicy: rootAccess.policy(),
        appRoot,
        instanceName,
        networkLabel,
        version: appVersion,
        protocol: codex.protocol,
        eventReplay: sseReplay.snapshot(),
        taskRecovery: taskRecovery.snapshot(),
        activeTurns: Object.fromEntries(activeTurns),
        queuedMutations: [...threadMutationQueue.keys()],
        mutationQueues: threadMutationQueue.snapshot(),
        ownedThreads: [...ownedThreads],
        releasingThreads: [...releasingThreads],
        pendingApprovals: [...codex.serverRequests.entries()].map(([requestId, item]) => ({
          requestId,
          requestToken: item.requestToken,
          method: item.method,
          params: item.params,
          ...(item.fileChangeContext ? { fileChangeContext: item.fileChangeContext } : {}),
        })),
      });
      return true;
    }

    return false;
  }

  return { handleDiagnosticsApi };
}
