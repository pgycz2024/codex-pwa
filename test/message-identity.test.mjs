import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePendingUserMessage } from "../public/message-reconcile.js";

function fixture() {
  const node = { type: "user" };
  return { node, pendingMessages: [{ id: "local-1", clientId: "message-from-this-browser", threadId: "task", text: "继续" }],
    itemNodes: new Map([["local-1", node]]), itemTimings: new Map([["local-1", { local: true }]]),
    threadId: "task", itemId: "upstream-item", text: "继续" };
}

test("another client's identical message cannot confirm a local pending send", () => {
  const state = fixture();
  assert.equal(reconcilePendingUserMessage({ ...state, clientId: "message-from-another-browser" }), null);
  assert.equal(state.pendingMessages.length, 1);
  assert.equal(state.itemNodes.get("local-1"), state.node);
  assert.equal(state.itemTimings.has("upstream-item"), false);
});

test("an unattributed identical message cannot confirm a correlated pending send", () => {
  const state = fixture();
  assert.equal(reconcilePendingUserMessage(state), null);
  assert.equal(state.pendingMessages.length, 1);
});

test("the echoed message id confirms only its own task and preserves timing", () => {
  const state = fixture();
  assert.equal(reconcilePendingUserMessage({ ...state, threadId: "other-task", clientId: "message-from-this-browser" }), null);
  assert.equal(reconcilePendingUserMessage({ ...state, text: "canonical message text", clientId: "message-from-this-browser" }), state.node);
  assert.equal(state.pendingMessages.length, 0);
  assert.deepEqual(state.itemTimings.get("upstream-item"), { local: true });
});

test("legacy text matching is used only when neither side has a correlation id", () => {
  const state = fixture();
  delete state.pendingMessages[0].clientId;
  assert.equal(reconcilePendingUserMessage({ ...state, clientId: "external-correlated-message" }), null);
  assert.equal(reconcilePendingUserMessage(state), state.node);
});
