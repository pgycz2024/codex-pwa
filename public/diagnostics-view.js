import { uiText } from "./ui-copy.js";
import { formatAbsolute } from "./time-display.js";
import { threadStatusInfo as statusInfo } from "./status-display.js";
import { summarizeUnknownNotifications } from "./notification-diagnostics.js";
import { formatGoalDuration, formatGoalTokens, goalStatusLabel } from "./goal-actions.js";

export function createDiagnosticsView({
  state,
  elements,
  el,
  basename,
  sourceLabel,
  settingsState,
  displayedSettings,
  modelFor,
  effortLabel,
  permissionLabels
}) {
  function directInputEvidence(thread) {
    if (thread?.canAcceptDirectInput === true) return uiText("diagnostics.directInputEvidence.text3");
    if (thread?.canAcceptDirectInput === false) return uiText("diagnostics.directInputEvidence.text2");
    return uiText("diagnostics.directInputEvidence.text");
  }

  function bridgeOwnershipEvidence(threadId) {
    if (!threadId) return uiText("diagnostics.bridgeOwnershipEvidence.text4");
    if (state.releasingThreads.has(threadId)) return uiText("diagnostics.bridgeOwnershipEvidence.text3");
    if (state.ownedThreads.has(threadId)) return uiText("diagnostics.bridgeOwnershipEvidence.text2");
    return uiText("diagnostics.bridgeOwnershipEvidence.text");
  }

  function writerConflictEvidence(thread) {
    const evidence = thread?.writerEvidence;
    if (!evidence?.observedAt) return uiText("diagnostics.writerConflictEvidence.text3");
    const when = formatAbsolute(evidence.observedAt);
    const reported = evidence.reportedWriter?.label;
    return reported
      ? uiText("diagnostics.writerConflictEvidence.text2", reported, when)
      : uiText("diagnostics.writerConflictEvidence.text", when);
  }

  function unknownNotificationSummary() {
    const summary = summarizeUnknownNotifications(state.unknownNotifications);
    if (!summary.methodCount) return uiText("diagnostics.unknownNotificationSummary.text2");
    const details = summary.entries
      .map(({ method, count, lastAt }) => `${method} × ${count}（${formatAbsolute(lastAt)}）`)
      .join("、");
    return summary.methodCount > summary.entries.length
      ? uiText("diagnostics.unknownNotificationSummary.text", details, summary.methodCount)
      : details;
  }

  function infoSection(title, rows) {
    const section = el("section", "info-section");
    section.append(el("h3", "", title));
    const grid = el("div", "info-grid");
    for (const [label, value] of rows) {
      const row = el("div", "info-row");
      row.append(el("span", "", label), el("span", "", value || "—"));
      grid.append(row);
    }
    section.append(grid);
    return section;
  }

  function renderInfoPanel() {
    elements.infoPanel.replaceChildren();
    const thread = state.selectedThread;
    if (!thread) return;
    const current = settingsState(thread.id);
    const effective = current.effective;
    const pending = current.pending;
    const effectiveModel = modelFor(effective.model);
    const rootPolicy = state.rootAccessPolicy;
    const rootRows = rootPolicy?.broad
      ? [
        [uiText("diagnostics.renderInfoPanel.text4"), uiText("diagnostics.renderInfoPanel.text7")],
        [uiText("diagnostics.renderInfoPanel.text6"), uiText("diagnostics.renderInfoPanel.text5")],
      ]
      : [
        [uiText("diagnostics.renderInfoPanel.text4"), (state.roots || []).join("、") || uiText("app.supportTaskPrompt.text")],
        [uiText("diagnostics.renderInfoPanel.text3"), rootPolicy?.configured ? uiText("diagnostics.renderInfoPanel.text2") : uiText("diagnostics.renderInfoPanel.text")],
      ];
    if (state.accessRoots?.additional?.length) {
      rootRows.push([uiText("diagnostics.renderInfoPanel.push"), state.accessRoots.additional.map((root) => root.path).join("、")]);
    }
    elements.infoPanel.append(
      infoSection(uiText("common.task"), [
        [uiText("html.threadFilter.text9"), basename(thread.cwd)], [uiText("common.workDirectory"), thread.cwd], [uiText("diagnostics.renderInfoPanel.infoSection39"), sourceLabel(thread)],
        [uiText("diagnostics.renderInfoPanel.infoSection38"), formatAbsolute(thread.createdAt)], [uiText("diagnostics.renderInfoPanel.infoSection37"), formatAbsolute(thread.updatedAt)],
      ]),
      infoSection("Git", [
        [uiText("diagnostics.renderInfoPanel.infoSection36"), thread.gitInfo?.branch], [uiText("diagnostics.renderInfoPanel.infoSection35"), thread.gitInfo?.sha?.slice(0, 12)], [uiText("diagnostics.renderInfoPanel.infoSection34"), thread.gitInfo?.originUrl],
      ]),
      infoSection(uiText("common.task"), [
        [uiText("diagnostics.renderInfoPanel.infoSection33"), thread.id], ["Codex", thread.cliVersion], [uiText("diagnostics.renderInfoPanel.infoSection8"), statusInfo(thread.status).label],
        [uiText("diagnostics.renderInfoPanel.infoSection32"), directInputEvidence(thread)],
        [uiText("diagnostics.renderInfoPanel.infoSection31"), bridgeOwnershipEvidence(thread.id)],
        [uiText("diagnostics.renderInfoPanel.infoSection30"), writerConflictEvidence(thread)],
        [uiText("common.currentModel"), effectiveModel?.displayName || effective.model || uiText("diagnostics.renderInfoPanel.infoSection29")],
        [uiText("common.effort"), effective.effort ? effortLabel(effective.effort) : uiText("common.modelDefault")],
        [uiText("html.newEffortSelect.text"), permissionLabels[effective.permissionPreset] || uiText("diagnostics.renderInfoPanel.infoSection29")],
      ]),
      infoSection(uiText("diagnostics.renderInfoPanel.infoSection28"), [
        [uiText("diagnostics.renderInfoPanel.infoSection27"), state.protocol?.cliVersion || uiText("app.supportTaskPrompt.text")],
        ["App Server", state.protocol?.appServerVersion || uiText("app.supportTaskPrompt.text")],
        [uiText("diagnostics.renderInfoPanel.infoSection26"), state.protocol?.protocolVersion || uiText("diagnostics.renderInfoPanel.infoSection14")],
        [uiText("diagnostics.renderInfoPanel.infoSection25"), state.eventReplay
          ? uiText("diagnostics.renderInfoPanel.infoSection24", state.eventReplay.persistent ? uiText("diagnostics.renderInfoPanel.infoSection23") : uiText("diagnostics.renderInfoPanel.infoSection22"), state.eventReplay.count)
          : uiText("app.supportTaskPrompt.text")],
        [uiText("diagnostics.renderInfoPanel.infoSection21"), state.taskRecovery
          ? uiText("diagnostics.renderInfoPanel.infoSection20", state.taskRecovery.running, state.taskRecovery.unconfirmed, state.taskRecovery.storageHealthy ? "" : uiText("diagnostics.renderInfoPanel.infoSection18"), state.taskRecovery.dropped ? uiText("diagnostics.renderInfoPanel.infoSection19", state.taskRecovery.dropped) : "")
          : uiText("diagnostics.renderInfoPanel.infoSection17")],
        [uiText("diagnostics.renderInfoPanel.infoSection16"), Object.entries(state.protocol?.bridgeCapabilities || {})
          .filter(([, supported]) => supported)
          .map(([name]) => name)
          .join("、") || uiText("app.supportTaskPrompt.text")],
        [uiText("diagnostics.renderInfoPanel.infoSection15"), Object.entries(state.protocol?.advertisedCapabilities || {})
          .map(([name, supported]) => `${name}：${supported ? uiText("diagnostics.renderInfoPanel.map2") : uiText("diagnostics.renderInfoPanel.map")}`)
          .join("、") || uiText("diagnostics.renderInfoPanel.infoSection14")],
        [uiText("diagnostics.renderInfoPanel.infoSection13"), unknownNotificationSummary()],
      ]),
      infoSection(uiText("diagnostics.renderInfoPanel.infoSection12"), rootRows),
    );
    if (state.goalSupported !== false) {
      elements.infoPanel.append(infoSection("Goal", state.goal ? [
        [uiText("diagnostics.renderInfoPanel.infoSection8"), goalStatusLabel(state.goal.status)],
        [uiText("diagnostics.renderInfoPanel.infoSection11"), state.goal.objective],
        [uiText("diagnostics.renderInfoPanel.infoSection10"), `${formatGoalTokens(state.goal.tokensUsed)}${state.goal.tokenBudget ? ` / ${formatGoalTokens(state.goal.tokenBudget)}` : ""}`],
        [uiText("diagnostics.renderInfoPanel.infoSection9"), formatGoalDuration(state.goal.timeUsedSeconds)],
      ] : [[uiText("diagnostics.renderInfoPanel.infoSection8"), uiText("diagnostics.renderInfoPanel.infoSection7")]]));
    }
    if (Object.keys(pending).length) {
      const next = displayedSettings(thread.id);
      elements.infoPanel.append(infoSection(uiText("diagnostics.renderInfoPanel.infoSection6"), [
        [uiText("common.model"), modelFor(next.model)?.displayName || next.model || uiText("diagnostics.renderInfoPanel.infoSection5")],
        [uiText("common.effort"), next.effort ? effortLabel(next.effort) : uiText("common.modelDefault")],
        [uiText("html.newEffortSelect.text"), permissionLabels[next.permissionPreset] || uiText("diagnostics.renderInfoPanel.infoSection5")],
      ]));
    }
    if (state.tokenUsage) {
      const usage = state.tokenUsage;
      elements.infoPanel.append(infoSection(uiText("diagnostics.renderInfoPanel.infoSection4"), [
        [uiText("diagnostics.renderInfoPanel.infoSection3"), String(usage.total?.inputTokens ?? "—")], [uiText("diagnostics.renderInfoPanel.infoSection2"), String(usage.total?.outputTokens ?? "—")],
        [uiText("diagnostics.renderInfoPanel.infoSection"), String(usage.modelContextWindow ?? "—")],
      ]));
    }
  }


  return { renderInfoPanel };
}
