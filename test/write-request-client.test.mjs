import test from "node:test";
import assert from "node:assert/strict";
import { createApiClient } from "../public/api-client.js";
import { createWriteRequestClient } from "../public/write-request.js";

function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("network loss and unreadable mutation replies remain unknown instead of successful or safe to retry", async () => {
  for (const fetchImpl of [
    async () => { throw new TypeError("Failed to fetch"); },
    async () => ({ ok: true, status: 202, json: async () => { throw new SyntaxError("truncated"); } }),
  ]) {
    const api = createApiClient({ fetchImpl });
    await assert.rejects(api("/api/threads/task/turns", { method: "POST" }), (error) => error.outcomeUnknown === true);
    await assert.rejects(api("/api/status"), (error) => !error.outcomeUnknown);
  }
  const api = createApiClient({ fetchImpl: async () => ({ ok: false, status: 409,
    json: async () => ({ error: "conflict", details: { code: "THREAD_WRITE_CONFLICT" } }),
  }) });
  await assert.rejects(api("/api/threads/task/turns", { method: "POST" }), (error) => error.outcomeUnknown === false);
});

test("waiting request uses a server-confirmed cancellation and preserves its identity", async () => {
  const post = gate();
  const calls = [];
  const client = createWriteRequestClient({ pollInterval: 60_000, makeId: () => "one", api: async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === "POST") return post.promise;
    if (options.method === "DELETE") return { state: "cancelled", resultAvailable: true, error: "已取消", details: { code: "THREAD_WRITE_CANCELLED" } };
    return { state: "queued", position: 2, waitingOn: { label: "电脑", currentDevice: false } };
  } });
  const pending = client.request("task", "/api/threads/task/turns", { method: "POST" });
  const rejected = assert.rejects(pending, (error) => error.details?.code === "THREAD_WRITE_CANCELLED" && !error.outcomeUnknown);
  await client.check("one");
  assert.equal(client.snapshot("task")[0].state, "queued");
  assert.equal(client.snapshot("another-task").length, 0);
  assert.equal(calls[0].options.signal.aborted, false, "the original request stays open until confirmation");
  assert.equal((await client.cancel("one")).state, "cancelled");
  post.reject(Object.assign(new Error("reply lost"), { outcomeUnknown: true }));
  await rejected;
  assert.equal(calls[0].options.headers["X-Codex-PWA-Write-Id"], "one");
  assert.equal(calls[0].options.signal.aborted, true, "a confirmed cancellation may close the original connection");
  assert.equal(calls.some((call) => call.path === "/api/threads/task/writes/one" && call.options.method === "DELETE"), true);
  assert.equal(client.snapshot("task").length, 0);
});

test("cancellation losing the dispatch race is shown as running and a receipt recovers success", async () => {
  const post = gate();
  let completed = false;
  const client = createWriteRequestClient({ pollInterval: 60_000, makeId: () => "two", api: async (path, options = {}) => {
    if (options.method === "POST") return post.promise;
    return completed ? { state: "succeeded", resultAvailable: true, result: { turn: { id: "accepted" } } } : { state: "running" };
  } });
  const pending = client.request("task", "/api/threads/task/turns", { method: "POST" });
  assert.equal((await client.cancel("two")).state, "running");
  assert.equal(client.snapshot("task")[0].state, "running");
  completed = true;
  post.reject(Object.assign(new Error("reply lost"), { outcomeUnknown: true }));
  assert.deepEqual(await pending, { turn: { id: "accepted" } });
});

test("missing or failed cancellation receipts never claim the operation was cancelled", async () => {
  const post = gate();
  const client = createWriteRequestClient({ pollInterval: 60_000, makeId: () => "three", api: async (path, options = {}) => {
    if (options.method === "POST") return post.promise;
    throw Object.assign(new Error("record expired"), { statusCode: 404 });
  } });
  const pending = client.request("task", "/api/threads/task/turns", { method: "POST" });
  const rejected = assert.rejects(pending, (error) => error.outcomeUnknown === true);
  await assert.rejects(client.cancel("three"), /record expired/);
  assert.notEqual(client.snapshot("task")[0].state, "cancelled");
  post.reject(Object.assign(new Error("reply lost"), { outcomeUnknown: true }));
  await rejected;
});
