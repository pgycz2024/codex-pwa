import { canFocus, focusableNodes, focusWithoutScroll } from "./dialog-focus.js";

// The desktop sidebar is a landmark; on narrow screens it is a modal drawer.
// CSS translation alone must never leave hidden controls in the focus/AX tree.
export function createNavigationPanels({ sidebar, contextPanel, sidebarTrigger, contextTrigger, backdrop, scope,
  documentRef = document, media = matchMedia("(max-width: 760px)") }) {
  const panels = [sidebar, contextPanel];
  const returns = new Map();
  const locked = new Map();
  let modal = null;

  function sync() {
    for (const [node, inert] of locked) node.inert = inert;
    locked.clear();
    modal = media.matches ? panels.find((panel) => panel.classList.contains("open")) || null : null;
    for (const panel of panels) {
      const visible = panel === sidebar && !media.matches || panel.classList.contains("open");
      panel.inert = !visible;
      panel.setAttribute("aria-hidden", String(!visible));
      if (panel === modal) {
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
      } else {
        panel.removeAttribute("role");
        panel.removeAttribute("aria-modal");
      }
    }
    if (modal) {
      for (let branch = modal; branch && branch !== scope; branch = branch.parentElement) {
        for (const sibling of branch.parentElement?.children || []) {
          if (sibling === branch || sibling === backdrop) continue;
          locked.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
    }
    backdrop.classList.toggle("hidden", modal !== sidebar);
    sidebarTrigger.setAttribute("aria-expanded", String(modal === sidebar));
    contextTrigger.setAttribute("aria-expanded", String(contextPanel.classList.contains("open")));
  }

  function set(panel, open) {
    const wasOpen = panel.classList.contains("open");
    const trigger = panel === sidebar ? sidebarTrigger : contextTrigger;
    if (open && !wasOpen) {
      const active = documentRef.activeElement;
      returns.set(panel, active && active !== documentRef.body && !panel.contains(active) ? active : trigger);
      if (media.matches) for (const other of panels) if (other !== panel) other.classList.remove("open");
    }
    const hadFocus = panel.contains(documentRef.activeElement) || documentRef.activeElement === documentRef.body;
    panel.classList.toggle("open", open);
    sync();
    if (open && !wasOpen) focusWithoutScroll(focusableNodes(panel)[0] || panel);
    else if (!open && wasOpen && hadFocus && !documentRef.querySelector("dialog[open]")) {
      const previous = returns.get(panel);
      focusWithoutScroll(canFocus(previous) ? previous : trigger);
    }
  }

  documentRef.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || !modal || documentRef.querySelector("dialog[open]")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      set(modal, false);
    } else if (event.key === "Tab") {
      const candidates = focusableNodes(modal);
      const first = candidates[0];
      const last = candidates.at(-1);
      const active = documentRef.activeElement;
      if (!modal.contains(active) || !first || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        focusWithoutScroll((event.shiftKey ? last : first) || modal);
      }
    }
  });
  media.addEventListener("change", () => {
    const active = documentRef.activeElement;
    sync();
    if (!canFocus(active)) focusWithoutScroll(focusableNodes(modal || sidebar)[0] || sidebarTrigger);
  });
  sync();
  return { sidebar: (open) => set(sidebar, open), context: (open) => set(contextPanel, open) };
}
