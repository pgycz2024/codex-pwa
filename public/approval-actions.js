import { uiText } from "./ui-copy.js";
import { approvalDecisionIds } from "./approval-decisions.js";

export function createApprovalActionsManager({
  state,
  writeRequests,
  requestConfirmation,
  confirmationPreview,
  approvalDetail,
  renderApprovals,
  markThreadWriteConflict,
  refreshSelectedThread,
  refreshApprovals = async () => {},
  showToast,
}) {
  const busy = new WeakMap();
  const submissionState = (approval) => busy.get(approval) || "";

  async function submit(requestId, approval, confirmation, path, body, label) {
    if (!approval || busy.has(approval)) return;
    busy.set(approval, "confirming");
    renderApprovals();
    try {
      const confirmed = await requestConfirmation(confirmation);
      if (!confirmed) return;
      if (state.approvals.get(requestId) !== approval) {
        showToast(uiText("approvals.submit.showToast"));
        return;
      }
      busy.set(approval, "submitting");
      renderApprovals();
      await writeRequests.request(approval.params?.threadId, path, {
        method: "POST", body: JSON.stringify({ ...body, requestToken: approval.requestToken }),
      }, label);
      if (state.approvals.get(requestId) === approval) {
        state.approvals.delete(requestId);
        state.approvalRevision += 1;
      }
    } catch (error) {
      const threadId = approval.params?.threadId;
      if (error.details?.code === "APPROVAL_REQUEST_CHANGED") await refreshApprovals().catch(() => {});
      if (markThreadWriteConflict(threadId, error) && state.selectedThread?.id === threadId) {
        refreshSelectedThread({ preserveScroll: true }).catch(() => {});
      }
      showToast(error.message);
    } finally {
      busy.delete(approval);
      renderApprovals();
    }
  }

  async function answerApproval(requestId, decision) {
    const approval = state.approvals.get(requestId);
    if (!approval || busy.has(approval)) return;
    if (!approvalDecisionIds(approval).includes(decision)) {
      showToast(uiText("approvals.answerApproval.showToast"));
      return;
    }
    const labels = { accept: uiText("common.oneApproval"), acceptForSession: uiText("common.sessionApproval"), decline: uiText("common.decline"), cancel: uiText("common.declineAndStop") };
    const label = labels[decision] || uiText("approvals.answerApproval.text");
    return submit(requestId, approval, {
      eyebrow: uiText("headings.approval_request"), title: uiText("approvals.answerApproval.title", label),
      message: uiText("approvals.answerApproval.message", confirmationPreview(approvalDetail(approval))),
      confirmLabel: uiText("approvals.answerApproval.confirmLabel", label),
      danger: decision === "accept" || decision === "acceptForSession" || decision === "cancel",
    }, `/api/approvals/${encodeURIComponent(requestId)}`, { decision }, uiText("approvals.answerApproval.submit"));
  }

  async function answerQuestion(event, requestId) {
    event.preventDefault();
    const approval = state.approvals.get(requestId);
    if (!approval || busy.has(approval)) return;
    const answers = Object.create(null);
    const answerLines = [];
    for (const field of event.currentTarget.querySelectorAll(".question-field")) {
      const selected = field.querySelector('input[type="radio"]:checked');
      const freeform = field.querySelector('[data-freeform="true"]');
      const value = freeform?.value.trim() || selected?.value || "";
      if (!value) { showToast(uiText("approvals.answerQuestion.showToast")); return; }
      answers[field.dataset.questionId] = { answers: [value] };
      answerLines.push(`${field.querySelector(":scope > span")?.textContent || field.dataset.questionId}：${value}`);
    }
    return submit(requestId, approval, {
      eyebrow: uiText("headings.submit_answers"), title: uiText("approvals.answerQuestion.title"),
      message: uiText("approvals.answerQuestion.message", confirmationPreview(answerLines.join("\n"))),
      confirmLabel: uiText("common.confirmSubmit"),
    }, `/api/requests/${encodeURIComponent(requestId)}/respond`, { answers }, uiText("headings.submit_answers"));
  }

  return { answerApproval, answerQuestion, submissionState };
}
