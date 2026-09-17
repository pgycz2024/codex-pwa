import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalActionsManager } from "../public/approval-actions.js";
import { approvalRequestId, sameApprovalRequest } from "../public/approval-state.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

function fixture(overrides = {}) {
  const approval = { requestId: "same", requestToken: "original", method: "item/commandExecution/requestApproval", params: { threadId: "task", command: "pwd" } };
  const state = { approvals: new Map([["same", approval]]), approvalRevision: 0 };
  const writes = [], confirmations = [];
  const confirmation = deferred(), result = deferred();
  const manager = createApprovalActionsManager({ state, elements: {},
    writeRequests: { request: (...args) => { writes.push(args); return result.promise; } },
    requestConfirmation: (copy) => { confirmations.push(copy); return confirmation.promise; },
    confirmationPreview: (text) => text, approvalDetail: () => "pwd",
    renderApprovals() {}, markThreadWriteConflict: () => false, refreshSelectedThread: async () => {}, showToast() {},
    ...overrides,
  });
  return { manager, state, approval, writes, confirmations, confirmation, result };
}

test("a decision omitted by Codex cannot open confirmation or submit through the action manager", async () => {
  const f = fixture();
  f.approval.params.availableDecisions = ["accept", "decline"];
  f.confirmation.resolve(true);
  f.result.resolve({ ok: true });
  await f.manager.answerApproval("same", "acceptForSession");
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.writes.length, 0);
});

test("repeated approval activation has one confirmation and one in-flight write", async () => {
  const f = fixture();
  const first = f.manager.answerApproval("same", "accept");
  const duplicate = f.manager.answerApproval("same", "accept");
  assert.equal(f.confirmations.length, 1);
  f.confirmation.resolve(true);
  await flush();
  await f.manager.answerApproval("same", "decline");
  assert.equal(f.writes.length, 1);
  f.result.resolve({ ok: true });
  await Promise.all([first, duplicate]);
});

test("an old confirmation never submits a replacement with the same request id", async () => {
  const f = fixture();
  const answer = f.manager.answerApproval("same", "accept");
  f.state.approvals.set("same", { ...f.approval, requestToken: "replacement" });
  f.confirmation.resolve(true);
  f.result.resolve({ ok: true });
  await answer;
  assert.equal(f.writes.length, 0);
  assert.equal(f.state.approvals.get("same").requestToken, "replacement");
});

test("a late successful write cannot delete a newer request", async () => {
  const f = fixture();
  const answer = f.manager.answerApproval("same", "accept");
  f.confirmation.resolve(true);
  await flush();
  f.state.approvals.set("same", { ...f.approval, requestToken: "replacement" });
  f.result.resolve({ ok: true });
  await answer;
  assert.equal(f.state.approvals.get("same")?.requestToken, "replacement");
});

const questionEvent = () => ({ preventDefault() {}, currentTarget: { querySelectorAll: () => [{
  dataset: { questionId: "destination" }, querySelector: (selector) => selector.includes("data-freeform")
    ? { value: "answer" } : selector === ":scope > span" ? { textContent: "Question" } : null,
}] } });

test("questions bind their answers to the reviewed request and suppress duplicate submits", async () => {
  const f = fixture();
  const pending = f.manager.answerQuestion(questionEvent(), "same");
  await f.manager.answerQuestion(questionEvent(), "same");
  assert.equal(f.confirmations.length, 1);
  f.confirmation.resolve(true);
  await flush();
  assert.equal(f.writes.length, 1);
  assert.deepEqual(JSON.parse(f.writes[0][2].body), { requestToken: "original", answers: { destination: { answers: ["answer"] } } });
  f.result.resolve({ ok: true });
  await pending;
  assert.equal(f.manager.submissionState(f.approval), "");
});

test("a replacement question cannot receive answers from an old confirmation", async () => {
  const f = fixture();
  const pending = f.manager.answerQuestion(questionEvent(), "same");
  f.state.approvals.set("same", { ...f.approval, requestToken: "next", params: { threadId: "other-task" } });
  f.confirmation.resolve(true);
  f.result.resolve({ ok: true });
  await pending;
  assert.equal(f.writes.length, 0);
});

test("cancelling confirmation releases its controls and sends nothing", async () => {
  const f = fixture();
  const pending = f.manager.answerQuestion(questionEvent(), "same");
  assert.equal(f.manager.submissionState(f.approval), "confirming");
  f.confirmation.resolve(false);
  await pending;
  assert.equal(f.manager.submissionState(f.approval), "");
  assert.equal(f.writes.length, 0);
});

test("request identity survives a status snapshot and recognizes numeric zero", () => {
  const f = fixture();
  assert.equal(approvalRequestId(0), "0");
  assert.equal(approvalRequestId(null), null);
  assert.equal(sameApprovalRequest(f.approval, JSON.parse(JSON.stringify(f.approval))), true);
  assert.equal(sameApprovalRequest(f.approval, { ...f.approval, requestToken: "next" }), false);
});
