import test from "node:test";
import assert from "node:assert/strict";
import { permittedRecoveryRead } from "../scripts/verify-live-recovery.mjs";

test("live recovery relay permits only exact metadata reads for the selected task", () => {
  for (const request of [
    { id: 0, method: "initialize", params: { clientInfo: { name: "test" } } },
    { method: "initialized", params: {} },
    { id: 1, method: "thread/read", params: { threadId: "target", includeTurns: false } },
    { id: 2, method: "thread/turns/list", params: { threadId: "target", limit: 1, sortDirection: "desc", itemsView: "notLoaded" } },
  ]) assert.equal(permittedRecoveryRead(request, "target"), true);
});

test("live recovery relay blocks task mutations and approval replies", () => {
  for (const method of ["thread/start", "thread/resume", "thread/unsubscribe", "thread/archive", "thread/goal/set",
    "turn/start", "turn/steer", "turn/interrupt", "thread/list", "thread/items/list", "process/spawn", "command/exec"]) {
    assert.equal(permittedRecoveryRead({ id: 3, method, params: { threadId: "target" } }, "target"), false, method);
  }
  for (const response of [{ id: 4, result: { decision: "accept" } }, { id: 4, error: { code: -32601 } },
    { id: 4, method: "initialize", result: {} }]) assert.equal(permittedRecoveryRead(response, "target"), false);
});

test("live recovery relay rejects broader history, other tasks and added read fields", () => {
  for (const params of [
    { threadId: "other", includeTurns: false }, { threadId: "target", includeTurns: true },
    { threadId: "target" }, { threadId: "target", includeTurns: false, path: "/other" },
  ]) assert.equal(permittedRecoveryRead({ id: 5, method: "thread/read", params }, "target"), false);
  const page = { threadId: "target", limit: 1, sortDirection: "desc", itemsView: "notLoaded" };
  for (const extra of [{ threadId: "other" }, { limit: 2 }, { itemsView: "full" }, { itemsView: "summary" }, { cursor: "older" }]) {
    assert.equal(permittedRecoveryRead({ id: 6, method: "thread/turns/list", params: { ...page, ...extra } }, "target"), false);
  }
  for (const message of [null, [], {}, { method: "thread/read", params: { threadId: "target", includeTurns: false } }]) {
    assert.equal(permittedRecoveryRead(message, "target"), false);
  }
});
