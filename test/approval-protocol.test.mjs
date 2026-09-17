import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeProtocolMessage, normalizeProtocolSnapshot, approvalResponse } from "../protocol-adapter.mjs";
import { approvalDetail, approvalFilePaths, approvalRisk } from "../public/approval-policy.js";
import { approvalDecisionIds, approvalDecisionNotice } from "../public/approval-decisions.js";

for (const version of ["0.148.0", "0.153.2"]) test(`verified CLI ${version} contract retains PWA approval and diagnostic behavior`, async () => {
  const fixture = JSON.parse(await readFile(new URL(`./fixtures/protocol/${version}.json`, import.meta.url), "utf8"));
  assert.equal(fixture.version, version);
  assert.equal(fixture.runtime.cliVersion, version);
  assert.equal(fixture.runtime.bridge, "ready");
  assert.equal(fixture.runtime.protocolVersion, null, "CLI version is not an advertised protocol version");
  assert.deepEqual(fixture.runtime.advertisedCapabilities, {}, "neither sampled CLI declares initialize capabilities");
  assert.ok(fixture.approvals["CommandExecutionRequestApprovalParams.json"].fields.includes("availableDecisions"));
  for (const type of ["ExecCommandApprovalParams.json", "ApplyPatchApprovalParams.json"]) {
    assert.ok(fixture.approvals[type].required.includes("conversationId"));
    assert.equal(fixture.approvals[type].fields.includes("threadId"), false);
  }
  assert.equal(fixture.approvals["FileChangeRequestApprovalParams.json"].fields.includes("changes"), false);
  for (const method of ["item/fileChange/patchUpdated", "serverRequest/resolved", "thread/status/changed"]) assert.ok(fixture.notifications.includes(method));
  for (const alias of ["threadStarted", "turnStarted", "thread/statusChanged", "serverRequestResolved"]) assert.equal(fixture.notifications.includes(alias), false);
  assert.deepEqual(approvalResponse({ method: "item/commandExecution/requestApproval", params: { availableDecisions: ["decline", "cancel"] } }, "cancel"), { decision: "cancel" });
  if (version === "0.153.2") assert.ok(fixture.runtime.previousDatabaseFiles > 0, "newer CLI reused the isolated older-version state database");
});

test("execution approval details retain requested permission scope and reason alongside the command", () => {
  const approval = { method: "item/commandExecution/requestApproval", params: { command: "generate-report",
    reason: "Save the requested report", additionalPermissions: { fileSystem: { write: ["/srv/reports"] }, network: { enabled: true } },
    networkApprovalContext: { host: "example.com", protocol: "https" },
  } };
  const detail = approvalDetail(approval);
  assert.match(detail, /请求额外权限/);
  assert.match(detail, /\/srv\/reports/);
  assert.match(detail, /example\.com/);
  assert.match(detail, /generate-report/);
  assert.match(detail, /Save the requested report/);
  assert.match(approvalDetail({ ...approval, params: { ...approval.params, command: null } }), /请求额外权限：[\s\S]*example\.com/);
});

test("explicit decision lists preserve order and never turn unsupported choices into broader permission", () => {
  const request = (availableDecisions) => ({ method: "item/commandExecution/requestApproval", params: { availableDecisions } });
  for (const absent of [undefined, null]) assert.deepEqual(approvalDecisionIds(request(absent)), ["accept", "acceptForSession", "decline", "cancel"]);
  assert.deepEqual(approvalDecisionIds(request(["decline", "accept", "decline"])), ["decline", "accept"]);
  const rule = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } };
  assert.deepEqual(approvalDecisionIds(request([rule, "cancel"])), ["cancel"]);
  assert.match(approvalDecisionNotice(request([rule, "cancel"])), /部分审批选项/);
  for (const invalid of [[], [rule], ["futureDecision"], "accept", {}]) {
    const approval = request(invalid);
    assert.deepEqual(approvalDecisionIds(approval), []);
    assert.match(approvalDecisionNotice(approval), /没有可在本页提交/);
    assert.throws(() => approvalResponse(approval, "accept"), (error) => error.statusCode === 400 && error.details.dispatched === false);
  }
  assert.deepEqual(approvalResponse(request(["decline"]), "decline"), { decision: "decline" });
  assert.throws(() => approvalResponse(request(["decline"]), "acceptForSession"));
  assert.throws(() => approvalResponse(request([rule]), rule));
  assert.deepEqual(approvalResponse({ method: "execCommandApproval" }, "decline"), { decision: { denied: { rejection: "Declined from Codex PWA" } } });
});

test("diagnostics do not infer capabilities from substring matches or overrule an explicit declaration", () => {
  assert.deepEqual(normalizeProtocolSnapshot({ capabilities: { methods: ["goalDisabled", "serverRequestsUnavailable", "threadHistoryLegacyOnly"] } }).advertisedCapabilities, {});
  assert.deepEqual(normalizeProtocolSnapshot({ capabilities: { methods: ["goal"] },
    serverInfo: { capabilities: { goal: false } } }).advertisedCapabilities, { goal: false });
});

// Shapes verified against the types generated by codex-cli 0.153.2.
test("legacy approval conversationId becomes the shared task identity without changing RPC fields", () => {
  for (const method of ["execCommandApproval", "applyPatchApproval"]) {
    const original = { id: 0, method, params: { conversationId: "legacy-task", callId: "tool-call", reason: null } };
    const normalized = normalizeProtocolMessage(original);
    assert.equal(normalized.params.threadId, "legacy-task");
    assert.equal(normalized.id, 0);
    assert.equal(normalized.method, method);
    assert.equal(normalized.params.conversationId, "legacy-task");
    assert.equal(normalized.params.callId, "tool-call");
    assert.equal(original.params.threadId, undefined, "normalization must not mutate upstream input");
    assert.equal(normalizeProtocolMessage(normalized), normalized);
    const extraField = normalizeProtocolMessage({ ...original, params: { ...original.params, threadId: "unrelated-task" } });
    assert.equal(extraField.params.threadId, "legacy-task", "the declared legacy field is authoritative");
  }
  const future = { id: 1, method: "future/request", params: { conversationId: "not-a-known-contract" } };
  assert.equal(normalizeProtocolMessage(future), future);
});

test("legacy patch dictionaries show affected paths and destructive changes even when a reason exists", () => {
  const approval = { method: "applyPatchApproval", params: {
    conversationId: "task", callId: "patch", reason: "Apply the requested changes", grantRoot: null,
    fileChanges: {
      "/srv/project/add.txt": { type: "add", content: "new file" },
      "/srv/project/removed.txt": { type: "delete", content: "old file" },
      "/srv/project/source.txt": { type: "update", unified_diff: "-old\n+new", move_path: "/srv/project/moved.txt" },
    },
  } };
  assert.deepEqual(approvalFilePaths(approval), ["/srv/project/add.txt", "/srv/project/removed.txt", "/srv/project/source.txt", "/srv/project/moved.txt"]);
  assert.equal(approvalRisk(approval).level, "high");
  assert.match(approvalDetail(approval), /Apply the requested changes/);
  assert.match(approvalDetail(approval), /removed\.txt/);
  assert.match(approvalDetail(approval), /delete/);
});

test("structured file update kinds retain delete risk and both paths of a move", () => {
  const approval = { method: "item/fileChange/requestApproval", params: {
    changes: [{ path: "/srv/project/old.txt", kind: { type: "delete" }, diff: "-old" },
      { path: "/srv/project/before.txt", kind: { type: "update", move_path: "/srv/project/after.txt" }, diff: "" }],
  } };
  assert.equal(approvalRisk(approval).level, "high");
  assert.deepEqual(approvalFilePaths(approval), ["/srv/project/old.txt", "/srv/project/before.txt", "/srv/project/after.txt"]);
  const many = { method: "applyPatchApproval", params: { fileChanges: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [
    `/srv/project/file-${i}.txt`, { type: i === 11 ? "delete" : "add", content: "" },
  ])) } };
  assert.equal(approvalFilePaths(many).length, 8);
  assert.equal(approvalRisk(many).level, "high", "risk checks include changes beyond the visible path limit");
});
