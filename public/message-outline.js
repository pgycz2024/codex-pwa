function createElement(tagName, className = "", text = "") {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

export function addMessageOutline(container, anchorPrefix) {
  if (!container || !anchorPrefix) return;
  const headings = [...container.querySelectorAll("h2, h3")].slice(0, 12);
  if (headings.length < 2) return;
  const prefix = String(anchorPrefix).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "message";
  const outline = createElement("details", "message-outline");
  const summary = createElement("summary", "message-outline-summary", "章节导航");
  summary.setAttribute("aria-label", "展开章节导航");
  const list = createElement("ol", "message-outline-list");
  headings.forEach((heading, index) => {
    const id = `${prefix}-section-${index + 1}`;
    heading.id = id;
    const item = createElement("li");
    const link = createElement("a", "message-outline-link", heading.textContent?.trim() || `第 ${index + 1} 节`);
    link.href = `#${id}`;
    link.addEventListener("click", () => { outline.open = false; });
    item.append(link);
    list.append(item);
  });
  outline.append(summary, list);
  container.prepend(outline);
}
