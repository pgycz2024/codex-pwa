import { uiText } from "./ui-copy.js";
export function createPushNotificationController({ environment = globalThis, api, elements, pageNotifications, onToast = () => {} } = {}) {
  let state = { configured: false, subscribed: false, reason: uiText("push.createPushNotificationController.reason") };
  let busy = false;
  let refreshing = false;
  let progress = "";
  let registrationHintTimer;
  const supported = () => Boolean(environment.isSecureContext && environment.PushManager && environment.navigator?.serviceWorker && environment.Notification);
  const enabled = () => state.subscribed === true;

  function render() {
    const { notificationStatus, enablePushButton, disablePushButton, enablePageNotificationButton, notificationLabel, notificationButton } = elements;
    pageNotifications.sync(notificationButton, notificationLabel);
    if (enabled()) {
      notificationLabel.textContent = uiText("push.render.textContent6");
      notificationButton.title = uiText("push.render.title");
    }
    let status = progress || (refreshing ? uiText("push.createPushNotificationController.reason") : enabled()
      ? uiText("push.render.textContent5")
      : !supported() ? uiText("push.render.textContent4")
        : state.configured ? uiText("push.render.textContent3")
          : state.reason || uiText("push.render.textContent2"));
    if (!progress && !refreshing && enabled() && state.delivery?.ok === false) status += uiText("push.render.textContent");
    if (notificationStatus.textContent !== status) notificationStatus.textContent = status;
    enablePushButton.disabled = busy || refreshing || !supported() || !state.configured || enabled();
    disablePushButton.disabled = busy || refreshing || !enabled();
    enablePageNotificationButton.disabled = busy || refreshing || enabled();
    // A busy dialog ancestor would defer announcements from the live status
    // precisely while the user needs to hear the waiting feedback.
  }

  function setProgress(key) {
    clearTimeout(registrationHintTimer);
    registrationHintTimer = undefined;
    progress = key ? uiText(key) : "";
    render();
  }

  async function refresh() {
    if (busy || refreshing) return state;
    refreshing = true;
    render();
    try {
      state = await api("/api/push/status", { signal: AbortSignal.timeout(10_000) });
      if (state.subscribed && supported()) {
        const registration = await environment.navigator.serviceWorker.getRegistration();
        if (!await registration?.pushManager?.getSubscription()) {
          await api("/api/push/subscription", { method: "DELETE" });
          state.subscribed = false;
        }
      }
    } catch {
      state = { configured: false, subscribed: false, reason: uiText("push.refresh.reason") };
    } finally {
      refreshing = false;
      render();
    }
    return state;
  }

  async function registrationReady() {
    let timer;
    try {
      return await Promise.race([environment.navigator.serviceWorker.ready, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(uiText("push.registrationReady.reject"))), 10_000);
      })]);
    } finally { clearTimeout(timer); }
  }

  async function enable() {
    if (busy || refreshing || !supported() || !state.configured) return false;
    busy = true;
    setProgress("push.progress.permission");
    let created;
    try {
      // Request permission from the user's click, before waiting for network work.
      const permission = environment.Notification.permission === "granted" ? "granted" : await environment.Notification.requestPermission();
      if (permission !== "granted") throw new Error(uiText("push.enable.text2"));
      setProgress("push.progress.preparing");
      const registration = await registrationReady();
      const encoded = state.publicKey.replaceAll("-", "+").replaceAll("_", "/");
      const applicationServerKey = Uint8Array.from(environment.atob(encoded), (character) => character.charCodeAt(0));
      setProgress("push.progress.registering");
      // Native push registration cannot be cancelled. This is only a hint;
      // keep the operation pending and block duplicates until it settles.
      registrationHintTimer = setTimeout(() => {
        progress = uiText("push.progress.registrationSlow");
        render();
      }, 10_000);
      let subscription = await registration.pushManager.getSubscription();
      const previousKey = subscription?.options?.applicationServerKey;
      if (subscription && previousKey && String(new Uint8Array(previousKey)) !== String(applicationServerKey)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        created = subscription;
      }
      setProgress("push.progress.saving");
      state = await api("/api/push/subscription", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
      if (!state.subscribed) throw new Error(uiText("push.enable.text"));
      onToast(uiText("push.enable.onToast2"), 3600);
      return true;
    } catch (error) {
      setProgress("push.progress.cleaningUp");
      if (created) await created.unsubscribe().catch(() => {});
      state.subscribed = false;
      onToast(error.message || uiText("push.enable.onToast"), 5200);
      return false;
    } finally { busy = false; setProgress(null); }
  }

  async function disable() {
    if (busy || refreshing) return false;
    busy = true;
    setProgress("push.progress.disabling");
    try {
      await api("/api/push/subscription", { method: "DELETE" });
      state.subscribed = false;
      const registration = await environment.navigator.serviceWorker.getRegistration();
      await (await registration?.pushManager?.getSubscription())?.unsubscribe();
      onToast(uiText("push.disable.onToast2"), 3600);
      return true;
    } catch (error) {
      onToast(error.message || uiText("push.disable.onToast"), 5200);
      return false;
    } finally { busy = false; setProgress(null); }
  }

  function open() {
    elements.notificationDialog.showModal();
    render();
    void refresh();
  }
  elements.enablePushButton.addEventListener("click", enable);
  elements.disablePushButton.addEventListener("click", disable);
  elements.enablePageNotificationButton.addEventListener("click", async () => {
    await pageNotifications.enable(elements.notificationButton, elements.notificationLabel);
    render();
  });
  elements.closeNotificationButton.addEventListener("click", () => elements.notificationDialog.close());
  return { enabled, open, refresh, enable, disable };
}
