export function approvalFileContextNotice(approval) {
  if (approval?.method !== "item/fileChange/requestApproval") return "";
  const context = approval.fileChangeContext;
  if (context?.status === "available") {
    const count = context.changes?.length || 0;
    return `已关联 ${context.totalFiles} 项文件变更`
      + (context.destructive ? "；包含删除操作" : "")
      + (context.truncated ? `；仅显示前 ${count} 项摘要，部分内容可能已截短` : "")
      + (context.incomplete ? "；文件信息不完整，请核对任务活动" : "");
  }
  if (approval.params?.changes || approval.params?.fileChanges) return "";
  return "尚未取得本次操作的文件明细，请在任务活动中核对后再确认";
}

export function approvalDetail(approval) {
  const params = approval?.params || {};
  const command = typeof params.command === "string" ? params.command : Array.isArray(params.command) ? params.command.join(" ") : null;
  const detail = [];
  if (params.additionalPermissions) detail.push(`请求额外权限：\n${JSON.stringify(params.additionalPermissions, null, 2)}`);
  if (params.networkApprovalContext) detail.push(`网络访问请求：\n${JSON.stringify(params.networkApprovalContext, null, 2)}`);
  if (command !== null) {
    return [...detail, command, params.reason || ""].filter(Boolean).join("\n\n");
  }
  const notice = approvalFileContextNotice(approval);
  if (notice) detail.push(notice);
  if (approval.fileChangeContext?.status === "available") {
    const labels = { add: "新增", delete: "删除", update: "修改", unknown: "未知变更" };
    detail.push(...approval.fileChangeContext.changes.map((change) =>
      `${labels[change.kind?.type] || labels.unknown}：${change.path || "路径未知"}`
      + (change.kind?.move_path ? ` → ${change.kind.move_path}` : "")));
  }
  if (params.reason) detail.push(String(params.reason));
  if (params.grantRoot) detail.push(`请求写入范围：${params.grantRoot}`);
  const changes = params.changes || params.fileChanges;
  if (changes) detail.push(JSON.stringify(changes, null, 2));
  return detail.length ? detail.join("\n\n") : JSON.stringify(params, null, 2);
}

export function approvalCommand(approval) {
  const params = approval?.params || {};
  if (typeof params.command === "string") return params.command;
  if (Array.isArray(params.command)) return params.command.join(" ");
  if (typeof params.cmd === "string") return params.cmd;
  return "";
}

function* approvalChanges(approval) {
  if (approval?.fileChangeContext?.status === "available") {
    yield* approval.fileChangeContext.changes;
    return;
  }
  const changes = approval?.params?.changes || approval?.params?.fileChanges;
  if (Array.isArray(changes)) yield* changes;
  else if (changes && typeof changes === "object" && approval?.method === "applyPatchApproval") {
    for (const [path, change] of Object.entries(changes)) {
      if (change && typeof change === "object") yield { ...change, path };
    }
  }
}

export function approvalFilePaths(approval) {
  const paths = new Set();
  for (const change of approvalChanges(approval)) {
    for (const path of [change?.path || change?.filePath || change?.filename || change?.file,
      change?.kind?.move_path || change?.move_path]) {
      if (typeof path === "string" && path.trim()) paths.add(path.trim());
      if (paths.size === 8) return [...paths];
    }
  }
  return [...paths];
}

export function approvalRisk(approval) {
  const command = approvalCommand(approval);
  if (/(?:rm\s+-rf|sudo\b|mkfs\b|dd\s+if=|chmod\s+777|chown\b|git\s+reset\s+--hard|\b(delete|drop)\b|\b(?:unlink|rmdir)\b|>>?)/i.test(command)) {
    return { level: "high", label: "高风险操作" };
  }
  if (approval?.fileChangeContext?.destructive === true) return { level: "high", label: "可能覆盖或删除" };
  for (const change of approvalChanges(approval)) {
    const description = [typeof change?.kind === "object" ? change.kind?.type : change?.kind,
      change?.status, change?.action, change?.operation, change?.type]
      .filter(Boolean).join(" ");
    if (/delete|remove|overwrite|truncate|replace|撤销|删除|覆盖|截断/i.test(description)) {
      return { level: "high", label: "可能覆盖或删除" };
    }
  }
  if (approval?.method?.includes("fileChange") || approval?.method === "applyPatchApproval") {
    const missingContext = approval.method === "item/fileChange/requestApproval"
      && approval.fileChangeContext?.status !== "available" && !approval.params?.changes && !approval.params?.fileChanges;
    if (missingContext || approval?.fileChangeContext?.incomplete) {
      return { level: "file", label: "文件影响未确认" };
    }
    return { level: "file", label: "将修改文件" };
  }
  return { level: "normal", label: "需要确认" };
}
