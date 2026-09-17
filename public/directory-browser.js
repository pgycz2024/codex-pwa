import { uiText } from "./ui-copy.js";
export function createDirectoryBrowserManager({
  state,
  elements,
  stored,
  api,
  el,
  basename,
  pathWithinDirectory,
  closeAllMenus,
  requestConfirmation,
  showToast,
  showLoadingToast,
  finishLoadingToast,
  localStorage,
} = {}) {

  function renderDirectoryRoots() {
    elements.directoryRoots.replaceChildren();
    for (const root of state.directory.roots) {
      const button = el("button", "directory-root-button", root.name);
      button.type = "button";
      button.title = root.path;
      button.classList.toggle("active", pathWithinDirectory(state.directory.path, root.path));
      button.addEventListener("click", () => loadDirectory(root.path).catch((error) => showToast(error.message)));
      elements.directoryRoots.append(button);
    }
    elements.directoryRoots.classList.toggle("hidden", state.directory.roots.length < 2);
  }

  function renderDirectoryBreadcrumbs() {
    elements.directoryBreadcrumbs.replaceChildren();
    state.directory.breadcrumbs.forEach((crumb, index) => {
      if (index > 0) elements.directoryBreadcrumbs.append(el("span", "", "/"));
      const button = el("button", "", crumb.name);
      button.type = "button";
      button.title = crumb.path;
      button.disabled = crumb.path === state.directory.path;
      button.addEventListener("click", () => loadDirectory(crumb.path).catch((error) => showToast(error.message)));
      elements.directoryBreadcrumbs.append(button);
    });
    requestAnimationFrame(() => {
      elements.directoryBreadcrumbs.scrollLeft = elements.directoryBreadcrumbs.scrollWidth;
    });
  }

  function createDirectoryEntry({ name, path, sensitive = false }, { parent = false } = {}) {
    const button = el("button", "directory-entry");
    button.type = "button";
    button.title = path;
    if (sensitive) button.title = uiText("directory.createDirectoryEntry.title", path);
    button.append(
      el("span", "directory-entry-icon", parent ? "↰" : "▰"),
      el("span", "directory-entry-name", parent ? uiText("common.parentFolder") : name),
      ...(sensitive ? [el("span", "sensitive-entry-badge", uiText("directory.createDirectoryEntry.el"))] : []),
      el("span", "directory-entry-arrow", "›"),
    );
    button.addEventListener("click", () => loadDirectory(path).catch((error) => showToast(error.message)));
    return button;
  }

  function renderDirectoryList() {
    const query = elements.directorySearch.value.trim().toLocaleLowerCase("zh-CN");
    const entries = query
      ? state.directory.entries.filter((entry) => entry.name.toLocaleLowerCase("zh-CN").includes(query))
      : state.directory.entries;
    elements.directoryList.replaceChildren();

    if (!query && state.directory.parent) {
      elements.directoryList.append(createDirectoryEntry({
        name: uiText("common.parentFolder"),
        path: state.directory.parent,
      }, { parent: true }));
    }
    for (const entry of entries) elements.directoryList.append(createDirectoryEntry(entry));

    if (!elements.directoryList.children.length) {
      const empty = el("div", "directory-empty");
      empty.append(
        el("strong", "", query ? uiText("directory.renderDirectoryList.el4") : uiText("directory.renderDirectoryList.el3")),
        el("span", "", query ? uiText("directory.renderDirectoryList.el2") : uiText("directory.renderDirectoryList.el")),
      );
      elements.directoryList.append(empty);
    }
    elements.directoryLimitNotice.classList.toggle("hidden", !state.directory.truncated);
  }

  function setDirectoryLoading(loading) {
    state.directory.loading = loading;
    elements.chooseDirectoryButton.disabled = loading || !state.directory.path;
    elements.showNewDirectoryButton.disabled = loading || !state.directory.path;
    elements.directorySearch.disabled = loading;
    elements.showHiddenDirectories.disabled = loading;
    if (!loading) return;
    const loadingRow = el("div", "directory-empty");
    loadingRow.append(el("span", "spinner"), el("span", "", uiText("directory.loadDirectory.showLoadingToast")));
    elements.directoryList.replaceChildren(loadingRow);
    elements.directoryLimitNotice.classList.add("hidden");
  }

  async function loadDirectory(path, { preserveSearch = false } = {}) {
    const sequence = ++state.directory.loadSequence;
    closeAllMenus();
    setDirectoryLoading(true);
    const loadingToken = showLoadingToast(uiText("directory.loadDirectory.showLoadingToast"));
    if (!preserveSearch) elements.directorySearch.value = "";
    try {
      const params = new URLSearchParams({
        path,
        hidden: String(elements.showHiddenDirectories.checked),
        query: elements.directorySearch.value.trim(),
      });
      const result = await api(`/api/directories?${params}`);
      if (sequence !== state.directory.loadSequence) return;
      Object.assign(state.directory, {
        path: result.path,
        parent: result.parent || null,
        roots: result.roots || [],
        breadcrumbs: result.breadcrumbs || [],
        entries: result.entries || [],
        truncated: Boolean(result.truncated),
      });
      elements.directoryCurrentPath.textContent = result.path;
      elements.directoryCurrentPath.title = result.path;
      renderDirectoryRoots();
      renderDirectoryBreadcrumbs();
      renderDirectoryList();
    } catch (error) {
      if (sequence === state.directory.loadSequence) {
        const failed = el("div", "directory-empty");
        failed.append(el("strong", "", uiText("directory.loadDirectory.el")), el("span", "", error.message));
        elements.directoryList.replaceChildren(failed);
      }
      throw error;
    } finally {
      finishLoadingToast(loadingToken);
      if (sequence === state.directory.loadSequence) setDirectoryLoading(false);
    }
  }

  function closeDirectoryBrowser() {
    elements.newDirectoryForm.classList.add("hidden");
    elements.newDirectoryInput.value = "";
    if (state.directorySelectionResolver) {
      const resolveSelection = state.directorySelectionResolver;
      state.directorySelectionResolver = null;
      resolveSelection(null);
    }
    if (elements.directoryDialog.open) elements.directoryDialog.close();
  }

  async function openDirectoryBrowser() {
    if (state.directorySelectionResolver) {
      state.directorySelectionResolver(null);
      state.directorySelectionResolver = null;
    }
    const fallback = state.roots[0] || "";
    const requested = elements.cwdInput.value.trim() || stored.lastDirectory || fallback;
    elements.directoryDialogTitle.textContent = uiText("directory.openDirectoryBrowser.textContent");
    closeAllMenus();
    elements.newDirectoryForm.classList.add("hidden");
    elements.newDirectoryInput.value = "";
    if (!elements.directoryDialog.open) elements.directoryDialog.showModal();
    try {
      await loadDirectory(requested);
    } catch (error) {
      if (requested === fallback) {
        showToast(error.message, 5200);
        return;
      }
      showToast(uiText("directory.openDirectoryBrowser.showToast"), 4200);
      await loadDirectory(fallback).catch((fallbackError) => showToast(fallbackError.message, 5200));
    }
  }

  function chooseCurrentDirectory() {
    if (!state.directory.path || state.directory.loading) return;
    if (state.directorySelectionResolver) {
      const resolveSelection = state.directorySelectionResolver;
      state.directorySelectionResolver = null;
      const selectedPath = state.directory.path;
      if (elements.directoryDialog.open) elements.directoryDialog.close();
      resolveSelection(selectedPath);
      return;
    }
    elements.cwdInput.value = state.directory.path;
    localStorage.setItem("codex-pwa-last-directory", state.directory.path);
    closeDirectoryBrowser();
    elements.cwdInput.focus();
  }

  async function selectServerDirectory(initialPath) {
    closeAllMenus();
    elements.directoryDialogTitle.textContent = uiText("directory.selectServerDirectory.textContent");
    elements.newDirectoryForm.classList.add("hidden");
    elements.newDirectoryInput.value = "";
    if (!elements.directoryDialog.open) elements.directoryDialog.showModal();
    const selection = new Promise((resolveSelection) => {
      state.directorySelectionResolver = resolveSelection;
    });
    const fallback = state.roots[0] || "";
    try {
      await loadDirectory(initialPath || fallback);
    } catch (error) {
      if (!fallback || initialPath === fallback) {
        showToast(error.message, 5200);
        closeDirectoryBrowser();
      } else {
        showToast(uiText("directory.selectServerDirectory.showToast"), 4200);
        await loadDirectory(fallback).catch((fallbackError) => {
          showToast(fallbackError.message, 5200);
          closeDirectoryBrowser();
        });
      }
    }
    return selection;
  }

  async function createNewDirectory(event) {
    event.preventDefault();
    if (!state.directory.path || state.directory.loading) return;
    const name = elements.newDirectoryInput.value.trim();
    if (!name) return;
    const confirmed = await requestConfirmation({
      eyebrow: uiText("headings.create_folder"),
      title: uiText("files.createFileBrowserFolder.title"),
      message: uiText("files.createFileBrowserFolder.message", state.directory.path, name),
      confirmLabel: uiText("common.confirmCreate"),
    });
    if (!confirmed) return;
    const submit = elements.newDirectoryForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = uiText("directory.createNewDirectory.textContent2");
    try {
      const result = await api("/api/directories", {
        method: "POST",
        headers: { "X-Codex-PWA-Directory": "1" },
        body: JSON.stringify({ parent: state.directory.path, name }),
      });
      elements.newDirectoryForm.classList.add("hidden");
      elements.newDirectoryInput.value = "";
      await loadDirectory(result.path);
      showToast(uiText("common.folderCreated"));
    } catch (error) {
      showToast(error.message, 5200);
    } finally {
      submit.disabled = false;
      submit.textContent = uiText("directory.createNewDirectory.textContent");
    }
  }

  return {
    renderDirectoryRoots,
    renderDirectoryBreadcrumbs,
    createDirectoryEntry,
    renderDirectoryList,
    setDirectoryLoading,
    loadDirectory,
    closeDirectoryBrowser,
    openDirectoryBrowser,
    chooseCurrentDirectory,
    selectServerDirectory,
    createNewDirectory,
  };
}
