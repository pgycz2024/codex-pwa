import { uiText } from "./ui-copy.js";
export function createAccessRootsManager({
  state,
  elements,
  api,
  el,
  basename,
  closeAllMenus,
  requestConfirmation,
  showToast,
  loadStatus,
}) {
  function renderAccessRoots() {
    elements.accessRootsList.replaceChildren();
    const groups = [
      [uiText("roots.renderAccessRoots.text2"), state.accessRoots.configured || [], false],
      [uiText("roots.renderAccessRoots.text"), state.accessRoots.additional || [], true],
    ];
    for (const [title, roots, removable] of groups) {
      if (!roots.length) continue;
      const section = el("section", "access-roots-section");
      section.append(el("h3", "", title));
      for (const root of roots) {
        const row = el("div", "access-root-row");
        const copy = el("div", "access-root-copy");
        copy.append(el("strong", "", root.name || basename(root.path)), el("code", "", root.path));
        row.append(copy);
        if (removable && root.removable !== false) {
          const remove = el("button", "danger-button", uiText("roots.renderAccessRoots.el"));
          remove.type = "button";
          remove.addEventListener("click", () => removeAccessRoot(root.path).catch((error) => showToast(error.message)));
          row.append(remove);
        }
        section.append(row);
      }
      elements.accessRootsList.append(section);
    }
    const count = (state.accessRoots.additional || []).length;
    elements.accessRootForm.querySelector("button[type=submit]").disabled = count >= (state.accessRoots.maxAdditionalRoots || 32);
  }

  async function loadAccessRoots() {
    state.accessRoots = await api("/api/access-roots");
    renderAccessRoots();
  }

  async function openAccessRoots() {
    closeAllMenus();
    if (!elements.accessRootsDialog.open) elements.accessRootsDialog.showModal();
    elements.accessRootPath.value = "";
    try {
      await loadAccessRoots();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function addAccessRoot(event) {
    event.preventDefault();
    const path = elements.accessRootPath.value.trim();
    if (!path) return;
    const confirmed = await requestConfirmation({
      eyebrow: uiText("headings.add_authorized_directory"),
      title: uiText("roots.addAccessRoot.title"),
      message: uiText("roots.addAccessRoot.message", path),
      confirmLabel: uiText("roots.addAccessRoot.confirmLabel"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      const result = await api("/api/access-roots", {
        method: "POST",
        headers: { "X-Codex-PWA-Root-Change": "1" },
        body: JSON.stringify({ path }),
      });
      elements.accessRootPath.value = "";
      await loadAccessRoots();
      await loadStatus();
      showToast(result.alreadyCovered ? uiText("roots.addAccessRoot.showToast3") : uiText("roots.addAccessRoot.showToast2"));
    } catch (error) {
      showToast(uiText("roots.addAccessRoot.showToast", error.message), 5200);
    }
  }

  async function removeAccessRoot(path) {
    const confirmed = await requestConfirmation({
      eyebrow: uiText("headings.remove_authorized_directory"),
      title: uiText("roots.removeAccessRoot.title"),
      message: uiText("roots.removeAccessRoot.message", path),
      confirmLabel: uiText("roots.removeAccessRoot.confirmLabel"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api("/api/access-roots", {
        method: "DELETE",
        headers: { "X-Codex-PWA-Root-Change": "1" },
        body: JSON.stringify({ path }),
      });
      await loadAccessRoots();
      await loadStatus();
      showToast(uiText("roots.removeAccessRoot.showToast2"));
    } catch (error) {
      showToast(uiText("roots.removeAccessRoot.showToast", error.message), 5200);
    }
  }

  return {
    renderAccessRoots,
    loadAccessRoots,
    openAccessRoots,
    addAccessRoot,
    removeAccessRoot,
  };
}
