function newRequestId() {
  // getRandomValues also works on the supported private HTTP deployment.
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function receiptError(receipt) {
  const error = new Error(receipt.error || "操作结果尚未确认，请核对任务状态");
  error.statusCode = receipt.statusCode;
  error.details = receipt.details || null;
  error.outcomeUnknown = receipt.state !== "cancelled" && Boolean(receipt.details?.outcomeUnknown || !receipt.resultAvailable);
  return error;
}

const terminal = (receipt) => ["cancelled", "failed", "succeeded"].includes(receipt?.state);

export function createWriteRequestClient({ api, onChange = () => {}, makeId = newRequestId, pollInterval = 750 }) {
  const pending = new Map();
  const statusPath = (entry) => `/api/threads/${encodeURIComponent(entry.threadId)}/writes/${encodeURIComponent(entry.id)}`;
  function apply(entry, receipt) {
    if (!pending.has(entry.id)) return;
    if (entry.receipt?.state === "running" && receipt.state === "queued") return;
    entry.receipt = receipt;
    entry.state = receipt.state || "checking";
    entry.position = receipt.position || 0;
    entry.waitingOn = receipt.waitingOn || null;
    if (terminal(receipt) && (receipt.resultAvailable || receipt.state === "cancelled")) entry.resolveReceipt?.(receipt);
    onChange();
  }
  async function check(id) {
    const entry = pending.get(id);
    if (!entry) return null;
    if (entry.inspection) return entry.inspection;
    const abort = new AbortController();
    entry.checkAbort = abort;
    const timeout = setTimeout(() => abort.abort(), 4000);
    entry.inspection = (async () => {
      try {
        const receipt = await api(statusPath(entry), { signal: abort.signal });
        // A slower status read cannot undo a confirmed cancellation/result.
        if (!terminal(entry.receipt)) apply(entry, receipt);
        return terminal(entry.receipt) ? entry.receipt : receipt;
      } catch (error) {
        if (pending.has(id) && !terminal(entry.receipt)) {
          entry.state = "checking";
          onChange();
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        entry.inspection = null;
      }
    })();
    return entry.inspection;
  }
  function poll(entry) {
    entry.timer = setTimeout(async () => {
      await check(entry.id).catch(() => {});
      if (pending.has(entry.id) && !terminal(entry.receipt)) poll(entry);
    }, pollInterval);
  }
  async function request(threadId, path, options = {}, label = "操作") {
    if (!threadId) return api(path, options);
    const entry = { id: makeId(), threadId, label, state: "submitting", position: 0, cancelling: false, receipt: null };
    const confirmed = new Promise((resolve) => { entry.resolveReceipt = resolve; }).then((receipt) => {
      if (receipt.state === "succeeded") return receipt.result;
      throw receiptError(receipt);
    });
    const postAbort = new AbortController();
    pending.set(entry.id, entry);
    onChange();
    poll(entry);
    try {
      return await Promise.race([confirmed, api(path, { ...options, signal: options.signal || postAbort.signal,
        headers: { ...options.headers, "X-Codex-PWA-Write-Id": entry.id } })]);
    } catch (error) {
      if (error.outcomeUnknown) {
        let receipt = entry.receipt;
        if (!terminal(receipt)) receipt = await check(entry.id).catch(() => null);
        if (receipt?.state === "succeeded" && receipt.resultAvailable) return receipt.result;
        if (["cancelled", "failed"].includes(receipt?.state)) throw receiptError(receipt);
      }
      throw error;
    } finally {
      pending.delete(entry.id);
      clearTimeout(entry.timer);
      // Only close the original fetch after a separate server receipt proves
      // its outcome. Aborting a fetch alone never proves cancellation.
      if (terminal(entry.receipt)) postAbort.abort();
      entry.checkAbort?.abort();
      onChange();
    }
  }
  async function cancel(id) {
    const entry = pending.get(id);
    if (!entry) return null;
    entry.cancelling = true;
    onChange();
    try {
      const receipt = await api(statusPath(entry), { method: "DELETE" });
      apply(entry, receipt);
      return receipt;
    } catch (error) {
      const receipt = terminal(entry.receipt) ? entry.receipt : await check(id).catch(() => null);
      if (terminal(receipt)) return receipt;
      throw error;
    } finally {
      entry.cancelling = false;
      onChange();
    }
  }
  function snapshot(threadId) {
    return [...pending.values()].filter((entry) => entry.threadId === threadId).map(({ id, threadId, label, state, cancelling, position, waitingOn }) =>
      ({ id, threadId, label, state, cancelling, position, waitingOn }));
  }
  return { request, check, cancel, snapshot };
}
