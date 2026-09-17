const modalOrders = new WeakMap();
let modalSequence = 0;
export function activeDialog(documentRef = document) {
  return [...(documentRef.querySelectorAll?.("dialog[open]") || [])]
    .sort((a, b) => (modalOrders.get(a) || 0) - (modalOrders.get(b) || 0)).at(-1) || null;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable=\"true\"]",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

function canFocus(node) {
  if (!node || node.hidden || node.getAttribute?.("aria-hidden") === "true") return false;
  if (node.disabled || node.closest?.('[inert], [aria-hidden="true"]')) return false;
  if (node.getClientRects && node.getClientRects().length === 0) return false;
  if (node.ownerDocument?.defaultView?.getComputedStyle(node).visibility === "hidden") return false;
  return true;
}

function firstFocusable(dialog) {
  const preferred = dialog.querySelector("[data-dialog-initial-focus], [autofocus]");
  if (canFocus(preferred)) return preferred;
  return focusableNodes(dialog)[0] || dialog;
}

function focusableNodes(container) {
  return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter((node) => node.tabIndex >= 0 && canFocus(node));
}

function focusWithoutScroll(node) {
  try {
    node.focus({ preventScroll: true });
  } catch {
    try { node.focus(); } catch {}
  }
}

/**
 * Keep keyboard focus inside native modal dialogs and return it to the trigger
 * when the dialog closes. Native dialog focus behavior differs across mobile
 * browsers, so this small manager supplements showModal() without replacing
 * the browser's Escape and backdrop handling.
 */
export function installDialogFocus(dialogs, { documentRef = globalThis.document, fallbackFocus = () => null } = {}) {
  const entries = new Map();
  for (const dialog of dialogs || []) {
    if (!dialog || typeof dialog.showModal !== "function" || typeof dialog.close !== "function") continue;
    const originalShowModal = dialog.showModal.bind(dialog);
    const originalClose = dialog.close.bind(dialog);

    const restore = () => {
      // A queued close event from an earlier opening must not consume the
      // return target or move focus after this dialog has already reopened.
      if (dialog.open) return;
      const entry = entries.get(dialog);
      if (!entry) return;
      entries.delete(dialog);
      const activeModal = activeDialog(documentRef);
      if (activeModal?.contains(documentRef.activeElement) && canFocus(documentRef.activeElement)) return;
      let target = entry.trigger;
      if (!target?.isConnected || !canFocus(target)) target = fallbackFocus();
      if (activeModal && !activeModal.contains(target)) target = firstFocusable(activeModal);
      if (target && target.isConnected !== false && canFocus(target)) focusWithoutScroll(target);
    };

    dialog.showModal = (...args) => {
      const wasOpen = dialog.open;
      if (!dialog.open) {
        const trigger = documentRef?.activeElement;
        entries.set(dialog, { trigger: trigger && !dialog.contains(trigger) ? trigger : null });
      }
      const result = originalShowModal(...args);
      if (!wasOpen) modalOrders.set(dialog, ++modalSequence);
      queueMicrotask(() => {
        if (dialog.open && (!documentRef.querySelectorAll || activeDialog(documentRef) === dialog)) focusWithoutScroll(firstFocusable(dialog));
      });
      return result;
    };
    dialog.close = (...args) => {
      const result = originalClose(...args);
      restore();
      return result;
    };
    dialog.addEventListener("close", restore);
  }
  return () => {
    for (const dialog of dialogs || []) entries.delete(dialog);
  };
}

export { FOCUSABLE_SELECTOR, canFocus, focusableNodes, focusWithoutScroll };
