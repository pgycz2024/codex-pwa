import { publicErrorMessage } from "./error-utils.mjs";

function queueError(code, message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = { code, dispatched: false, outcomeUnknown: false, retryable: true };
  return error;
}

function cancelledError() {
  return queueError("THREAD_WRITE_CANCELLED", "请求已取消，尚未发送给 Codex", 499);
}

export class ThreadMutationQueue {
  constructor({ maxPendingPerThread = 32, maxTotal = 1024, maxWaitMs = 30_000,
    maxReceipts = 128, receiptTtlMs = 120_000, now = Date.now } = {}) {
    for (const value of [maxPendingPerThread, maxTotal, maxWaitMs, maxReceipts, receiptTtlMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Queue limits must be positive integers");
    }
    this.queues = new Map();
    this.total = 0;
    this.maxPendingPerThread = maxPendingPerThread;
    this.maxTotal = maxTotal;
    this.maxWaitMs = maxWaitMs;
    this.records = new Map();
    this.receipts = new Map();
    this.maxReceipts = maxReceipts;
    this.receiptTtlMs = receiptTtlMs;
    this.now = now;
  }

  run(threadId, task, { signal, requestId = "", ownerId = "", deviceLabel = "浏览器设备" } = {}) {
    this.pruneReceipts();
    if (signal?.aborted) return Promise.reject(cancelledError());
    const key = String(threadId || "");
    if (!key) return Promise.resolve().then(task);
    if (requestId && this.records.has(requestId)) {
      return Promise.reject(queueError("WRITE_REQUEST_ID_REUSED", "此请求编号已使用，请先核对原操作结果", 409));
    }
    const queue = this.queues.get(key) || { active: null, pending: [] };
    if (queue.pending.length >= this.maxPendingPerThread || this.total >= this.maxTotal) {
      return Promise.reject(queueError("THREAD_WRITE_QUEUE_FULL", "等待中的操作过多；本次请求未发送，请稍后重试", 429));
    }
    this.queues.set(key, queue);
    this.total += 1;
    return new Promise((resolve, reject) => {
      const record = { requestId, threadId: key, ownerId, deviceLabel: String(deviceLabel).slice(0, 120), state: "queued" };
      const entry = { task, resolve, reject, cleanup: null, record };
      if (requestId) this.records.set(requestId, record);
      const cancel = (error) => {
        const index = queue.pending.indexOf(entry);
        if (index < 0) return; // Dispatch has begun; cancellation cannot release its lock.
        queue.pending.splice(index, 1);
        entry.cleanup();
        this.total -= 1;
        if (!queue.active && !queue.pending.length) this.queues.delete(key);
        this.finishRecord(record, error.details?.code === "THREAD_WRITE_CANCELLED" ? "cancelled" : "failed", undefined, error);
        reject(error);
      };
      const onAbort = () => cancel(cancelledError());
      record.cancel = onAbort;
      const timer = setTimeout(() => cancel(queueError(
        "THREAD_WRITE_WAIT_TIMEOUT", "等待其他操作超时；本次请求未发送，请稍后重试", 408,
      )), this.maxWaitMs);
      entry.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.pending.push(entry);
      queueMicrotask(() => this.drain(key, queue));
    });
  }

  drain(key, queue) {
    if (queue.active || this.queues.get(key) !== queue) return;
    const entry = queue.pending.shift();
    if (!entry) return;
    queue.active = entry;
    entry.record.state = "running";
    delete entry.record.cancel;
    entry.cleanup();
    const finish = (settle, value, failed = false) => {
      this.finishRecord(entry.record, failed ? "failed" : "succeeded", failed ? undefined : value, failed ? value : undefined);
      queue.active = null;
      this.total -= 1;
      if (!queue.pending.length) this.queues.delete(key);
      settle(value);
      queueMicrotask(() => this.drain(key, queue));
    };
    // Both branches settle the caller's promise. Never leave a rejecting
    // cleanup/finally promise detached from the request's error handler.
    Promise.resolve().then(entry.task).then(
      (value) => finish(entry.resolve, value),
      (error) => finish(entry.reject, error, true),
    );
  }

  finishRecord(record, state, result, error) {
    delete record.cancel;
    if (!record.requestId) return;
    record.state = state;
    // Keep only a small, short-lived response receipt, never a task closure or
    // an unbounded reply. Missing/expired receipts mean unknown, not unsent.
    const payload = error ? { error: publicErrorMessage(error), statusCode: error.statusCode || 400, details: error.details || null } : { result: result ?? null };
    try {
      const encoded = JSON.stringify(payload);
      record.resultAvailable = Buffer.byteLength(encoded) <= 32 * 1024;
      if (record.resultAvailable) Object.assign(record, JSON.parse(encoded));
    } catch { record.resultAvailable = false; }
    this.receipts.set(record.requestId, this.now());
    this.pruneReceipts();
  }

  pruneReceipts() {
    const cutoff = this.now() - this.receiptTtlMs;
    for (const [id, at] of this.receipts) {
      if (at > cutoff && this.receipts.size <= this.maxReceipts) break;
      this.receipts.delete(id);
      this.records.delete(id);
    }
  }

  inspect(threadId, requestId, ownerId) {
    this.pruneReceipts();
    const record = this.records.get(requestId);
    if (!record || record.threadId !== threadId || record.ownerId !== ownerId) return null;
    const { cancel, ownerId: _owner, deviceLabel: _label, ...snapshot } = record;
    if (record.state === "queued") {
      const queue = this.queues.get(threadId);
      snapshot.position = (queue?.pending.findIndex((entry) => entry.record === record) ?? -1) + 1;
      if (queue?.active) {
        const writer = queue.active.record;
        snapshot.waitingOn = { label: writer.deviceLabel, currentDevice: ownerId !== "unauthenticated" && Boolean(ownerId) && writer.ownerId === ownerId };
      }
    }
    return snapshot;
  }

  cancel(threadId, requestId, ownerId) {
    if (!this.inspect(threadId, requestId, ownerId)) return null;
    this.records.get(requestId)?.cancel?.();
    return this.inspect(threadId, requestId, ownerId);
  }

  keys() {
    return this.queues.keys();
  }

  snapshot() {
    return [...this.queues].map(([threadId, queue]) => ({
      threadId, running: Boolean(queue.active), pending: queue.pending.length,
    }));
  }
}
