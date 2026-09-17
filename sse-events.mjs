export function createSseEvents({ replay, maxQueueBytes = 4 * 1024 * 1024 } = {}) {
  if (!replay || typeof replay.append !== "function" || typeof replay.after !== "function") {
    throw new TypeError("createSseEvents requires an event replay buffer");
  }
  const clients = new Map();

  function closeClient(response, { destroy = false } = {}) {
    const client = clients.get(response);
    if (!client) return;
    client.closed = true;
    clients.delete(response);
    if (client.onDrain) response.off("drain", client.onDrain);
    if (destroy) response.destroy();
    else if (!response.writableEnded) response.end();
  }

  function queueFrame(response, client, frame) {
    if (client.closed || response.writableEnded) return;
    if (client.backpressured) {
      client.queue.push(frame);
      client.queuedBytes += Buffer.byteLength(frame);
      if (client.queuedBytes > maxQueueBytes) closeClient(response, { destroy: true });
      return;
    }
    try {
      if (!response.write(frame)) client.backpressured = true;
    } catch {
      closeClient(response, { destroy: true });
    }
  }

  function flushClient(response, client) {
    if (client.closed || response.writableEnded) return;
    client.backpressured = false;
    while (client.queue.length) {
      const frame = client.queue.shift();
      client.queuedBytes -= Buffer.byteLength(frame);
      try {
        if (!response.write(frame)) {
          client.backpressured = true;
          return;
        }
      } catch {
        closeClient(response, { destroy: true });
        return;
      }
    }
  }

  function broadcast(payload) {
    const { frame } = replay.append(payload);
    for (const [response, client] of clients) queueFrame(response, client, frame);
  }

  function closeDeviceStreams(deviceId) {
    if (!deviceId) return;
    for (const [response, client] of clients) {
      if (client.deviceId === deviceId) closeClient(response);
    }
  }

  function closeOtherDeviceStreams(currentDeviceId) {
    for (const [response, client] of clients) {
      if (client.deviceId && client.deviceId === currentDeviceId) continue;
      closeClient(response);
    }
  }

  function openStream(request, response, url, { deviceId = null, status }) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const client = {
      deviceId: deviceId,
      connectedAt: Date.now(),
      queue: [],
      queuedBytes: 0,
      backpressured: false,
      closed: false,
      onDrain: null,
    };
    client.onDrain = () => flushClient(response, client);
    clients.set(response, client);
    const requestedEventId = Number.parseInt(
      url.searchParams.get("after") || request.headers["last-event-id"] || "0",
      10,
    );
    const afterEventId = Number.isSafeInteger(requestedEventId) && requestedEventId > 0 ? requestedEventId : 0;
    const replayPage = replay.after(afterEventId);
    if (replayPage.gap) {
      queueFrame(response, client, `data: ${JSON.stringify({
        kind: "bridge/replayGap",
        afterEventId,
        oldestEventId: replayPage.oldestId,
      })}\n\n`);
    }
    for (const event of replayPage.events) queueFrame(response, client, event.frame);
    queueFrame(response, client, `data: ${JSON.stringify({ kind: "bridge/status", status })}\n\n`);
    const heartbeat = setInterval(() => queueFrame(response, client, `data: ${JSON.stringify({
      kind: "bridge/heartbeat",
      at: Date.now() / 1000,
    })}\n\n`), 20_000);
    heartbeat.unref?.();
    response.on("drain", client.onDrain);
    request.on("close", () => {
      clearInterval(heartbeat);
      closeClient(response);
    });
  }

  return {
    openStream,
    clients,
    replay,
    closeClient,
    queueFrame,
    flushClient,
    broadcast,
    closeDeviceStreams,
    closeOtherDeviceStreams,
  };
}
