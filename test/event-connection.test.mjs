import test from "node:test";
import assert from "node:assert/strict";
import { createEventConnectionManager } from "../public/event-connection.js";

const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixture(t, recovery) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sources = [], toasts = [];
  const environment = { navigator: { onLine: true }, document: { visibilityState: "visible" },
    EventSource: class { constructor() { sources.push(this); } close() {} } };
  const state = { auth: { authenticated: true }, eventGeneration: 0, eventReconnectAttempt: 1,
    eventRecoveryPending: false, eventRecoveryCount: 0, lastEventId: 0 };
  const manager = createEventConnectionManager({ state, environment, runVisibleRecovery: recovery,
    setConnection() {}, showToast: (text) => toasts.push(text) });
  t.after(() => manager.stop());
  manager.connect();
  return { state, manager, sources, toasts, environment };
}

test("deferred recovery never claims that task state has synchronized", async (t) => {
  const f = fixture(t, async () => false);
  f.sources[0].onopen();
  await flush();
  t.mock.timers.tick(700);
  assert.equal(f.toasts.length, 0);
});

test("an old connection cannot announce recovery after it disconnects", async (t) => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  f.sources[0].onopen();
  await flush();
  f.sources[0].onerror();
  pending.resolve(true);
  await flush();
  t.mock.timers.tick(700);
  assert.equal(f.toasts.length, 0);
});

test("disconnecting cancels an already scheduled recovery announcement", async (t) => {
  const f = fixture(t, async () => true);
  f.sources[0].onopen();
  await flush();
  f.sources[0].onerror();
  t.mock.timers.tick(700);
  assert.equal(f.toasts.length, 0);
});

test("failed synchronization is caught and retried before reporting recovery", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { if (++calls === 1) throw new Error("HTTP unavailable"); return true; });
  f.sources[0].onopen();
  await flush();
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0], /尚未同步/);
  t.mock.timers.tick(2999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(700);
  assert.match(f.toasts[1], /任务状态已同步/);
  assert.equal(f.state.eventRecoveryPending, false);
});

test("multiple recovery triggers share a request and retries stop on logout", async (t) => {
  let calls = 0;
  const pending = deferred();
  const f = fixture(t, () => { calls += 1; return pending.promise; });
  f.sources[0].onopen();
  const a = f.manager.recover(), b = f.manager.recover();
  assert.equal(a, b);
  await flush();
  assert.equal(calls, 1);
  pending.resolve(false);
  await a;
  f.state.auth.authenticated = false;
  f.manager.stop();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.toasts.length, 0);
});

test("hidden pages defer synchronization until foreground recovery", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls += 1; return f.environment.document.visibilityState === "visible"; });
  f.environment.document.visibilityState = "hidden";
  f.sources[0].onopen();
  await flush();
  t.mock.timers.tick(30_000);
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.toasts.length, 0);
  f.environment.document.visibilityState = "visible";
  await f.manager.recover();
  t.mock.timers.tick(700);
  assert.equal(calls, 2);
  assert.match(f.toasts[0], /任务状态已同步/);
});

test("a stopped connection cannot report a late failure or start retrying", async (t) => {
  let reject;
  const pending = new Promise((resolve, fail) => { reject = fail; });
  const f = fixture(t, () => pending);
  f.sources[0].onopen();
  await flush();
  f.manager.stop();
  reject(new Error("late failure"));
  await flush();
  t.mock.timers.tick(60_000);
  assert.equal(f.toasts.length, 0);
  assert.equal(f.sources.length, 1);
});

test("a replay gap during synchronization requires a fresh read before success", async (t) => {
  let calls = 0;
  const first = deferred(), second = deferred();
  const f = fixture(t, () => (++calls === 1 ? first.promise : second.promise));
  f.sources[0].onopen();
  await flush();
  f.sources[0].onmessage({ data: JSON.stringify({ kind: "bridge/replayGap" }) });
  first.resolve(true);
  await flush();
  assert.equal(calls, 2);
  t.mock.timers.tick(700);
  assert.equal(f.toasts.length, 0);
  second.resolve(true);
  await flush();
  t.mock.timers.tick(700);
  assert.match(f.toasts[0], /超出回放窗口.*已重新同步/);
});

test("repeated failures back off to thirty seconds without repeating the error toast", async (t) => {
  let calls = 0;
  const f = fixture(t, async () => { calls += 1; throw new Error("still unavailable"); });
  f.sources[0].onopen();
  await flush();
  for (const delay of [3000, 6000, 12000, 24000, 30000, 30000]) {
    const before = calls;
    t.mock.timers.tick(delay - 1);
    await flush();
    assert.equal(calls, before);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, before + 1);
  }
  assert.equal(f.toasts.length, 1);
});
