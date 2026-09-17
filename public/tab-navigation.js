/**
 * Apply the WAI-ARIA roving-tabindex keyboard pattern to a small tablist.
 * Activation remains owned by the caller so focus and data stay synchronized.
 */
export function wireTabKeyboard(tabs, activate) {
  const tabNodes = (tabs || []).filter(Boolean);
  tabNodes.forEach((tab, index) => {
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabNodes.length - 1
          : (index + direction + tabNodes.length) % tabNodes.length;
      const next = tabNodes[nextIndex];
      next.focus();
      activate(next);
    });
  });
}
