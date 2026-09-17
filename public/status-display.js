// Product-owned status wording. Protocol values remain separate from labels:
// an idle/unloaded thread is not evidence that its previous turn succeeded.
export const STATUS_LABELS = Object.freeze({
  active: "运行中", waiting: "等待操作", idle: "空闲", error: "异常",
  saved: "已保存，未加载", unknown: "状态待核实",
  completed: "已完成", failed: "失败", interrupted: "已停止", declined: "已拒绝",
});

export function threadStatusInfo(status) {
  const value = typeof status === "string" ? status : status?.type;
  let type = "unknown";
  if (["active", "inProgress", "running"].includes(value)) {
    const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
    type = flags.some((flag) => ["waitingOnApproval", "waitingOnUserInput"].includes(flag)) ? "waiting" : "active";
  } else if (value === "waiting") type = "waiting";
  else if (["systemError", "error", "failed"].includes(value)) type = "error";
  else if (["idle", "completed", "interrupted"].includes(value)) type = "idle";
  else if (value === "notLoaded") type = "saved";
  return { type, label: STATUS_LABELS[type] };
}

export function activityStatusLabel(status) {
  if (!status) return "";
  if (status === "inProgress") return STATUS_LABELS.active;
  return typeof status === "string" && Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : STATUS_LABELS.unknown;
}

const TURN_OUTCOMES = Object.freeze({
  completed: Object.freeze({ title: "Codex 任务已完成", body: "任务已完成，可以打开查看结果", announcement: "Codex 已回复，可在对话中查看结果" }),
  failed: Object.freeze({ title: "Codex 任务失败", body: "任务执行失败，请打开查看错误信息", announcement: "当前任务失败，请查看错误信息" }),
  interrupted: Object.freeze({ title: "Codex 任务已停止", body: "任务已停止，可以打开查看已有输出", announcement: "当前任务已停止" }),
});

export function turnOutcomeCopy(status) {
  return typeof status === "string" && Object.hasOwn(TURN_OUTCOMES, status) ? TURN_OUTCOMES[status] : null;
}

export const TASK_NOTICE_COPY = Object.freeze({
  waiting: Object.freeze({ title: "Codex 等待你的操作", body: "任务需要审批或回答，请打开查看" }),
  error: Object.freeze({ title: "Codex 任务出现异常", body: "任务状态异常，请打开查看错误信息" }),
  recovered: "连接恢复后已核实任务结果，可以打开查看",
});

export function snapshotRecoveryMessage(summary) {
  const parts = [];
  for (const [key, suffix] of [
    ["stillRunning", "仍在运行"], ["waiting", "等待操作"],
    ["inactive", "已空闲（结果请打开任务查看）"], ["errors", "出现异常"], ["unconfirmed", "状态待核实"],
  ]) {
    const count = summary[key]?.length || 0;
    if (count) parts.push(`${count} 个后台任务${suffix}`);
  }
  return parts.length ? `Web UI 已恢复连接；${parts.join("；")}` : "";
}
