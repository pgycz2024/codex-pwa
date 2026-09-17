export const MAX_COLLAPSIBLE_REPLY_CHARS = 12_000;

export function longReplyPresentation(value, expanded = false) {
  const text = String(value || "");
  const collapsible = text.length > MAX_COLLAPSIBLE_REPLY_CHARS;
  const isExpanded = collapsible && Boolean(expanded);
  return {
    collapsible,
    expanded: isExpanded,
    buttonLabel: isExpanded ? "收起完整回复" : "展开完整回复",
  };
}
