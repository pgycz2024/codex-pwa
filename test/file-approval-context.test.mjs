import test from "node:test";
import assert from "node:assert/strict";
import { FileApprovalContexts, fileApprovalKey } from "../file-approval-context.mjs";
import { approvalDetail, approvalFilePaths, approvalRisk } from "../public/approval-policy.js";
import { sameApprovalRequest } from "../public/approval-state.js";

const identity = { threadId: "task", turnId: "turn", itemId: "patch" };
const notification = (changes, ids = identity) => ({ method: "item/started", params: { ...ids,
  item: { type: "fileChange", id: ids.itemId, changes, status: "inProgress" } } });
const change = (type, path = "/srv/project/file.txt") => ({ path, kind: { type }, diff: "PRIVATE PATCH CONTENT" });

test("file context uses all three ids, expires and clears at task lifecycle boundaries", () => {
  let now = 1000;
  const cache = new FileApprovalContexts({ now: () => now, maxEntries: 2, ttlMs: 100 });
  cache.observe(notification([change("delete")]));
  assert.equal(cache.get(identity).status, "available");
  for (const field of ["threadId", "turnId", "itemId"]) assert.equal(cache.get({ ...identity, [field]: "other" }).status, "unavailable");
  assert.notEqual(fileApprovalKey({ threadId: "a:b", turnId: "c", itemId: "d" }), fileApprovalKey({ threadId: "a", turnId: "b:c", itemId: "d" }));
  now += 101;
  assert.equal(cache.get(identity).status, "unavailable");
  for (const id of ["first", "second", "third"]) cache.observe(notification([change("add")], { ...identity, itemId: id }));
  assert.equal(cache.entries.size, 2);
  assert.equal(cache.get({ ...identity, itemId: "first" }).status, "unavailable");
  cache.observe({ method: "turn/completed", params: { threadId: "task", turn: { id: "different" } } });
  assert.equal(cache.entries.size, 2);
  cache.observe({ method: "turn/completed", params: { threadId: "task", turn: { id: "turn" } } });
  assert.equal(cache.entries.size, 0);
  for (const method of ["thread/closed", "thread/deleted"]) {
    cache.observe(notification([change("delete")]));
    cache.observe({ method, params: { threadId: "task" } });
    assert.equal(cache.get(identity).status, "unavailable");
  }
  cache.observe(notification([change("delete")]));
  cache.clear();
  assert.equal(cache.get(identity).status, "unavailable");
});

test("patchUpdated carries complete context and patch text changes invalidate its fingerprint", () => {
  const cache = new FileApprovalContexts();
  const patch = { method: "item/fileChange/patchUpdated", params: { ...identity, changes: [change("update")] } };
  cache.observe(patch);
  const first = cache.get(identity);
  assert.equal(first.status, "available");
  patch.params.changes[0].diff = "A REVISED PATCH";
  cache.observe(patch);
  assert.notEqual(cache.get(identity).fingerprint, first.fingerprint);
  assert.deepEqual(cache.get(identity).changes, first.changes);
  assert.doesNotMatch(JSON.stringify(cache.get(identity)), /PRIVATE PATCH|REVISED PATCH/);
});

test("bounded file context retains destructive risk outside the displayed summary", () => {
  const cache = new FileApprovalContexts();
  cache.observe(notification(Array.from({ length: 40 }, (_, index) => change(index === 39 ? "delete" : "add", `/srv/project/${index}.txt`))));
  const context = cache.get(identity);
  assert.equal(context.changes.length, 32);
  assert.equal(context.totalFiles, 40);
  assert.equal(context.truncated, true);
  assert.equal(context.destructive, true);
  const approval = { method: "item/fileChange/requestApproval", params: { ...identity, reason: "Proposed change" }, fileChangeContext: context };
  assert.equal(approvalRisk(approval).level, "high");
  assert.equal(approvalFilePaths(approval).length, 8);
  assert.match(approvalDetail(approval), /40/);
  assert.match(approvalDetail(approval), /包含删除操作/);
  assert.match(approvalDetail(approval), /仅显示/);
  assert.match(approvalDetail(approval), /0\.txt/);
  assert.doesNotMatch(approvalDetail(approval), /PRIVATE PATCH CONTENT/);
});

test("unavailable and incomplete context remains explicit, and snapshot equality includes the context", () => {
  const cache = new FileApprovalContexts();
  const approval = { method: "item/fileChange/requestApproval", requestToken: "token", params: identity,
    fileChangeContext: cache.get(identity) };
  assert.match(approvalDetail(approval), /尚未取得/);
  assert.match(approvalRisk(approval).label, /未确认/);
  cache.observe(notification([change("future-kind", "/srv/" + "x".repeat(2000))]));
  const context = cache.get(identity);
  assert.equal(context.incomplete, true);
  assert.equal(context.truncated, true);
  assert.ok(context.changes[0].path.length <= 1025);
  const updated = { ...approval, fileChangeContext: context };
  assert.match(approvalDetail(updated), /不完整/);
  assert.equal(sameApprovalRequest(approval, updated), false);
  assert.equal(sameApprovalRequest(updated, JSON.parse(JSON.stringify(updated))), true);
  cache.observe(notification(undefined));
  assert.equal(cache.get(identity).status, "unavailable");
});
