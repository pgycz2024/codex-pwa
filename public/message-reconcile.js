export function normalizeUserMessageText(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

export function createClientMessageId() {
  // Works on private HTTP deployments too; this identifies a message, not a device.
  return `pwa-${[...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function findPendingUserMessageIndex(pendingMessages, threadId, text, clientId = null) {
  const normalized = normalizeUserMessageText(text);
  return pendingMessages.findIndex((message) => (
    message.threadId === threadId && (clientId
      ? message.clientId === clientId
      : !message.clientId && message.text === normalized)
  ));
}

export function reconcilePendingUserMessage({
  pendingMessages,
  itemNodes,
  itemTurns = null,
  itemTimings = null,
  threadId,
  itemId,
  text,
  clientId = null,
}) {
  const pendingIndex = findPendingUserMessageIndex(pendingMessages, threadId, text, clientId);
  if (pendingIndex < 0) return null;
  const [pending] = pendingMessages.splice(pendingIndex, 1);
  const node = itemNodes.get(pending.id);
  if (!node || node.type !== "user") return null;
  itemNodes.delete(pending.id);
  itemNodes.set(itemId, node);
  if (itemTimings) {
    const timing = itemTimings.get(pending.id);
    itemTimings.delete(pending.id);
    if (timing) itemTimings.set(itemId, timing);
  }
  if (itemTurns) {
    const turnId = itemTurns.get(pending.id);
    itemTurns.delete(pending.id);
    if (turnId) itemTurns.set(itemId, turnId);
  }
  return node;
}
