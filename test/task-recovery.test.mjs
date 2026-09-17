import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskRecovery } from "../task-recovery.mjs";

const event = (method, id = "turn-one") => ({ kind: "app-server/notification", message: {
  method, params: { threadId: "task", turn: { id, status: method === "turn/started" ? "inProgress" : "completed" } },
} });

test("known running tasks survive restart as unconfirmed until a fresh read verifies them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pwa-task-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistencePath = join(root, "tasks.json");
  const first = new TaskRecovery({ persistencePath });
  first.observe(event("turn/started"));
  assert.equal((await stat(persistencePath)).mode & 0o777, 0o600);
  const updates = [];
  let state = { threadStatus: { type: "active", activeFlags: [] }, turn: { id: "turn-one", status: "inProgress" } };
  const restored = new TaskRecovery({ persistencePath, readSnapshot: async () => state, onRecovered: (record) => updates.push(record) });
  assert.equal(restored.snapshot().unconfirmed, 1);
  await restored.reconcile({ force: true });
  assert.equal(restored.snapshot().running, 1);
  assert.equal(updates[0].status, "running");
  state = { threadStatus: { type: "idle" }, turn: { id: "turn-one", status: "completed", completedAt: 100 } };
  await restored.reconcile({ force: true });
  assert.equal(updates.at(-1).status, "completed");
  await restored.reconcile({ force: true });
  assert.equal(updates.length, 2, "unchanged terminal state must not announce again");
  const contents = await readFile(persistencePath, "utf8");
  assert.doesNotMatch(contents, /items|prompt|command|cwd/);
});

test("late recovery replies cannot overwrite a newer live turn", async () => {
  let finish;
  const updates = [];
  const recovery = new TaskRecovery({ readSnapshot: () => new Promise((resolve) => { finish = resolve; }),
    onRecovered: (record) => updates.push(record) });
  recovery.observe(event("turn/started"));
  const pending = recovery.reconcile({ force: true });
  await new Promise((resolve) => setImmediate(resolve));
  recovery.observe(event("turn/started", "turn-two"));
  finish({ threadStatus: { type: "idle" }, turn: { id: "turn-one", status: "completed" } });
  await pending;
  assert.equal(updates.length, 0);
  assert.equal(recovery.snapshot().running, 1);
  recovery.observe(event("turn/completed", "turn-one"));
  assert.equal(recovery.snapshot().running, 1, "a late old completion must not end the new turn");
});

test("unloaded/inconsistent history and temporary read failure remain unconfirmed, not completed", async () => {
  let result;
  const updates = [];
  const recovery = new TaskRecovery({ readSnapshot: async () => {
    if (result instanceof Error) throw result;
    return result;
  }, onRecovered: (record) => updates.push(record) });
  recovery.observe(event("turn/started"));
  for (const state of [
    { threadStatus: { type: "notLoaded" }, turn: { id: "turn-one", status: "inProgress" } },
    { threadStatus: { type: "active", activeFlags: [] }, turn: { id: "turn-one", status: "completed" } },
    { threadStatus: { type: "idle" }, turn: null },
    new Error("temporary transport failure"),
  ]) {
    result = state;
    await recovery.reconcile({ force: true });
    assert.equal(recovery.snapshot().unconfirmed, 1);
    assert.equal(recovery.snapshot().completed, 0);
  }
  assert.equal(updates.length, 0);
});

test("access removal drops tracking without publishing task state", async () => {
  const updates = [];
  const recovery = new TaskRecovery({ readSnapshot: async () => { throw Object.assign(new Error("outside roots"), { statusCode: 403 }); },
    onRecovered: (record) => updates.push(record) });
  recovery.observe(event("turn/started"));
  await recovery.reconcile({ force: true });
  assert.equal(recovery.snapshot().tracked, 0);
  assert.equal(updates.length, 0);
});

test("corrupt recovery data is preserved and reported without breaking live observation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pwa-recovery-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistencePath = join(root, "tasks.json");
  await writeFile(persistencePath, "broken original record");
  const recovery = new TaskRecovery({ persistencePath });
  recovery.observe(event("turn/started"));
  assert.equal(recovery.snapshot().storageHealthy, false);
  assert.equal(await readFile(persistencePath, "utf8"), "broken original record");
  assert.equal(recovery.snapshot().running, 1);
});

test("bounded recovery prefers unfinished tasks and limits concurrent reads", async () => {
  let active = 0;
  let peak = 0;
  const recovery = new TaskRecovery({ maxTracked: 8, readSnapshot: async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { threadStatus: { type: "notLoaded" }, turn: null };
  } });
  for (let index = 0; index < 12; index += 1) {
    const payload = event("turn/started");
    payload.message.params.threadId = `task-${index}`;
    recovery.observe(payload);
  }
  assert.equal(recovery.snapshot().tracked, 8);
  assert.equal(recovery.snapshot().dropped, 4);
  const pending = recovery.reconcile({ force: true });
  assert.equal(recovery.reconcile({ force: true }), pending, "poll ticks share one bounded batch");
  await pending;
  assert.equal(peak, 4);
  assert.equal(recovery.snapshot().unconfirmed, 8);
  const finished = event("turn/completed");
  finished.message.params.threadId = "task-4";
  recovery.observe(finished);
  recovery.observe(event("turn/started", "new-turn"));
  assert.equal(recovery.snapshot().tracked, 8);
  assert.equal(recovery.snapshot().dropped, 4, "discard a terminal record before an unfinished task");
});

test("unrelated terminal history and reads invalidated by disconnect cannot confirm a task", async () => {
  let finish;
  const updates = [];
  const recovery = new TaskRecovery({ readSnapshot: () => new Promise((resolve) => { finish = resolve; }),
    onRecovered: (record) => updates.push(record) });
  recovery.observe(event("turn/started"));
  let pending = recovery.reconcile({ force: true });
  finish({ threadStatus: { type: "idle" }, turn: { id: "unrelated-turn", status: "completed" } });
  await pending;
  assert.equal(recovery.snapshot().unconfirmed, 1);
  pending = recovery.reconcile({ force: true });
  recovery.invalidate();
  finish({ threadStatus: { type: "active" }, turn: { id: "turn-one", status: "inProgress" } });
  await pending;
  assert.equal(recovery.snapshot().unconfirmed, 1);
  assert.deepEqual(updates, []);
});

test("losing one subscription invalidates only that task and allows read-only confirmation again", async () => {
  const updates = [];
  const recovery = new TaskRecovery({ readSnapshot: async () => ({ threadStatus: { type: "active" },
    turn: { id: "turn-one", status: "inProgress" } }), onRecovered: (record) => updates.push(record) });
  recovery.observe(event("turn/started"));
  const other = event("turn/started");
  other.message.params.threadId = "other";
  recovery.observe(other);
  recovery.invalidate("task");
  assert.equal(recovery.snapshot().unconfirmed, 1);
  assert.equal(recovery.snapshot().running, 1);
  await recovery.reconcile({ force: true });
  assert.equal(recovery.snapshot().running, 2);
  assert.deepEqual(updates.map((record) => record.threadId), ["task"]);
});
