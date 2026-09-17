import test from "node:test";
import assert from "node:assert/strict";
import { buildActiveTaskSnapshot, readTaskSnapshot, reconcileTaskSnapshot, mergeTaskSnapshot } from "../public/task-snapshot.js";
import { threadStatusInfo, turnOutcomeCopy, snapshotRecoveryMessage } from "../public/status-display.js";

test("status presentation distinguishes protocol activity, loading and terminal evidence", () => {
  for (const value of [undefined, null, "inactive", "runningLater", "unfailed", "constructor", { type: "futureStatus" }, { toString: null, valueOf: null }]) {
    assert.equal(threadStatusInfo(value).type, "unknown");
    assert.equal(turnOutcomeCopy(value), null, "unrecognized status cannot be a successful outcome");
  }
  assert.equal(threadStatusInfo({ type: "notLoaded" }).type, "saved");
  assert.equal(threadStatusInfo({ type: "systemError" }).type, "error");
  assert.equal(threadStatusInfo({ type: "active", activeFlags: ["waitingOnUserInput"] }).type, "waiting");
  assert.equal(threadStatusInfo({ type: "active", activeFlags: "waitingOnApproval" }).type, "active");
  assert.equal(turnOutcomeCopy("interrupted").title, "Codex 任务已停止");
  assert.equal(turnOutcomeCopy("failed").title, "Codex 任务失败");
});

test("a refreshed task list cannot prove successful completion of a previously active turn", () => {
  const ids = ["running", "waiting", "idle", "error", "saved", "unknown", "missing"];
  const previous = ids.map((id) => ({ id, status: "active", at: 10 }));
  const threads = [
    { id: "running", status: { type: "active" } },
    { id: "waiting", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
    { id: "idle", status: { type: "idle" } },
    { id: "error", status: { type: "systemError" } },
    { id: "saved", status: { type: "notLoaded" } },
    { id: "unknown", status: { type: "futureStatus" } },
  ];
  const current = [{ id: "running", status: "active", at: 20 }, { id: "waiting", status: "waiting", at: 20 }];
  const result = reconcileTaskSnapshot(previous, current, threads);
  assert.equal(result.completed?.length || 0, 0, "idle, errors and unloaded tasks must not be called completed");
  assert.deepEqual(Object.fromEntries(Object.entries(result).map(([key, items]) => [key, items.map((item) => item.id)])), {
    stillRunning: ["running"], waiting: ["waiting"], inactive: ["idle"], errors: ["error"],
    unconfirmed: ["saved", "unknown", "missing"],
  });
  const copy = snapshotRecoveryMessage(result);
  assert.doesNotMatch(copy, /已完成/);
  for (const phrase of ["仍在运行", "等待操作", "已空闲", "出现异常", "3 个后台任务状态待核实"]) assert.ok(copy.includes(phrase));
});

test("searches and partial task lists retain unresolved activity without manufacturing completion", () => {
  const previous = ["saved", "absent", "idle", "error"].map((id) => ({ id, status: "active", at: 10 }));
  const threads = [
    { id: "saved", status: { type: "notLoaded" } }, { id: "idle", status: { type: "idle" } },
    { id: "error", status: { type: "systemError" } }, { id: "new", status: { type: "active" } },
  ];
  const next = mergeTaskSnapshot(previous, buildActiveTaskSnapshot(threads, undefined, 20), threads);
  assert.deepEqual(next, [
    { id: "saved", status: "unconfirmed", at: 10 }, { id: "absent", status: "unconfirmed", at: 10 },
    { id: "new", status: "active", at: 20 },
  ]);
  const filtered = mergeTaskSnapshot(next, [], []);
  assert.deepEqual(filtered.map((item) => item.id), ["saved", "absent", "new"]);
  assert.ok(filtered.every((item) => item.status === "unconfirmed"));
  const resolved = [{ id: "absent", status: { type: "idle" } }];
  assert.deepEqual(mergeTaskSnapshot(filtered, [], resolved).map((item) => item.id), ["saved", "new"]);
});

test("activity snapshots bound and sanitize both live data and persisted records", () => {
  const threads = Array.from({ length: 300 }, (_, index) => ({ id: `task-${index}`, status: "active" }));
  threads.push({ id: "task-299", status: "active" }, { id: "", status: "active" }, { id: 42, status: "active" });
  const current = buildActiveTaskSnapshot(threads, (status) => status, 123);
  assert.equal(current.length, 200);
  assert.equal(new Set(current.map((item) => item.id)).size, 200);
  const stored = readTaskSnapshot({ getItem: () => JSON.stringify([
    { id: "a", status: "unconfirmed", at: 10 }, { id: "a", status: "unconfirmed", at: 11 },
    { id: "", status: "active" }, { id: "bad", status: "completed" },
  ]) }, "snapshot");
  assert.deepEqual(stored, [{ id: "a", status: "unconfirmed", at: 11 }]);
});
