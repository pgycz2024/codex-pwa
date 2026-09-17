import test from "node:test";
import assert from "node:assert/strict";
import { createThreadApi, querySuffix } from "../public/thread-api.js";

test("thread API centralizes bounded path encoding and query serialization", async () => {
  assert.equal(querySuffix(), "");
  assert.equal(querySuffix("?limit=1"), "?limit=1");
  assert.equal(querySuffix(new URLSearchParams({ limit: "2", items: "full" })), "?limit=2&items=full");
  const calls = [];
  const api = createThreadApi({ api: async (path) => { calls.push(path); return { path }; } });
  await api.list(new URLSearchParams({ search: "a b", limit: "5" }));
  await api.get("task/id", "subscribe=true");
  await api.turns("task/id", new URLSearchParams({ cursor: "a/b" }));
  await api.transcript("task/id", "turn 1");
  await api.output("task/id", "item/1");
  await api.artifacts("task/id");
  assert.deepEqual(calls, [
    "/api/threads?search=a+b&limit=5",
    "/api/threads/task%2Fid?subscribe=true",
    "/api/threads/task%2Fid/turns?cursor=a%2Fb",
    "/api/threads/task%2Fid/transcript?turnId=turn+1",
    "/api/threads/task%2Fid/outputs/item%2F1",
    "/api/threads/task%2Fid/artifacts",
  ]);
});

test("thread API rejects a missing transport function", () => {
  assert.throws(() => createThreadApi(), /requires an api function/);
});
