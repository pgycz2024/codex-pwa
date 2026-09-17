import { uiText } from "./ui-copy.js";
export function createBrowserNotificationController({
  environment = globalThis,
  storage = null,
  storageKey = "codex-pwa-notification-times",
  getSelectedThreadId = () => null,
  isPushEnabled = () => false,
  onToast = () => {},
  onOpen = () => {},
  now = () => Date.now(),
  intervalMs = 30_000,
} = {}) {
  const lastAt = new Map();
  const pending = new Set();
  const validThreadId = (value) => typeof value === "string" && value.length > 0 && value.length <= 160;

  function prune() {
    const timestamp = now();
    const entries = [...lastAt.entries()]
      .filter(([threadId, value]) => validThreadId(threadId) && Number.isFinite(value)
        && value > 0 && value <= timestamp && timestamp - value < intervalMs * 20)
      .sort((left, right) => left[1] - right[1])
      .slice(-256);
    lastAt.clear();
    for (const [threadId, value] of entries) lastAt.set(threadId, value);
  }

  function loadLastAt() {
    try {
      const parsed = JSON.parse(storage?.getItem?.(storageKey) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [threadId, value] of Object.entries(parsed)) {
        const timestamp = Number(value);
        if (threadId && threadId.length <= 160 && Number.isFinite(timestamp) && timestamp > 0) {
          lastAt.set(threadId, timestamp);
        }
      }
    } catch {}
    prune();
  }

  function persistLastAt() {
    prune();
    if (!storage?.setItem) return;
    try {
      storage.setItem(storageKey, JSON.stringify(Object.fromEntries(lastAt)));
    } catch {}
  }

  loadLastAt();

  function available() {
    return Boolean(environment?.isSecureContext && environment?.Notification);
  }

  function sync(button, label) {
    if (!button || !label) return;
    if (!available()) {
      label.textContent = environment?.isSecureContext ? uiText("notifications.sync.textContent4") : uiText("notifications.sync.textContent3");
      button.title = environment?.isSecureContext
        ? uiText("notifications.enable.onToast6")
        : uiText("notifications.sync.title3");
      return;
    }
    const permission = environment.Notification.permission;
    label.textContent = permission === "granted" ? uiText("notifications.sync.textContent2") : permission === "denied" ? uiText("notifications.sync.textContent") : uiText("html.enablePageNotificationButton.text");
    button.title = permission === "denied"
      ? uiText("notifications.sync.title2")
      : uiText("notifications.sync.title");
  }

  async function enable(button, label) {
    if (!available()) {
      onToast(environment?.isSecureContext
        ? uiText("notifications.enable.onToast6")
        : uiText("notifications.enable.onToast5"), 5200);
      return false;
    }
    if (environment.Notification.permission === "denied") {
      onToast(uiText("notifications.enable.onToast4"), 5200);
      return false;
    }
    let permission;
    try {
      permission = environment.Notification.permission === "granted"
        ? "granted" : await environment.Notification.requestPermission();
    } catch {
      onToast(uiText("notifications.enable.onToast3"), 5200);
      return false;
    }
    sync(button, label);
    if (permission === "granted") onToast(uiText("notifications.enable.onToast2"), 5200);
    else if (permission !== "denied") onToast(uiText("notifications.enable.onToast"), 2600);
    return permission === "granted";
  }

  async function send({ threadId, title, body }) {
    if (isPushEnabled()) return false;
    const viewing = getSelectedThreadId() === threadId && environment.document?.visibilityState !== "hidden";
    if (!validThreadId(threadId) || viewing || !available() || environment.Notification.permission !== "granted") return false;
    prune();
    const timestamp = now();
    const previous = lastAt.get(threadId);
    if (previous !== undefined && timestamp - previous < intervalMs) return false;
    if (pending.has(threadId) || pending.size >= 256) return false;
    pending.add(threadId);
    try {
      const options = {
        body: String(body || "").slice(0, 240),
        tag: `codex-pwa-${threadId}`,
        data: { threadId },
      };
      let delivered = false;
      try {
        const registration = await environment.navigator?.serviceWorker?.getRegistration?.();
        if (registration?.active && typeof registration.showNotification === "function") {
          await registration.showNotification(title, options);
          delivered = true;
        }
      } catch {}
      if (!delivered) {
        const notification = new environment.Notification(title, options);
        notification.onclick = () => {
          environment.focus?.();
          notification.close?.();
          onOpen(threadId);
        };
      }
      lastAt.set(threadId, now());
      persistLastAt();
      return true;
    } catch {
      return false;
    } finally {
      pending.delete(threadId);
    }
  }

  return { available, sync, enable, send, lastAt };
}
