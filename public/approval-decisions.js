import { uiText } from "./ui-copy.js";
export const APPROVAL_CHOICES = Object.freeze([
  [uiText("common.oneApproval"), "accept", "approve"], [uiText("common.sessionApproval"), "acceptForSession", "approve"],
  [uiText("common.decline"), "decline", "decline"], [uiText("common.declineAndStop"), "cancel", "decline"],
].map(Object.freeze));
const supported = new Set(APPROVAL_CHOICES.map((choice) => choice[1]));

export function approvalDecisionIds(approval) {
  const offered = approval?.method === "item/commandExecution/requestApproval" ? approval.params?.availableDecisions : null;
  if (offered == null) return [...supported];
  if (!Array.isArray(offered)) return [];
  return [...new Set(offered.filter((decision) => typeof decision === "string" && supported.has(decision)))];
}

export function approvalDecisionNotice(approval) {
  const offered = approval?.method === "item/commandExecution/requestApproval" ? approval.params?.availableDecisions : null;
  if (offered == null) return "";
  if (approvalDecisionIds(approval).length === 0) return uiText("decisions.approvalDecisionNotice.text2");
  if (offered.some((decision) => !supported.has(decision))) return uiText("decisions.approvalDecisionNotice.text");
  return "";
}
