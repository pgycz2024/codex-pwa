export function normalizeUserMessageText(text) {
  return String(text || "").replace(/\r\n/g, "\n").trim();
}

export function findPendingUserMessageIndex(pendingMessages, threadId, text) {
  const normalized = normalizeUserMessageText(text);
  return pendingMessages.findIndex((message) => (
    message.threadId === threadId && message.text === normalized
  ));
}

export function reconcilePendingUserMessage({
  pendingMessages,
  itemNodes,
  itemTurns = null,
  threadId,
  itemId,
  text,
}) {
  const pendingIndex = findPendingUserMessageIndex(pendingMessages, threadId, text);
  if (pendingIndex < 0) return null;
  const [pending] = pendingMessages.splice(pendingIndex, 1);
  const node = itemNodes.get(pending.id);
  if (!node || node.type !== "user") return null;
  itemNodes.delete(pending.id);
  itemNodes.set(itemId, node);
  if (itemTurns) {
    const turnId = itemTurns.get(pending.id);
    itemTurns.delete(pending.id);
    if (turnId) itemTurns.set(itemId, turnId);
  }
  return node;
}
