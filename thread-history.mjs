const NARRATIVE_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "contextCompaction",
  "ContextCompaction",
  "historyNotice",
]);

export function narrativeHistoryTurn(turn = {}) {
  const items = Array.isArray(turn.items) ? turn.items : [];
  const retained = [];
  let omittedActivityCount = 0;
  for (const item of items) {
    if (!NARRATIVE_ITEM_TYPES.has(item?.type)) {
      omittedActivityCount += 1;
      continue;
    }
    const previous = retained.at(-1);
    if (item.type === "reasoning" && previous?.type === "reasoning") {
      previous.summary = [...(previous.summary || []), ...(item.summary || [])];
      previous.content = [...(previous.content || []), ...(item.content || [])];
      previous.status = item.status || previous.status;
      previous.mergedReasoningItems = Number(previous.mergedReasoningItems || 1) + 1;
    } else {
      retained.push(item.type === "reasoning"
        ? { ...item, summary: [...(item.summary || [])], content: [...(item.content || [])] }
        : item);
    }
  }
  if (omittedActivityCount) {
    retained.push({
      id: `${turn.id || "turn"}-narrative-notice`,
      type: "historyNotice",
      text: `已恢复本轮完整文字记录；${omittedActivityCount.toLocaleString("zh-CN")} 条命令、文件或工具活动仍按需在“最近活动详情”中加载。`,
    });
  }
  return { ...turn, items: retained, omittedActivityCount };
}

export function narrativeHistoryPage(page = {}) {
  return {
    ...page,
    data: (page.data || []).map(narrativeHistoryTurn),
  };
}

export function inferClientOrigin(thread = {}, originator = "") {
  const normalizedOriginator = String(originator || "").toLowerCase();
  const threadSource = String(thread.threadSource || "").toLowerCase();
  if (thread.parentThreadId || (typeof thread.source === "object" && thread.source?.subAgent)) return "subagent";
  if (threadSource === "codex-pwa-mobile" || normalizedOriginator === "codex_pwa") return "mobile-web";
  if (normalizedOriginator.includes("codex desktop")) return "windows";
  if (normalizedOriginator.includes("codex-tui") || normalizedOriginator.includes("codex cli")) return "cli";
  if (thread.source === "cli") return "cli";
  if (thread.source === "exec") return "exec";
  if (thread.source === "appServer") return "app-server";
  if (thread.source === "vscode") return "local-client";
  return "unknown";
}
