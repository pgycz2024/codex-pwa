// Keep existing nodes connected, especially the branch containing keyboard
// focus. Reordering its siblings avoids blur even without Element.moveBefore.
export function reconcileChildren(parent, children) {
  const wanted = new Set(children);
  const active = parent.ownerDocument.activeElement;
  for (const child of [...parent.childNodes]) if (!wanted.has(child)) child.remove();
  const pivot = children.findIndex((child) => child.parentNode === parent && (child === active || child.contains(active)));
  const place = (nodes, before = null) => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (node.parentNode !== parent || node.nextSibling !== before) {
        if (parent.moveBefore && node.isConnected && parent.isConnected) parent.moveBefore(node, before);
        else parent.insertBefore(node, before);
      }
      before = node;
    }
  };
  if (pivot < 0) place(children);
  else {
    place(children.slice(pivot + 1));
    place(children.slice(0, pivot), children[pivot]);
  }
}

export function setText(node, text) {
  const next = String(text ?? "");
  if (node.textContent !== next) node.textContent = next;
}

export function captureReadingAnchor(container, nodes) {
  const box = container.getBoundingClientRect();
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > box.top + 1 && rect.top < box.bottom;
  };
  const active = container.ownerDocument.activeElement;
  const anchor = nodes.find((node) => node.contains(active) && visible(node)) || nodes.find(visible);
  return anchor ? { node: anchor, offset: anchor.getBoundingClientRect().top - box.top } : null;
}

export function restoreReadingAnchor(container, anchor) {
  if (!anchor?.node.isConnected || !container.contains(anchor.node)) return;
  const top = container.scrollTop + anchor.node.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset;
  // Compensation must be immediate even when the conversation uses smooth
  // scrolling for explicit navigation. Animating it would move the reading row.
  container.scrollTo({ top, behavior: "instant" });
}
