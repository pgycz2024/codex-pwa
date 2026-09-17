import { uiText } from "./ui-copy.js";
export function createFileBrowserManager({
  state,
  elements,
  api,
  el,
  basename,
  pathWithinDirectory,
  closeAllMenus,
  closeSidebar,
  openFloatingMenu,
  requestConfirmation,
  confirmationPreview,
  copyText,
  filePreviewHref,
  formatTimestampMs,
  formatUploadSize,
  showToast,
  showLoadingToast,
  finishLoadingToast,
  selectServerDirectory,
  localStorage,
  maxUploadFileSize,
  maxUploadBatchSize,
} = {}) {

  function renderFileBrowserRoots() {
    elements.fileBrowserRoots.replaceChildren();
    for (const root of state.fileBrowser.roots) {
      const button = el("button", "directory-root-button", root.name);
      button.type = "button";
      button.title = root.path;
      button.classList.toggle("active", pathWithinDirectory(state.fileBrowser.path, root.path));
      button.addEventListener("click", () => loadFileBrowser(root.path).catch((error) => showToast(error.message)));
      elements.fileBrowserRoots.append(button);
    }
    elements.fileBrowserRoots.classList.toggle("hidden", state.fileBrowser.roots.length < 2);
  }

  function syncFileSelectionControls() {
    const count = state.fileBrowser.selectedPaths.size;
    elements.copySelectedFilesButton.disabled = state.fileBrowser.loading || count === 0;
    elements.moveSelectedFilesButton.disabled = state.fileBrowser.loading || count === 0;
    elements.deleteSelectedFilesButton.disabled = state.fileBrowser.loading || count === 0;
    elements.deleteSelectedFilesButton.textContent = count ? uiText("files.syncFileSelectionControls.textContent2", count) : uiText("files.syncFileSelectionControls.textContent");
  }

  function createFileBrowserEntry(entry, { parent = false } = {}) {
    const row = el("div", "file-entry");
    row.title = entry.path;
    if (entry.sensitive) row.title = uiText("files.createFileBrowserEntry.title", entry.path);
    const isDirectory = parent || entry.type === "directory";
    let select = null;
    if (!parent) {
      select = el("input", "file-entry-select");
      select.type = "checkbox";
      select.checked = state.fileBrowser.selectedPaths.has(entry.path);
      select.setAttribute("aria-label", uiText("files.createFileBrowserEntry.setAttribute2", entry.name));
      select.addEventListener("click", (event) => event.stopPropagation());
      select.addEventListener("change", () => {
        if (select.checked) state.fileBrowser.selectedPaths.add(entry.path);
        else state.fileBrowser.selectedPaths.delete(entry.path);
        syncFileSelectionControls();
      });
    }
    row.append(el("span", "file-entry-icon", parent ? "↰" : isDirectory ? "▰" : entry.previewKind === "image" ? "▧" : entry.previewKind === "pdf" ? "PDF" : "▤"));
    const copy = el("div", "file-entry-copy");
    copy.append(
      el("span", "file-entry-name", parent ? uiText("common.parentFolder") : entry.name),
      el("span", "file-entry-meta", isDirectory
        ? (parent ? entry.path : uiText("files.createFileBrowserEntry.el3", entry.relativePath ? `${entry.relativePath} · ` : "", entry.modifiedAt ? ` · ${formatTimestampMs(entry.modifiedAt)}` : "", entry.sensitive ? uiText("files.createFileBrowserEntry.el2") : ""))
        : `${entry.relativePath ? `${entry.relativePath} · ` : ""}${formatUploadSize(entry.size || 0)} · ${formatTimestampMs(entry.modifiedAt)}${entry.sensitive ? uiText("files.createFileBrowserEntry.el") : ""}`),
    );
    const actions = el("div", "file-entry-actions");
    const menuItems = [];
    const addMenuAction = (label, handler, { danger = false } = {}) => {
      menuItems.push({ label, handler, danger });
    };
    const addMenuLink = (label, href, { download = false, target = "" } = {}) => {
      menuItems.push({ label, href, download: download ? entry.name : "", target });
    };
    if (isDirectory) {
      const open = el("button", "", uiText("common.open"));
      open.type = "button";
      open.addEventListener("click", () => loadFileBrowser(entry.path).catch((error) => showToast(error.message)));
      addMenuAction(uiText("common.open"), () => open.click());
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.addEventListener("click", (event) => {
        if (!event.target.closest("details, button, a, input, label")) open.click();
      });
      row.addEventListener("keydown", (event) => {
        if (event.target === row && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          open.click();
        }
      });
    } else {
      const preview = el("a", "", uiText("common.preview"));
      preview.href = filePreviewHref(entry.path);
      preview.target = "_blank";
      preview.rel = "noopener noreferrer";
      const download = el("a", "", uiText("common.download"));
      download.href = `/api/files/raw?path=${encodeURIComponent(entry.path)}&download=1`;
      download.download = entry.name;
      preview.target = "_blank";
      preview.rel = "noopener noreferrer";
      addMenuLink(uiText("common.preview"), preview.href, { target: "_blank" });
      addMenuLink(uiText("common.download"), download.href, { download: true });
    }
    if (!parent) {
      addMenuAction(uiText("common.copyPath"), async () => {
        showToast(await copyText(entry.path) ? uiText("common.pathCopied") : uiText("common.pathCopyFailed"), 2600);
      });
      addMenuAction(uiText("common.rename"), () => operateFileBrowserEntry("rename", entry));
      addMenuAction(uiText("common.move"), () => operateFileBrowserEntry("move", entry));
      addMenuAction(uiText("common.copy"), () => operateFileBrowserEntry("copy", entry));
      addMenuAction(uiText("common.delete"), () => operateFileBrowserEntry("delete", entry), { danger: true });
      const menuButton = el("button", "file-entry-menu-button", "•••");
      menuButton.type = "button";
      menuButton.setAttribute("aria-label", uiText("files.createFileBrowserEntry.setAttribute", entry.name));
      menuButton.setAttribute("aria-haspopup", "menu");
      menuButton.setAttribute("aria-expanded", "false");
      menuButton.addEventListener("click", (event) => {
        event.stopPropagation();
        openFloatingMenu(menuButton, row, menuItems);
      });
      actions.append(menuButton);
    }
    if (select) {
      const selectTarget = el("label", "file-entry-select-target");
      selectTarget.append(select);
      row.prepend(selectTarget);
    } else row.prepend(el("span"));
    row.append(copy, actions);
    return row;
  }

  async function deleteSelectedFileBrowserEntries() {
    if (state.fileBrowser.loading) return;
    const selectedPaths = [...state.fileBrowser.selectedPaths];
    if (!selectedPaths.length) return;
    const selectedEntries = new Map(state.fileBrowser.entries.map((entry) => [entry.path, entry]));
    const names = selectedPaths.map((path) => selectedEntries.get(path)?.name || basename(path));
    const confirmed = await requestConfirmation({
      eyebrow: uiText("headings.delete_selected_files"),
      title: uiText("files.deleteSelectedFileBrowserEntries.title", selectedPaths.length),
      message: uiText("files.deleteSelectedFileBrowserEntries.message", confirmationPreview(names.join("\n"), 1_200)),
      confirmLabel: uiText("common.confirmDelete"),
      danger: true,
    });
    if (!confirmed) return;
    setFileBrowserLoading(true);
    try {
      const result = await api("/api/files/operations", {
        method: "POST",
        headers: { "X-Codex-PWA-File-Operation": "1" },
        body: JSON.stringify({ operation: "delete", paths: selectedPaths }),
      });
      state.fileBrowser.selectedPaths.clear();
      await loadFileBrowser(state.fileBrowser.path, { preserveSearch: true });
      if (result.failed?.length) {
        showToast(uiText("files.deleteSelectedFileBrowserEntries.showToast3", result.deleted?.length || 0, result.failed.length), 6200);
      } else {
        showToast(uiText("files.deleteSelectedFileBrowserEntries.showToast2", result.deleted?.length || selectedPaths.length));
      }
    } catch (error) {
      showToast(uiText("files.deleteSelectedFileBrowserEntries.showToast", error.message), 5200);
    } finally {
      setFileBrowserLoading(false);
      syncFileSelectionControls();
    }
  }

  async function operateSelectedFileBrowserEntries(operation) {
    if (state.fileBrowser.loading || !["copy", "move"].includes(operation)) return;
    const selectedPaths = [...state.fileBrowser.selectedPaths];
    if (!selectedPaths.length) return;
    const targetDirectory = await selectServerDirectory(state.fileBrowser.path);
    if (!targetDirectory) return;
    const names = selectedPaths.map((path) => basename(path));
    const confirmed = await requestConfirmation({
      eyebrow: operation === "move" ? uiText("headings.move_selected_files") : uiText("headings.copy_selected_files"),
      title: uiText("files.operateSelectedFileBrowserEntries.title", operation === "move" ? uiText("common.move") : uiText("common.copy"), selectedPaths.length),
      message: uiText("files.operateSelectedFileBrowserEntries.message", confirmationPreview(names.join("\n"), 1_200), targetDirectory),
      confirmLabel: operation === "move" ? uiText("common.confirmMove") : uiText("common.confirmCopy"),
    });
    if (!confirmed) return;
    setFileBrowserLoading(true);
    try {
      const result = await api("/api/files/operations", {
        method: "POST",
        headers: { "X-Codex-PWA-File-Operation": "1" },
        body: JSON.stringify({ operation, paths: selectedPaths, targetDirectory }),
      });
      state.fileBrowser.selectedPaths.clear();
      await loadFileBrowser(state.fileBrowser.path, { preserveSearch: true });
      if (result.failed?.length) {
        showToast(uiText("files.operateSelectedFileBrowserEntries.showToast3", operation === "move" ? uiText("common.move") : uiText("common.copy"), result.results?.length || 0, result.failed.length), 6200);
      } else {
        showToast(uiText("files.operateSelectedFileBrowserEntries.showToast2", operation === "move" ? uiText("common.move") : uiText("common.copy"), result.results?.length || selectedPaths.length));
      }
    } catch (error) {
      showToast(uiText("files.operateSelectedFileBrowserEntries.showToast", operation === "move" ? uiText("common.move") : uiText("common.copy"), error.message), 5200);
    } finally {
      setFileBrowserLoading(false);
      syncFileSelectionControls();
    }
  }

  async function operateFileBrowserEntry(operation, entry) {
    if (!entry?.path || state.fileBrowser.loading) return;
    let name = "";
    let targetDirectory = "";
    if (operation === "rename") {
      name = window.prompt(uiText("files.operateFileBrowserEntry.prompt"), entry.name || basename(entry.path));
      if (name === null) return;
      name = name.trim();
      if (!name) return;
      const confirmed = await requestConfirmation({
        eyebrow: uiText("common.rename"),
        title: uiText("files.operateFileBrowserEntry.title4"),
        message: uiText("files.operateFileBrowserEntry.message4", entry.path, name),
        confirmLabel: uiText("common.confirmRename"),
      });
      if (!confirmed) return;
    } else if (operation === "move" || operation === "copy") {
      targetDirectory = await selectServerDirectory(state.fileBrowser.path);
      if (!targetDirectory) return;
      const confirmed = await requestConfirmation({
        eyebrow: operation === "move" ? uiText("headings.move_file") : uiText("headings.copy_file"),
        title: operation === "move" ? uiText("files.operateFileBrowserEntry.title3") : uiText("files.operateFileBrowserEntry.title2"),
        message: uiText("files.operateFileBrowserEntry.message3", entry.path, targetDirectory),
        confirmLabel: operation === "move" ? uiText("common.confirmMove") : uiText("common.confirmCopy"),
      });
      if (!confirmed) return;
    } else if (operation === "delete") {
      const confirmed = await requestConfirmation({
        eyebrow: uiText("headings.delete_file"),
        title: uiText("files.operateFileBrowserEntry.title", entry.name || basename(entry.path)),
        message: entry.type === "directory"
          ? uiText("files.operateFileBrowserEntry.message2")
          : uiText("files.operateFileBrowserEntry.message", entry.path),
        confirmLabel: uiText("common.confirmDelete"),
        danger: true,
      });
      if (!confirmed) return;
    }
    setFileBrowserLoading(true);
    try {
      const result = await api("/api/files/operations", {
        method: "POST",
        headers: { "X-Codex-PWA-File-Operation": "1" },
        body: JSON.stringify({ operation, path: entry.path, name, targetDirectory }),
      });
      await loadFileBrowser(state.fileBrowser.path, { preserveSearch: true });
      if (result.cleanupPending) {
        showToast(uiText("files.operateFileBrowserEntry.showToast6", result.cleanupPending), 9000);
      } else {
        showToast(operation === "rename" ? uiText("files.operateFileBrowserEntry.showToast5") : operation === "move" ? uiText("files.operateFileBrowserEntry.showToast4") : operation === "copy" ? uiText("files.operateFileBrowserEntry.showToast3") : uiText("files.operateFileBrowserEntry.showToast2"));
      }
    } catch (error) {
      setFileBrowserLoading(false);
      renderFileBrowserList();
      showToast(uiText("files.operateFileBrowserEntry.showToast", error.message), 5200);
    }
  }

  async function createFileBrowserFolder() {
    if (!state.fileBrowser.path || state.fileBrowser.loading) return;
    const name = window.prompt(uiText("files.createFileBrowserFolder.prompt"), "new-folder");
    if (name === null || !name.trim()) return;
    const folderName = name.trim();
    const confirmed = await requestConfirmation({
      eyebrow: uiText("headings.create_folder"),
      title: uiText("files.createFileBrowserFolder.title"),
      message: uiText("files.createFileBrowserFolder.message", state.fileBrowser.path, folderName),
      confirmLabel: uiText("common.confirmCreate"),
    });
    if (!confirmed) return;
    try {
      await api("/api/directories", {
        method: "POST",
        headers: { "X-Codex-PWA-Directory": "1" },
        body: JSON.stringify({ parent: state.fileBrowser.path, name: folderName }),
      });
      await loadFileBrowser(state.fileBrowser.path, { preserveSearch: true });
      showToast(uiText("common.folderCreated"));
    } catch (error) {
      showToast(uiText("files.createFileBrowserFolder.showToast", error.message), 5200);
    }
  }

  async function uploadFilesToBrowserDirectory(selectedFiles) {
    const files = [...selectedFiles].filter((file) => file.size <= maxUploadFileSize);
    if (!files.length) {
      showToast(uiText("files.uploadFilesToBrowserDirectory.showToast2"), 5200);
      return;
    }
    if (state.uploadRequest) {
      showToast(uiText("common.uploadBusy"));
      return;
    }
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize > maxUploadBatchSize) {
      showToast(uiText("files.uploadFilesToBrowserDirectory.showToast"), 5200);
      return;
    }
    const confirmed = await requestConfirmation({
      eyebrow: uiText("headings.upload_files"),
      title: uiText("files.uploadFilesToBrowserDirectory.title"),
      message: uiText("files.uploadFilesToBrowserDirectory.message", state.fileBrowser.path, confirmationPreview(files.map((file) => file.name).join("\n"), 900)),
      confirmLabel: uiText("files.uploadFilesToBrowserDirectory.confirmLabel"),
    });
    if (!confirmed) return;
    startBrowserDirectoryUpload({ files, path: state.fileBrowser.path });
  }

  function syncBrowserUploadControls() {
    const active = state.uploadRequest && state.uploadContext === "browser";
    const paused = !active && state.uploadPaused && state.browserUploadSession;
    elements.uploadToDirectoryButton.disabled = false;
    elements.uploadToDirectoryButton.textContent = paused ? uiText("files.syncBrowserUploadControls.textContent5") : active ? uiText("files.syncBrowserUploadControls.textContent4") : uiText("files.syncBrowserUploadControls.textContent3");
    elements.uploadToDirectoryButton.classList.toggle("danger-button", Boolean(active || paused));
    elements.pauseFileBrowserUploadButton.classList.toggle("hidden", !active && !paused);
    elements.pauseFileBrowserUploadButton.textContent = paused ? uiText("files.syncBrowserUploadControls.textContent2") : uiText("files.syncBrowserUploadControls.textContent");
    elements.pauseFileBrowserUploadButton.disabled = false;
  }

  function clearBrowserUploadSession(message = uiText("common.uploadCancelled")) {
    state.uploadPaused = false;
    state.browserUploadSession = null;
    state.uploadRequest = null;
    state.uploadContext = null;
    state.uploadProgress = { loaded: 0, total: 0 };
    syncBrowserUploadControls();
    syncFileBrowserUploadProgress();
    if (message) showToast(message, 3600);
  }

  function pauseBrowserDirectoryUpload() {
    if (!state.browserUploadSession) return;
    if (state.uploadRequest && state.uploadContext === "browser") {
      state.uploadPaused = true;
      state.uploadRequest.abort();
      return;
    }
    state.uploadPaused = false;
    startBrowserDirectoryUpload(state.browserUploadSession);
  }

  function startBrowserDirectoryUpload(session) {
    const { files, path } = session;
    if (!files?.length || !path || state.uploadRequest) return;
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    state.browserUploadSession = session;
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name));
    const request = new XMLHttpRequest();
    state.uploadRequest = request;
    state.uploadContext = "browser";
    state.uploadPaused = false;
    state.uploadProgress = { loaded: 0, total: totalSize };
    syncBrowserUploadControls();
    syncFileBrowserUploadProgress();
    request.open("POST", `/api/files/upload?cwd=${encodeURIComponent(path)}`);
    request.setRequestHeader("X-Codex-PWA-Upload", "1");
    if (state.auth.csrfToken) request.setRequestHeader("X-Codex-PWA-CSRF", state.auth.csrfToken);
    const cleanup = ({ preserveSession = false } = {}) => {
      if (state.uploadRequest === request) {
        state.uploadRequest = null;
        state.uploadContext = null;
        state.uploadProgress = { loaded: 0, total: 0 };
      }
      if (!preserveSession) state.browserUploadSession = null;
      syncBrowserUploadControls();
      syncFileBrowserUploadProgress();
    };
    request.upload.addEventListener("progress", (event) => {
      state.uploadProgress = {
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : totalSize,
      };
      syncFileBrowserUploadProgress();
    });
    request.addEventListener("load", async () => {
      let payload = {};
      try { payload = JSON.parse(request.responseText || "{}"); } catch {}
      cleanup();
      if (request.status >= 200 && request.status < 300) {
        await loadFileBrowser(path, { preserveSearch: true }).catch(() => {});
        showToast(uiText("files.startBrowserDirectoryUpload.showToast3", payload.files?.length || files.length));
      } else showToast(payload.error || uiText("files.startBrowserDirectoryUpload.showToast2", request.status), 5200);
    });
    request.addEventListener("error", () => { cleanup(); showToast(uiText("common.uploadDisconnected"), 5200); });
    request.addEventListener("abort", () => {
      if (state.uploadPaused) {
        cleanup({ preserveSession: true });
        state.uploadProgress = { loaded: 0, total: totalSize };
        syncBrowserUploadControls();
        syncFileBrowserUploadProgress();
        showToast(uiText("files.startBrowserDirectoryUpload.showToast"), 4200);
      } else {
        cleanup();
        showToast(uiText("common.uploadCancelled"), 3600);
      }
    });
    request.send(form);
  }

  function syncFileBrowserUploadProgress() {
    const active = state.uploadRequest && state.uploadContext === "browser";
    const paused = !active && state.uploadPaused && state.browserUploadSession;
    const status = elements.fileBrowserUploadStatus;
    if (!active && !paused) {
      status.classList.add("hidden");
      status.textContent = "";
      status.removeAttribute("aria-valuenow");
      return;
    }
    const { loaded, total } = state.uploadProgress;
    const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    status.classList.remove("hidden");
    status.textContent = paused
      ? uiText("files.syncFileBrowserUploadProgress.textContent2", formatUploadSize(total))
      : total > 0
        ? uiText("files.syncFileBrowserUploadProgress.textContent", percent, formatUploadSize(loaded), formatUploadSize(total))
        : uiText("common.uploading");
    status.setAttribute("aria-valuenow", String(percent));
  }

  function renderFileBrowserList() {
    elements.fileBrowserList.replaceChildren();
    if (!state.fileBrowser.searchMode && !elements.fileBrowserSearch.value.trim() && state.fileBrowser.parent) {
      elements.fileBrowserList.append(createFileBrowserEntry({ path: state.fileBrowser.parent }, { parent: true }));
    }
    for (const entry of state.fileBrowser.entries) elements.fileBrowserList.append(createFileBrowserEntry(entry));
    if (!elements.fileBrowserList.children.length) {
      const empty = el("div", "directory-empty");
      empty.append(el("strong", "", uiText("files.renderFileBrowserList.el2")), el("span", "", uiText("files.renderFileBrowserList.el")));
      elements.fileBrowserList.append(empty);
    }
    elements.fileBrowserLimitNotice.textContent = state.fileBrowser.searchMode
      ? uiText("files.renderFileBrowserList.textContent2")
      : uiText("files.renderFileBrowserList.textContent");
    elements.fileBrowserLimitNotice.classList.toggle("hidden", !state.fileBrowser.truncated);
  }

  function setFileBrowserLoading(loading) {
    state.fileBrowser.loading = loading;
    elements.fileBrowserSearch.disabled = loading;
    elements.fileBrowserSearchAll.disabled = loading;
    elements.showHiddenFiles.disabled = loading;
    elements.uploadToDirectoryButton.disabled = loading || !state.fileBrowser.path;
    elements.newFileBrowserFolderButton.disabled = loading || !state.fileBrowser.path;
    elements.refreshFileBrowserButton.disabled = loading;
    elements.deleteSelectedFilesButton.disabled = loading || state.fileBrowser.selectedPaths.size === 0;
    elements.copySelectedFilesButton.disabled = loading || state.fileBrowser.selectedPaths.size === 0;
    elements.moveSelectedFilesButton.disabled = loading || state.fileBrowser.selectedPaths.size === 0;
    elements.newTaskFromDirectoryButton.disabled = loading || !state.fileBrowser.path;
    if (!loading) return;
    const row = el("div", "directory-empty");
    row.append(el("span", "spinner"), el("span", "", uiText("files.loadFileBrowser.showLoadingToast")));
    elements.fileBrowserList.replaceChildren(row);
    elements.fileBrowserLimitNotice.classList.add("hidden");
  }

  async function loadFileBrowser(path, { preserveSearch = false } = {}) {
    const sequence = ++state.fileBrowser.loadSequence;
    closeAllMenus();
    if (!preserveSearch) elements.fileBrowserSearch.value = "";
    setFileBrowserLoading(true);
    const loadingToken = showLoadingToast(uiText("files.loadFileBrowser.showLoadingToast"));
    try {
      const query = elements.fileBrowserSearch.value.trim();
      const searchAll = elements.fileBrowserSearchAll.checked && query.length >= 2;
      const params = new URLSearchParams({
        hidden: String(elements.showHiddenFiles.checked),
        query,
      });
      let result;
      if (searchAll) {
        result = await api(`/api/files/search?${params}`);
      } else {
        params.set("path", path);
        result = await api(`/api/files/list?${params}`);
      }
      if (sequence !== state.fileBrowser.loadSequence) return;
      Object.assign(state.fileBrowser, {
        path: result.path || path,
        parent: searchAll ? null : result.parent || null,
        roots: result.roots || [],
        entries: result.entries || result.results || [],
        truncated: Boolean(result.truncated),
        searchMode: searchAll,
      });
      const visiblePaths = new Set(state.fileBrowser.entries.map((entry) => entry.path));
      for (const selectedPath of state.fileBrowser.selectedPaths) {
        if (!visiblePaths.has(selectedPath)) state.fileBrowser.selectedPaths.delete(selectedPath);
      }
      localStorage.setItem("codex-pwa-file-browser-path", result.path || path);
      elements.fileBrowserCurrentPath.textContent = searchAll
        ? uiText("files.loadFileBrowser.textContent", query)
        : result.path;
      elements.fileBrowserCurrentPath.title = searchAll
        ? uiText("files.loadFileBrowser.title", query)
        : result.path;
      renderFileBrowserRoots();
      renderFileBrowserList();
      syncFileSelectionControls();
    } finally {
      finishLoadingToast(loadingToken);
      if (sequence === state.fileBrowser.loadSequence) setFileBrowserLoading(false);
    }
  }

  async function openFileBrowser() {
    const fallback = state.roots[0] || "";
    const requested = state.fileBrowser.path || state.selectedThread?.cwd || fallback;
    closeAllMenus();
    elements.fileBrowserSearchAll.checked = state.fileBrowser.searchAllRoots;
    if (!elements.fileBrowserDialog.open) elements.fileBrowserDialog.showModal();
    closeSidebar();
    try {
      await loadFileBrowser(requested);
    } catch (error) {
      if (requested !== fallback) await loadFileBrowser(fallback).catch(() => {});
      showToast(error.message, 5200);
    }
  }

  function closeFileBrowser() {
    if (elements.fileBrowserDialog.open) elements.fileBrowserDialog.close();
  }

  return {
    renderFileBrowserRoots,
    syncFileSelectionControls,
    createFileBrowserEntry,
    deleteSelectedFileBrowserEntries,
    operateSelectedFileBrowserEntries,
    operateFileBrowserEntry,
    createFileBrowserFolder,
    uploadFilesToBrowserDirectory,
    syncBrowserUploadControls,
    clearBrowserUploadSession,
    pauseBrowserDirectoryUpload,
    startBrowserDirectoryUpload,
    syncFileBrowserUploadProgress,
    renderFileBrowserList,
    setFileBrowserLoading,
    loadFileBrowser,
    openFileBrowser,
    closeFileBrowser,
  };
}
