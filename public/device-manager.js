import { uiText } from "./ui-copy.js";
export function deviceClientLabel(userAgent) {
  const value = String(userAgent || "");
  const platform = /android/i.test(value)
    ? "Android"
    : /iphone|ipad/i.test(value)
      ? "iOS / iPadOS"
      : /windows/i.test(value)
        ? "Windows"
        : /macintosh|mac os/i.test(value)
          ? "macOS"
          : uiText("devices.deviceClientLabel.text");
  const browser = /edg\//i.test(value)
    ? "Edge"
    : /chrome\//i.test(value)
      ? "Chrome"
      : /firefox\//i.test(value)
        ? "Firefox"
        : /safari\//i.test(value)
          ? "Safari"
          : "Web";
  return `${platform} · ${browser}`;
}

export function createDeviceManager({
  state,
  elements,
  api,
  el,
  closeAllMenus,
  closeSidebar,
  requestConfirmation,
  showToast,
  showLogin,
  showLoadingToast,
  finishLoadingToast,
  formatTimestampMs,
}) {
  function openDeviceRename(device) {
    state.deviceRenameTargetId = device.id;
    elements.deviceRenameInput.value = device.label || uiText("devices.renderDevices.message");
    elements.deviceRenameDialog.showModal();
    setTimeout(() => elements.deviceRenameInput.select(), 40);
  }

  function openCredentialsDialog() {
    closeAllMenus();
    elements.currentUsernameInput.value = state.auth.username || elements.loginUsername.value.trim() || "codex";
    elements.currentPasswordInput.value = "";
    elements.newUsernameInput.value = elements.currentUsernameInput.value;
    elements.newPasswordInput.value = "";
    elements.confirmNewPasswordInput.value = "";
    elements.credentialsError.textContent = "";
    elements.credentialsError.classList.add("hidden");
    elements.credentialsError.classList.remove("notice");
    if (elements.devicesDialog.open) elements.devicesDialog.close();
    elements.credentialsDialog.showModal();
    setTimeout(() => elements.currentPasswordInput.focus(), 40);
  }

  async function saveCredentials(event) {
    event.preventDefault();
    const newPassword = elements.newPasswordInput.value;
    if (!elements.newUsernameInput.value.trim() && !newPassword) {
      elements.credentialsError.textContent = uiText("devices.saveCredentials.textContent3");
      elements.credentialsError.classList.remove("hidden");
      elements.credentialsError.classList.remove("notice");
      elements.newUsernameInput.focus();
      return;
    }
    if (newPassword || elements.confirmNewPasswordInput.value) {
      if (newPassword !== elements.confirmNewPasswordInput.value) {
        elements.credentialsError.textContent = uiText("devices.saveCredentials.textContent2");
        elements.credentialsError.classList.remove("hidden");
        elements.credentialsError.classList.remove("notice");
        elements.confirmNewPasswordInput.select();
        return;
      }
    }
    elements.saveCredentialsButton.disabled = true;
    elements.saveCredentialsButton.textContent = uiText("common.saving");
    elements.credentialsError.classList.add("hidden");
    try {
      const result = await api("/api/auth/credentials/change", {
        method: "POST",
        body: JSON.stringify({
          currentUsername: elements.currentUsernameInput.value.trim(),
          currentPassword: elements.currentPasswordInput.value,
          newUsername: elements.newUsernameInput.value.trim(),
          newPassword,
        }),
      });
      elements.loginUsername.value = result.username || elements.newUsernameInput.value.trim();
      elements.credentialsDialog.close();
      showLogin(uiText("devices.saveCredentials.showLogin"));
    } catch (error) {
      elements.credentialsError.textContent = error.message;
      elements.credentialsError.classList.remove("hidden");
      elements.credentialsError.classList.remove("notice");
      elements.currentPasswordInput.select();
    } finally {
      elements.saveCredentialsButton.disabled = false;
      elements.saveCredentialsButton.textContent = uiText("devices.saveCredentials.textContent");
    }
  }

  function renderDevices() {
    elements.devicesList.replaceChildren();
    elements.logoutOtherDevicesButton.disabled = !state.devices.some((device) => !device.current);
    if (!state.devices.length) {
      const empty = el("div", "directory-empty");
      empty.append(el("strong", "", uiText("devices.renderDevices.el6")), el("span", "", uiText("devices.renderDevices.el5")));
      elements.devicesList.append(empty);
      return;
    }
    for (const device of state.devices) {
      const card = el("article", `device-card${device.current ? " current" : ""}`);
      card.append(el("span", "device-icon", /android|iphone|ipad/i.test(device.userAgent || "") ? "▯" : "▰"));
      const copy = el("div", "device-copy");
      const title = el("div", "device-title");
      title.append(el("strong", "", device.label || uiText("devices.renderDevices.message")));
      if (device.current) title.append(el("span", "device-badge", uiText("devices.renderDevices.el4")));
      if (device.online) title.append(el("span", "device-badge", uiText("devices.renderDevices.el3")));
      copy.append(
        title,
        el("span", "device-meta", deviceClientLabel(device.userAgent)),
        el("span", "device-meta", uiText("devices.renderDevices.el2", formatTimestampMs(device.lastUsedAt), formatTimestampMs(device.expiresAt))),
      );
      const actions = el("div", "device-actions");
      const rename = el("button", "", uiText("common.rename"));
      rename.type = "button";
      rename.addEventListener("click", () => openDeviceRename(device));
      const revoke = el("button", "danger", device.current ? uiText("common.logoutThis") : uiText("devices.renderDevices.el"));
      revoke.type = "button";
      revoke.addEventListener("click", async () => {
        const confirmed = await requestConfirmation({
          eyebrow: device.current ? uiText("common.logout") : uiText("headings.revoke_device"),
          title: device.current ? uiText("devices.renderDevices.title2") : uiText("devices.renderDevices.title"),
          message: device.current
            ? uiText("devices.renderDevices.message3")
            : uiText("devices.renderDevices.message2", device.label || uiText("devices.renderDevices.message")),
          confirmLabel: device.current ? uiText("common.logoutThis") : uiText("devices.renderDevices.confirmLabel"),
          danger: true,
        });
        if (!confirmed) return;
        try {
          const result = await api(`/api/auth/devices/${encodeURIComponent(device.id)}`, { method: "DELETE", body: "{}" });
          if (result.current) {
            if (elements.deviceRenameDialog.open) elements.deviceRenameDialog.close();
            if (elements.devicesDialog.open) elements.devicesDialog.close();
            showLogin(uiText("devices.renderDevices.showLogin"));
            return;
          }
          await loadDevices();
          showToast(uiText("devices.renderDevices.showToast"));
        } catch (error) {
          showToast(error.message, 5200);
        }
      });
      actions.append(rename, revoke);
      card.append(copy, actions);
      elements.devicesList.append(card);
    }
  }

  async function loadDevices() {
    const loadingToken = showLoadingToast(uiText("devices.loadDevices.showLoadingToast"));
    try {
      const result = await api("/api/auth/devices");
      state.devices = result.devices || [];
      renderDevices();
    } finally {
      finishLoadingToast(loadingToken);
    }
  }

  async function openDevices() {
    closeAllMenus();
    if (!elements.devicesDialog.open) elements.devicesDialog.showModal();
    closeSidebar();
    elements.devicesList.replaceChildren(el("div", "directory-empty", uiText("devices.openDevices.el")));
    try {
      await loadDevices();
    } catch (error) {
      showToast(error.message, 5200);
    }
  }

  async function renameDevice(event) {
    event.preventDefault();
    const id = state.deviceRenameTargetId;
    if (!id) return;
    try {
      await api(`/api/auth/devices/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ label: elements.deviceRenameInput.value.trim() }),
      });
      elements.deviceRenameDialog.close();
      await loadDevices();
      showToast(uiText("devices.renameDevice.showToast"));
    } catch (error) {
      showToast(error.message, 5200);
    }
  }

  async function logoutOtherDevices() {
    const confirmed = await requestConfirmation({
      eyebrow: uiText("common.logoutOther"),
      title: uiText("devices.logoutOtherDevices.title"),
      message: uiText("devices.logoutOtherDevices.message"),
      confirmLabel: uiText("devices.logoutOtherDevices.confirmLabel"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await api("/api/auth/logout-others", { method: "POST", body: "{}" });
      await loadDevices();
      showToast(uiText("devices.logoutOtherDevices.showToast", result.revoked || 0));
    } catch (error) {
      showToast(error.message, 5200);
    }
  }

  return {
    openDeviceRename,
    openCredentialsDialog,
    saveCredentials,
    renderDevices,
    loadDevices,
    openDevices,
    renameDevice,
    logoutOtherDevices,
  };
}
