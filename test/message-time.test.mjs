import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEpochSeconds, formatAbsolute, formatRelative } from "../public/time-display.js";
import { resolveMessageTiming, displayedMessageTime } from "../public/message-time.js";
import { reconcilePendingUserMessage } from "../public/message-reconcile.js";

const start = 1_789_473_600;
test("message time accepts epoch seconds, explicit milliseconds and timezone-bearing ISO strings", () => {
  assert.equal(normalizeEpochSeconds(start), start);
  assert.equal(normalizeEpochSeconds(start * 1000), start);
  assert.equal(normalizeEpochSeconds(new Date(start * 1000).toISOString()), start);
  assert.equal(normalizeEpochSeconds("2026-09-15T01:00:00+01:00"), Date.parse("2026-09-15T00:00:00Z") / 1000);
  for (const bad of [true, false, [], {}, -1, Infinity, "broken", "2026-09-15", "2026-02-30T00:00:00Z", "2026-09-15T01:00:00", 1e30]) {
    assert.equal(normalizeEpochSeconds(bad), 0);
    assert.equal(formatAbsolute(bad), "—");
    assert.equal(formatRelative(bad), "");
  }
});

test("message-level timestamps take precedence and preserve both reply start and completion", () => {
  const timing = resolveMessageTiming({ role: "assistant", item: {
    started_at: new Date(start * 1000).toISOString(), completedAtMs: (start + 30) * 1000,
  }, turn: { startedAt: start - 100, completedAt: start + 100 } });
  assert.equal(timing.startedAt.value, start);
  assert.equal(timing.completedAt.value, start + 30);
  assert.deepEqual(displayedMessageTime(timing, "assistant"), { timestamp: start + 30, source: "message", estimated: false });
});

test("a user echo without authoritative timing keeps the optimistic timestamp explicitly local", () => {
  const pending = resolveMessageTiming({ role: "user", pendingAt: start * 1000 });
  const echo = resolveMessageTiming({ role: "user", previous: pending, item: { id: "server-id" } });
  assert.deepEqual(displayedMessageTime(echo, "user"), { timestamp: start, source: "pending", estimated: true });
  const confirmed = resolveMessageTiming({ role: "user", previous: echo, item: { sentAt: start + 1 } });
  assert.deepEqual(displayedMessageTime(confirmed, "user"), { timestamp: start + 1, source: "message", estimated: false });
});

test("optimistic reconciliation transfers timing to the server id without leaking the local id", () => {
  const timing = resolveMessageTiming({ role: "user", pendingAt: start });
  const itemTimings = new Map([["local-id", timing]]);
  const node = { type: "user" };
  assert.equal(reconcilePendingUserMessage({
    pendingMessages: [{ id: "local-id", threadId: "task", text: "hello" }],
    itemNodes: new Map([["local-id", node]]), itemTimings, threadId: "task", itemId: "server-id", text: "hello",
  }), node);
  assert.equal(itemTimings.has("local-id"), false);
  assert.equal(displayedMessageTime(itemTimings.get("server-id"), "user").estimated, true);
});

test("replaying an event uses bridge receipt time and does not invent the current browser time", () => {
  const timing = resolveMessageTiming({ role: "assistant", phase: "started",
    observedAt: start, browserAt: (start + 900) * 1000,
  });
  const done = resolveMessageTiming({ role: "assistant", phase: "completed", previous: timing,
    observedAt: start + 30, browserAt: (start + 900) * 1000,
  });
  assert.equal(done.startedAt.value, start);
  assert.deepEqual(displayedMessageTime(done, "assistant"), { timestamp: start + 30, source: "bridge", estimated: true });
  const refreshed = resolveMessageTiming({ role: "assistant", previous: done, turn: { completedAt: start + 40 } });
  assert.equal(refreshed.completedAt.value, start + 30);
});

test("history fallbacks are labelled by turn and missing history never gets today's timestamp", () => {
  const user = resolveMessageTiming({ role: "user", turn: { startedAt: start, completedAt: start + 30 } });
  assert.deepEqual(displayedMessageTime(user, "user"), { timestamp: start, source: "turn-start", estimated: true });
  const reply = resolveMessageTiming({ role: "assistant", turn: { startedAt: start, completedAt: start + 30 } });
  assert.deepEqual(displayedMessageTime(reply, "assistant"), { timestamp: start + 30, source: "turn-end", estimated: true });
  assert.equal(displayedMessageTime(resolveMessageTiming({ role: "user" }), "user").timestamp, 0);
  const active = resolveMessageTiming({ role: "assistant", turn: { status: "inProgress", startedAt: start, updatedAt: start + 5 } });
  assert.equal(active.completedAt, undefined, "a running turn's update is not completion");
});

test("server emission time survives delayed delivery and replay without becoming a precise message timestamp", () => {
  const timing = resolveMessageTiming({ role: "assistant", phase: "started",
    emittedAtMs: start * 1000 + 123, observedAt: start + 60, browserAt: (start + 900) * 1000,
  });
  const done = resolveMessageTiming({ role: "assistant", phase: "completed", previous: timing,
    emittedAtMs: (start + 30) * 1000 + 456, observedAt: start + 80, browserAt: (start + 900) * 1000,
  });
  assert.equal(done.startedAt.value, start + 0.123);
  assert.deepEqual(displayedMessageTime(done, "assistant"), { timestamp: start + 30.456, source: "emitted", estimated: true });
  const replayed = resolveMessageTiming({ role: "assistant", phase: "completed", previous: done,
    emittedAtMs: (start + 30) * 1000 + 456, observedAt: start + 80, browserAt: (start + 1800) * 1000,
  });
  assert.deepEqual(replayed, done);
  const refreshed = resolveMessageTiming({ role: "assistant", previous: done,
    turn: { startedAt: start - 100, completedAt: start + 40 },
  });
  assert.deepEqual(refreshed, done);
});

test("explicit message and notification timestamps take precedence over envelope emission", () => {
  const envelope = resolveMessageTiming({ role: "assistant", phase: "completed", emittedAtMs: (start + 30) * 1000 });
  const params = resolveMessageTiming({ role: "assistant", phase: "completed", previous: envelope,
    emittedAtMs: (start + 30) * 1000, params: { completedAt: start + 20 },
  });
  assert.deepEqual(displayedMessageTime(params, "assistant"), { timestamp: start + 20, source: "notification", estimated: false });
  const item = resolveMessageTiming({ role: "assistant", phase: "completed", previous: params,
    item: { completedAt: start + 10 },
  });
  assert.deepEqual(displayedMessageTime(item, "assistant"), { timestamp: start + 10, source: "message", estimated: false });
});

test("late user completion and invalid emission times cannot replace valid send times", () => {
  const sent = resolveMessageTiming({ role: "user", phase: "started", emittedAtMs: start * 1000 });
  const completed = resolveMessageTiming({ role: "user", phase: "completed", previous: sent,
    emittedAtMs: (start + 600) * 1000, observedAt: start + 900,
  });
  assert.deepEqual(displayedMessageTime(completed, "user"), { timestamp: start, source: "emitted", estimated: true });
  const pending = resolveMessageTiming({ role: "user", pendingAt: start });
  assert.deepEqual(resolveMessageTiming({ role: "user", phase: "completed", previous: pending,
    emittedAtMs: (start + 600) * 1000, observedAt: start + 900,
  }), pending);
  for (const emittedAtMs of [undefined, null, true, {}, [], "invalid", String(start * 1000), -1, Infinity, 1e30]) {
    const fallback = resolveMessageTiming({ role: "assistant", phase: "completed", emittedAtMs, observedAt: start + 30 });
    assert.deepEqual(displayedMessageTime(fallback, "assistant"), { timestamp: start + 30, source: "bridge", estimated: true });
  }
});

test("late completion never moves a user's send time and malformed values do not mask valid fallbacks", () => {
  const sent = resolveMessageTiming({ role: "user", phase: "started", params: { timestamp: start } });
  const done = resolveMessageTiming({ role: "user", phase: "completed", previous: sent,
    params: { timestamp: start + 10 }, observedAt: start + 11,
  });
  assert.equal(done.sentAt.value, start);
  const nested = resolveMessageTiming({ role: "assistant", phase: "completed", params: { completedAt: "invalid" },
    item: { completedAt: new Date((start + 3) * 1000).toISOString() },
  });
  assert.equal(nested.completedAt.value, start + 3);
});
