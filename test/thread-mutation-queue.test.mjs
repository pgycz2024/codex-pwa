import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ThreadMutationQueue } from "../thread-mutation-queue.mjs";

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("only the originating device can inspect and cancel an identified waiting write", async () => {
  const queue = new ThreadMutationQueue();
  const hold = gate();
  const first = queue.run("task", () => hold.promise, { ownerId: "desktop", deviceLabel: "工作电脑" });
  const waiting = queue.run("task", () => assert.fail("cancelled write dispatched"), {
    requestId: "request-1", ownerId: "phone", deviceLabel: "我的手机",
  });
  const cancelled = assert.rejects(waiting, (error) => error.details?.code === "THREAD_WRITE_CANCELLED");
  await nextTick();
  try {
    assert.equal(queue.inspect("task", "request-1", "desktop"), null);
    assert.equal(queue.cancel("task", "request-1", "desktop"), null);
    assert.equal(queue.cancel("different-task", "request-1", "phone"), null);
    const snapshot = queue.inspect("task", "request-1", "phone");
    assert.equal(snapshot.state, "queued");
    assert.equal(snapshot.position, 1);
    assert.deepEqual(snapshot.waitingOn, { label: "工作电脑", currentDevice: false });
    assert.equal(queue.cancel("task", "request-1", "phone").state, "cancelled");
    await cancelled;
    assert.equal(queue.inspect("task", "request-1", "phone").state, "cancelled");
  } finally {
    hold.resolve();
    await first;
  }
});

test("cancellation cannot revoke dispatch and a receipt can recover a lost HTTP reply", async () => {
  const queue = new ThreadMutationQueue();
  const hold = gate();
  const options = { requestId: "request-2", ownerId: "phone" };
  const first = queue.run("task", () => hold.promise, options);
  await nextTick();
  try {
    assert.equal(queue.cancel("task", "request-2", "phone").state, "running");
    await assert.rejects(queue.run("task", () => assert.fail("duplicate dispatched"), options),
      (error) => error.details?.code === "WRITE_REQUEST_ID_REUSED");
  } finally {
    hold.resolve({ turn: { id: "accepted" }, settings: { model: "known" } });
    await first;
  }
  const receipt = queue.inspect("task", "request-2", "phone");
  assert.equal(receipt.state, "succeeded");
  assert.equal(receipt.result.turn.id, "accepted");
  assert.equal(queue.cancel("task", "request-2", "phone").state, "succeeded");
});

test("receipts expire and oversized results cannot become an unbounded transcript cache", async () => {
  let time = 100;
  const queue = new ThreadMutationQueue({ now: () => time, receiptTtlMs: 10, maxReceipts: 2 });
  for (const requestId of ["one", "two", "three"]) {
    await queue.run("task", () => "x".repeat(40_000), { requestId, ownerId: "phone" });
  }
  assert.equal(queue.inspect("task", "one", "phone"), null);
  const receipt = queue.inspect("task", "three", "phone");
  assert.equal(receipt.state, "succeeded");
  assert.equal(receipt.resultAvailable, false);
  assert.equal(receipt.result, undefined);
  time += 11;
  assert.equal(queue.inspect("task", "three", "phone"), null);
});

test("handled mutation failures do not terminate the process or poison later writes", async () => {
  const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", `
    import { ThreadMutationQueue } from ${JSON.stringify(new URL("../thread-mutation-queue.mjs", import.meta.url).href)};
    const queue = new ThreadMutationQueue();
    await queue.run("task", () => { throw new Error("simulated conflict"); }).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    if (await queue.run("task", () => "recovered") !== "recovered") process.exit(2);
    if ([...queue.keys()].length) process.exit(3);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  child.stderr.on("data", (data) => { diagnostics += data; });
  child.stdout.resume();
  const [code] = await once(child, "exit");
  assert.equal(code, 0, diagnostics);
});

test("aborting a waiting write settles it immediately and never dispatches it", async () => {
  const queue = new ThreadMutationQueue();
  const hold = gate();
  const first = queue.run("task", () => hold.promise);
  const abort = new AbortController();
  let sent = false;
  const waiting = queue.run("task", () => { sent = true; }, { signal: abort.signal });
  const rejected = assert.rejects(waiting, (error) => error.details?.code === "THREAD_WRITE_CANCELLED"
    && error.details.dispatched === false);
  abort.abort();
  try {
    await Promise.race([rejected, delay(500).then(() => { throw new Error("cancellation was not immediate"); })]);
    assert.equal(sent, false);
    assert.deepEqual(queue.snapshot(), [{ threadId: "task", running: true, pending: 0 }]);
  } finally {
    hold.resolve();
    await first;
  }
  await nextTick();
  assert.equal(sent, false);
  assert.deepEqual([...queue.keys()], []);
});

test("disconnecting after dispatch does not release the active writer early", async () => {
  const queue = new ThreadMutationQueue();
  const hold = gate();
  const abort = new AbortController();
  const first = queue.run("task", () => hold.promise, { signal: abort.signal });
  let followingSent = false;
  const second = queue.run("task", () => { followingSent = true; });
  await nextTick();
  abort.abort();
  await nextTick();
  assert.equal(followingSent, false);
  hold.resolve("accepted");
  assert.equal(await first, "accepted");
  await second;
  assert.equal(followingSent, true);
});

test("already aborted requests never reach the writer", async () => {
  const queue = new ThreadMutationQueue();
  let called = false;
  await assert.rejects(queue.run("task", () => { called = true; }, {
    signal: AbortSignal.abort(),
  }), (error) => error.details?.code === "THREAD_WRITE_CANCELLED");
  assert.equal(called, false);
  assert.deepEqual([...queue.keys()], []);
});

test("queue limits reject excess work and cancellation immediately frees capacity", async () => {
  const queue = new ThreadMutationQueue({ maxPendingPerThread: 1, maxTotal: 3 });
  const hold = gate();
  const first = queue.run("a", () => hold.promise);
  await nextTick();
  const abort = new AbortController();
  const pending = queue.run("a", () => "not sent", { signal: abort.signal });
  const cancelled = assert.rejects(pending, (error) => error.details?.code === "THREAD_WRITE_CANCELLED");
  let other;
  try {
    await assert.rejects(queue.run("a", () => assert.fail("overfull task dispatched")), (error) =>
      error.statusCode === 429 && error.details?.code === "THREAD_WRITE_QUEUE_FULL");
    other = queue.run("b", () => hold.promise);
    await assert.rejects(queue.run("c", () => assert.fail("global overflow dispatched")), (error) =>
      error.statusCode === 429 && error.details?.dispatched === false);
    abort.abort();
    await cancelled;
    assert.equal(await queue.run("c", () => "independent write"), "independent write");
  } finally {
    hold.resolve();
    await Promise.all([first, other]);
  }
  assert.deepEqual([...queue.keys()], []);
});

test("waiting writes expire before dispatch while active writes keep their lock", async () => {
  const queue = new ThreadMutationQueue({ maxWaitMs: 20 });
  const hold = gate();
  let sent = false;
  const first = queue.run("task", () => hold.promise);
  await nextTick();
  try {
    await assert.rejects(queue.run("task", () => { sent = true; }), (error) =>
      error.statusCode === 408 && error.details?.code === "THREAD_WRITE_WAIT_TIMEOUT"
        && error.details.dispatched === false && error.details.outcomeUnknown === false);
    assert.equal(sent, false);
    assert.deepEqual(queue.snapshot(), [{ threadId: "task", running: true, pending: 0 }]);
  } finally {
    hold.resolve();
    await first;
  }
  assert.equal(await queue.run("task", () => "later write"), "later write");
  assert.equal(sent, false);
});
