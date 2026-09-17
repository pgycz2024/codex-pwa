import { reconcileChildren, setText } from "./dom-reconcile.js";
import { activityStatusLabel as statusLabel } from "./status-display.js";

export function createActivityViewManager({
  state,
  elements,
  el,
  threadApi,
  showToast,
  scrollToBottom,
  renderChangesPanel,
  turnGroup,
  placeNodeInContainer,
  nextDiffChunkEnd,
  countDiffLines,
  diffChunkSize,
  commandOutputPreviewChars,
  toolOutputPreviewChars,
  maxLiveTextChars,
  maxLiveCommandChars,
  liveTextTruncationMarker,
  formatUploadSize,
  streamRenderIntervalMs,
} = {}) {

  function activityCard(kind, title, status = "") {
    const details = el("details", `activity-card ${kind}-card`);
    const summary = el("summary");
    const icons = { command: ">_", file: "±", tool: "◇", reasoning: "∿", activity: "·" };
    summary.append(el("span", "activity-icon", icons[kind] || "·"), el("span", "activity-title", title));
    const statusWrap = el("span", "activity-status");
    if (status) statusWrap.append(el("span", `status-pill ${status}`, statusLabel(status)));
    summary.append(statusWrap);
    details.append(summary);
    return { details, summary, statusWrap };
  }

  function commandTitle(command) {
    const value = String(command || "正在执行命令").replace(/\s+/g, " ").trim();
    return value.length > 100 ? `${value.slice(0, 98)}…` : value;
  }

  function collapsedLongText(text, limit) {
    const value = String(text || "");
    if (value.length <= limit) return value;
    const headLength = Math.floor(limit * 0.68);
    const tailLength = limit - headLength;
    const hidden = value.length - limit;
    return `${value.slice(0, headLength)}\n\n… 已折叠 ${hidden.toLocaleString("zh-CN")} 个字符 …\n\n${value.slice(-tailLength)}`;
  }

  function boundedLiveText(value, limit = maxLiveTextChars) {
    const text = String(value || "");
    if (text.length <= limit) return { text, truncated: false };
    const available = Math.max(1, limit - liveTextTruncationMarker.length);
    const headLength = Math.floor(available * 0.28);
    return {
      text: `${text.slice(0, headLength)}${liveTextTruncationMarker}${text.slice(-(available - headLength))}`,
      truncated: true,
    };
  }

  function appendBoundedLiveText(current, delta, limit = maxLiveTextChars) {
    const value = String(current || "");
    const addition = String(delta || "");
    const markerIndex = value.indexOf(liveTextTruncationMarker);
    if (markerIndex < 0) return boundedLiveText(`${value}${addition}`, limit);
    const head = value.slice(0, markerIndex);
    const tail = `${value.slice(markerIndex + liveTextTruncationMarker.length)}${addition}`;
    const tailLimit = Math.max(1, limit - liveTextTruncationMarker.length - head.length);
    return { text: `${head}${liveTextTruncationMarker}${tail.slice(-tailLimit)}`, truncated: true };
  }

  function paintExpandableOutput(node, { limit, label, emptyText = "等待输出…" }) {
    const value = String(node.fullText || "");
    const totalLength = node.outputLength || value.length;
    const truncated = Boolean(node.remoteTruncated || node.memoryTruncated) || value.length > limit;
    setText(node.output, value ? node.expanded ? value : collapsedLongText(value, limit) : emptyText);
    node.toggle.classList.toggle("hidden", !truncated);
    node.toggle.setAttribute("aria-expanded", String(Boolean(node.expanded)));
    node.toggle.disabled = Boolean(node.remoteTruncated && node.remoteUnavailable);
    node.toggle.textContent = node.remoteTruncated && node.remoteUnavailable
      ? `${label}过长，仅保留首尾（${totalLength.toLocaleString("zh-CN")} 字符）`
      : node.expanded
        ? `收起${label}`
        : node.memoryTruncated
          ? `展开保留的${label}（共 ${totalLength.toLocaleString("zh-CN")} 字符）`
          : `展开完整${label}（${totalLength.toLocaleString("zh-CN")} 字符）`;
  }

  async function toggleCommandOutput(itemId, node) {
    if (node.remoteTruncated && node.remoteUnavailable) return;
    if (node.remoteTruncated) {
      node.toggle.disabled = true;
      node.toggle.textContent = "正在载入完整输出…";
      try {
        const result = await threadApi.output(node.threadId, itemId);
        node.fullText = result.output || "";
        node.outputLength = node.fullText.length;
        node.remoteTruncated = false;
        node.remoteUnavailable = false;
        node.memoryTruncated = false;
        node.expanded = true;
      } catch (error) {
        showToast(error.message, 5200);
      } finally {
        node.toggle.disabled = false;
        paintExpandableOutput(node, { limit: commandOutputPreviewChars, label: "输出" });
      }
      return;
    }
    node.expanded = !node.expanded;
    paintExpandableOutput(node, { limit: commandOutputPreviewChars, label: "输出" });
  }

  function scheduleCommandOutputRender(itemId, node, follow = false) {
    node.followOutput ||= follow;
    if (state.commandRenderTimers.has(itemId)) return;
    state.commandRenderTimers.set(itemId, setTimeout(() => {
      state.commandRenderTimers.delete(itemId);
      paintExpandableOutput(node, { limit: commandOutputPreviewChars, label: "输出" });
      if (node.followOutput) requestAnimationFrame(() => scrollToBottom(true));
      node.followOutput = false;
    }, streamRenderIntervalMs));
  }

  function renderCommand(item, container = elements.messages) {
    const existing = state.itemNodes.get(item.id);
    if (existing?.type === "command") {
      const timer = state.commandRenderTimers.get(item.id);
      if (timer) clearTimeout(timer);
      state.commandRenderTimers.delete(item.id);
      setText(existing.title, commandTitle(item.command));
      if (item.outputTruncated) {
        const alreadyHasFullOutput = existing.fullText.length >= Number(item.outputLength || 0);
        if (!alreadyHasFullOutput) existing.fullText = item.aggregatedOutput || existing.fullText;
        existing.remoteTruncated = !alreadyHasFullOutput;
        existing.remoteUnavailable = existing.remoteTruncated && item.fullOutputAvailable === false;
        existing.memoryTruncated = false;
        existing.outputLength = Number(item.outputLength || existing.fullText.length);
      } else if (typeof item.aggregatedOutput === "string" && item.aggregatedOutput) {
        const bounded = boundedLiveText(item.aggregatedOutput, maxLiveCommandChars);
        existing.fullText = bounded.text;
        existing.remoteTruncated = false;
        existing.remoteUnavailable = false;
        existing.memoryTruncated = bounded.truncated;
        existing.outputLength = item.aggregatedOutput.length;
      }
      paintExpandableOutput(existing, { limit: commandOutputPreviewChars, label: "输出" });
      existing.status.className = `status-pill ${item.status || ""}`;
      setText(existing.status, statusLabel(item.status));
      if (item.status === "failed" && existing.lastStatus !== "failed") existing.element.open = true;
      existing.lastStatus = item.status;
      updateCommandMeta(existing.meta, item);
      placeNodeInContainer(existing.element, container);
      return existing.element;
    }
    const card = activityCard("command", commandTitle(item.command), item.status || "inProgress");
    const title = card.summary.querySelector(".activity-title");
    const status = card.statusWrap.querySelector(".status-pill");
    const content = el("div", "activity-content");
    const output = el("pre", "terminal-output");
    const toggle = el("button", "output-toggle hidden", "展开完整输出");
    toggle.type = "button";
    const meta = el("div", "activity-meta");
    updateCommandMeta(meta, item);
    content.append(output, toggle, meta);
    card.details.append(content);
    card.details.open = item.status === "inProgress" || item.status === "failed";
    container.append(card.details);
    const initialOutput = String(item.aggregatedOutput || "");
    const boundedOutput = item.outputTruncated
      ? { text: initialOutput, truncated: false }
      : boundedLiveText(initialOutput, maxLiveCommandChars);
    const node = {
      type: "command", element: card.details, title, status, output, toggle, meta, lastStatus: item.status,
      fullText: boundedOutput.text, expanded: false, followOutput: false,
      remoteTruncated: Boolean(item.outputTruncated),
      remoteUnavailable: Boolean(item.outputTruncated && item.fullOutputAvailable === false),
      memoryTruncated: boundedOutput.truncated,
      outputLength: Number(item.outputLength || initialOutput.length),
      threadId: state.selectedThread?.id || "",
    };
    toggle.addEventListener("click", () => toggleCommandOutput(item.id, node));
    paintExpandableOutput(node, { limit: commandOutputPreviewChars, label: "输出" });
    state.itemNodes.set(item.id, node);
    return card.details;
  }

  function updateCommandMeta(meta, item) {
    const key = JSON.stringify([item.cwd, item.exitCode, item.durationMs]);
    if (meta._commandMetaKey === key) return;
    meta._commandMetaKey = key;
    meta.replaceChildren();
    if (item.cwd) meta.append(el("span", "", `目录 ${item.cwd}`));
    if (item.exitCode !== null && item.exitCode !== undefined) meta.append(el("span", "", `退出码 ${item.exitCode}`));
    if (item.durationMs !== null && item.durationMs !== undefined) meta.append(el("span", "", `${(item.durationMs / 1000).toFixed(1)} 秒`));
  }

  function renderDiff(diff) {
    const lines = String(diff || "暂无差异内容").split("\n");
    const view = el("div", "diff-view");
    const rows = el("div", "diff-rows");
    const controls = el("div", "diff-controls");
    let rendered = 0;

    function appendChunk() {
      const end = nextDiffChunkEnd(lines.length, rendered, diffChunkSize);
      const fragment = document.createDocumentFragment();
      for (let index = rendered; index < end; index += 1) {
        const line = lines[index];
        const type = line.startsWith("+") && !line.startsWith("+++") ? "add"
          : line.startsWith("-") && !line.startsWith("---") ? "remove"
            : line.startsWith("@@") ? "hunk" : "";
        const row = el("div", `diff-line ${type}`.trim());
        row.append(el("span", "diff-number", String(index + 1)), el("span", "diff-text", line || " "));
        fragment.append(row);
      }
      rows.append(fragment);
      rendered = end;
      controls.replaceChildren();
      if (rendered < lines.length) {
        const more = el("button", "diff-load-more", `继续显示（${rendered}/${lines.length} 行）`);
        more.type = "button";
        more.addEventListener("click", appendChunk);
        controls.append(more);
      }
    }

    view.append(rows, controls);
    appendChunk();
    return view;
  }

  function attachLazyDiff(details, diff, { open = false } = {}) {
    const lineCount = countDiffLines(diff);
    const placeholder = el(
      "div",
      "diff-placeholder",
      lineCount ? `展开后载入 ${lineCount.toLocaleString("zh-CN")} 行差异` : "暂无差异内容",
    );
    details.append(placeholder);
    let loaded = false;
    const load = () => {
      if (!details.open || loaded) return;
      loaded = true;
      placeholder.replaceWith(renderDiff(diff));
    };
    details.addEventListener("toggle", load);
    if (open) {
      details.open = true;
      load();
    }
  }

  function kindLabel(kind) {
    if (typeof kind === "string") return kind;
    return Object.keys(kind || {})[0] || "修改";
  }

  function collectFileChanges(changes = [], { renderPanel = true } = {}) {
    for (const change of changes) {
      if (!change?.path) continue;
      state.fileChanges.set(change.path, change);
    }
    if (renderPanel) renderChangesPanel();
  }

  function renderFileChange(item, container = elements.messages, { collectChanges = true } = {}) {
    if (collectChanges) collectFileChanges(item.changes || []);
    const existing = state.itemNodes.get(item.id);
    const count = item.changes?.length || 0;
    if (existing?.type === "file") {
      setText(existing.element.querySelector(".activity-title"), count ? `${count} 个文件发生变更` : "正在准备文件变更");
      const status = existing.element.querySelector(".status-pill");
      status.className = `status-pill ${item.status || "inProgress"}`;
      setText(status, statusLabel(item.status || "inProgress"));
      if (existing.changesKey !== JSON.stringify(item.changes || [])) {
        const next = createFileChangeSections(item.changes || [], existing.sections);
        reconcileChildren(existing.content, [...next.values()].map((record) => record.section));
        existing.sections = next;
        existing.changesKey = JSON.stringify(item.changes || []);
      }
      placeNodeInContainer(existing.element, container);
      return existing.element;
    }
    const card = activityCard("file", count ? `${count} 个文件发生变更` : "正在准备文件变更", item.status || "inProgress");
    const content = el("div", "activity-content file-list");
    const sections = createFileChangeSections(item.changes || []);
    content.append(...[...sections.values()].map((record) => record.section));
    card.details.append(content);
    card.details.open = item.status === "inProgress" || item.status === "failed";
    container.append(card.details);
    state.itemNodes.set(item.id, { type: "file", element: card.details, content, sections, changesKey: JSON.stringify(item.changes || []) });
    return card.details;
  }

  function createFileChangeSections(changes, previous = new Map()) {
    const sections = new Map();
    const occurrences = new Map();
    for (const change of changes) {
      const occurrence = occurrences.get(change.path) || 0;
      occurrences.set(change.path, occurrence + 1);
      const key = JSON.stringify([change.path, occurrence]);
      const signature = JSON.stringify(change);
      const old = previous.get(key);
      if (old?.signature === signature) { sections.set(key, old); continue; }
      const section = el("details", "file-change");
      const heading = el("summary", "file-heading");
      heading.append(el("span", "file-kind", kindLabel(change.kind)), el("span", "", change.path));
      section.append(heading);
      attachLazyDiff(section, change.diff, { open: Boolean(old?.section.open) });
      sections.set(key, { signature, section });
    }
    return sections;
  }

  function renderTool(item, container = elements.messages) {
    const existing = state.itemNodes.get(item.id);
    const name = item.type === "mcpToolCall" ? `${item.server || "MCP"} / ${item.tool || "工具"}` : `${item.namespace ? `${item.namespace} / ` : ""}${item.tool || "工具"}`;
    const data = {
      arguments: item.arguments,
      result: item.result || item.contentItems,
      error: item.error,
    };
    const statusValue = item.status || (item.success === false ? "failed" : "completed");
    if (existing?.type === "tool") {
      setText(existing.element.querySelector(".activity-title"), name);
      const status = existing.element.querySelector(".status-pill");
      status.className = `status-pill ${statusValue}`;
      setText(status, statusLabel(statusValue));
      existing.fullText = JSON.stringify(data, null, 2);
      paintExpandableOutput(existing, { limit: toolOutputPreviewChars, label: "工具输出", emptyText: "暂无输出" });
      placeNodeInContainer(existing.element, container);
      return existing.element;
    }
    const card = activityCard("tool", name, statusValue);
    const content = el("div", "activity-content");
    const output = el("pre", "tool-json");
    const toggle = el("button", "output-toggle hidden", "展开完整工具输出");
    toggle.type = "button";
    const node = { type: "tool", element: card.details, output, toggle, fullText: JSON.stringify(data, null, 2), expanded: false };
    toggle.addEventListener("click", () => {
      node.expanded = !node.expanded;
      paintExpandableOutput(node, { limit: toolOutputPreviewChars, label: "工具输出", emptyText: "暂无输出" });
    });
    paintExpandableOutput(node, { limit: toolOutputPreviewChars, label: "工具输出", emptyText: "暂无输出" });
    content.append(output, toggle);
    card.details.append(content);
    card.details.open = Boolean(item.error || item.status === "failed");
    container.append(card.details);
    state.itemNodes.set(item.id, node);
    return card.details;
  }

  function renderReasoning(item, container = elements.messages) {
    const text = [...(item.summary || []), ...(item.content || [])].join("\n\n");
    const existing = state.itemNodes.get(item.id);
    if (existing?.type === "reasoning") {
      setText(existing.content, text || "正在分析…");
      placeNodeInContainer(existing.element, container);
      return existing.element;
    }
    const card = activityCard("reasoning", "分析过程", item.status || "");
    card.details.classList.add("reasoning-card");
    const content = el("div", "reasoning-content", text || "正在分析…");
    card.details.append(content);
    container.append(card.details);
    state.itemNodes.set(item.id, { type: "reasoning", element: card.details, content });
    return card.details;
  }

  function renderPlan(plan, container = elements.messages, itemId = "live-plan") {
    const existing = state.itemNodes.get(itemId);
    const key = JSON.stringify(plan);
    if (existing?.type === "plan" && existing.planKey === key) {
      placeNodeInContainer(existing.element, container);
      return existing.element;
    }
    const card = el("section", "plan-card");
    const heading = el("div", "plan-heading");
    heading.append(el("span", "", "◫"), el("span", "", "执行计划"));
    const steps = el("div", "plan-steps");
    for (const step of plan?.plan || []) {
      const row = el("div", `plan-step ${step.status || "pending"}`);
      const symbol = step.status === "completed" ? "✓" : step.status === "inProgress" ? "•" : "";
      row.append(el("span", "plan-check", symbol), el("span", "", step.step));
      steps.append(row);
    }
    if (!steps.children.length && plan?.text) steps.append(el("div", "plan-step", plan.text));
    card.append(heading);
    if (plan?.explanation) card.append(el("p", "reasoning-content", plan.explanation));
    card.append(steps);
    if (existing?.element) existing.element.replaceWith(card);
    else container.append(card);
    state.itemNodes.set(itemId, { type: "plan", element: card, planKey: key });
    return card;
  }

  function renderActivity(item, label, container = elements.messages) {
    const existing = item.id ? state.itemNodes.get(item.id) : null;
    if (existing?.type === "activity") {
      setText(existing.element.querySelector(".activity-title"), label);
      const wrap = existing.element.querySelector(".activity-status");
      if (wrap.dataset.status !== (item.status || "")) {
        wrap.replaceChildren(...(item.status ? [el("span", `status-pill ${item.status}`, statusLabel(item.status))] : []));
        wrap.dataset.status = item.status || "";
      }
      placeNodeInContainer(existing.element, container);
      return existing.element;
    }
    const card = activityCard("activity", label, item.status || "");
    container.append(card.details);
    if (item.id) state.itemNodes.set(item.id, { type: "activity", element: card.details });
    return card.details;
  }

  function isContextNotice(text) {
    return /\b(?:context|contexts|token|tokens|length|compaction|compact|window)\b|上下文|令牌|压缩|长度/i.test(String(text || ""));
  }

  function notificationTurnId(params = {}) {
    const explicit = params.turnId || params.turn?.id;
    if (explicit) return String(explicit);
    if (params.threadId && state.selectedThread?.id && params.threadId !== state.selectedThread.id) return null;
    if (state.activeTurnId) return state.activeTurnId;
    return state.selectedThread?.turns?.find((turn) => turn?.status === "inProgress")?.id || null;
  }

  function renderTurnNotice(text, { turnId = null, kind = "warning", id = "" } = {}) {
    const messageText = String(text || "").trim();
    if (!messageText) return null;
    const container = turnGroup(turnId, { create: Boolean(turnId) }) || elements.messages;
    const noticeKey = `turn-notice:${id || `${kind}:${turnId || "root"}:${messageText}`}`;
    const existing = state.itemNodes.get(noticeKey);
    if (existing?.type === "turnNotice" && existing.element) {
      existing.element.textContent = messageText;
      existing.element.className = `turn-notice ${kind}`;
      existing.element.dataset.noticeText = messageText;
      placeNodeInContainer(existing.element, container);
      return existing.element;
    }
    const notice = el("div", `turn-notice ${kind}`, messageText);
    notice.dataset.noticeText = messageText;
    container.append(notice);
    state.itemNodes.set(noticeKey, { type: "turnNotice", element: notice });
    return notice;
  }

  function imageArtifactMetadata(item) {
    const artifact = item?.artifact || state.artifacts.get(item?.id);
    if (!artifact || !item?.id) return null;
    const threadId = state.selectedThread?.id || "";
    const base = `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(item.id)}/raw`;
    return {
      ...artifact,
      id: item.id,
      previewUrl: artifact.previewUrl || base,
      downloadUrl: artifact.downloadUrl || `${base}?download=1`,
    };
  }

  function renderImageGeneration(item, container = elements.messages) {
    const existing = state.itemNodes.get(item.id);
    const artifact = imageArtifactMetadata(item);
    const artifactKey = JSON.stringify(artifact || item.status || "inProgress");
    if (existing?.type === "imageGeneration" && existing.artifactKey === artifactKey) {
      placeNodeInContainer(existing.element, container);
      return existing.element;
    }
    if (existing?.element) existing.element.remove();
    if (!artifact) {
      const card = activityCard("activity", "正在生成图片", item.status || "inProgress");
      container.append(card.details);
      state.itemNodes.set(item.id, { type: "imageGeneration", element: card.details, artifactKey });
      return card.details;
    }
    state.artifacts.set(item.id, artifact);
    const card = el("section", "artifact-card image-artifact");
    card.dataset.artifactId = item.id;
    const preview = el("a", "artifact-preview");
    preview.href = artifact.previewUrl;
    preview.target = "_blank";
    preview.rel = "noopener noreferrer";
    const image = document.createElement("img");
    image.src = artifact.previewUrl;
    image.alt = "Codex 生成的图片";
    image.loading = "lazy";
    image.decoding = "async";
    preview.append(image);
    const copy = el("div", "artifact-copy");
    copy.append(
      el("strong", "", artifact.name || "Codex 生成图片"),
      el("span", "", `${formatUploadSize(artifact.byteLength || 0)} · 点击图片预览`),
    );
    if (artifact.revisedPrompt) {
      const prompt = el("details", "artifact-prompt");
      prompt.append(el("summary", "", "查看生成提示"), el("p", "", artifact.revisedPrompt));
      copy.append(prompt);
    }
    const actions = el("div", "artifact-actions");
    const open = el("a", "", "预览");
    open.href = artifact.previewUrl;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    const download = el("a", "", "下载");
    download.href = artifact.downloadUrl;
    download.download = artifact.name || "generated-image";
    actions.append(open, download);
    card.append(preview, copy, actions);
    container.append(card);
    state.itemNodes.set(item.id, { type: "imageGeneration", element: card, artifactKey });
    return card;
  }

  function suppressRedundantGeneratedArtifacts(group) {
    if (!group?.classList?.contains("turn-group") || !group.querySelector(".inline-server-image")) return false;
    for (const card of group.querySelectorAll(".image-artifact[data-artifact-id]")) {
      const artifactId = card.dataset.artifactId;
      card.remove();
      if (artifactId && state.itemNodes.get(artifactId)?.type === "imageGeneration") {
        state.itemNodes.delete(artifactId);
      }
    }
    return true;
  }

  function renderKnownArtifacts() {
    for (const artifact of state.artifacts.values()) {
      const turnId = artifact.turnId || state.itemTurns.get(artifact.id) || null;
      const group = turnGroup(turnId);
      if (!group) {
        const existing = state.itemNodes.get(artifact.id);
        if (existing?.type === "imageGeneration") {
          existing.element?.remove();
          state.itemNodes.delete(artifact.id);
        }
        continue;
      }
      if (suppressRedundantGeneratedArtifacts(group)) {
        const existing = state.itemNodes.get(artifact.id);
        if (existing?.type === "imageGeneration") {
          existing.element?.remove();
          state.itemNodes.delete(artifact.id);
        }
        continue;
      }
      renderImageGeneration({ id: artifact.id, type: "imageGeneration", status: "completed", artifact }, group);
      if (turnId) state.itemTurns.set(artifact.id, turnId);
    }
  }

  return {
    activityCard,
    statusLabel,
    commandTitle,
    collapsedLongText,
    boundedLiveText,
    appendBoundedLiveText,
    paintExpandableOutput,
    toggleCommandOutput,
    scheduleCommandOutputRender,
    renderCommand,
    updateCommandMeta,
    renderDiff,
    attachLazyDiff,
    kindLabel,
    collectFileChanges,
    renderFileChange,
    renderTool,
    renderReasoning,
    renderPlan,
    renderActivity,
    isContextNotice,
    notificationTurnId,
    renderTurnNotice,
    imageArtifactMetadata,
    renderImageGeneration,
    suppressRedundantGeneratedArtifacts,
    renderKnownArtifacts,
  };
}
