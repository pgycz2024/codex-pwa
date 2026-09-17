import { normalizeNotificationMethod } from "./public/notification-methods.js";
import { approvalDecisionIds } from "./public/approval-decisions.js";

function protocolVersion(value) {
  const text = String(value || "");
  const match = text.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] || null;
}

export { normalizeNotificationMethod } from "./public/notification-methods.js";

const SUPPORTED_INTERACTIVE_REQUESTS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/tool/requestUserInput", "tool/requestUserInput", "execCommandApproval", "applyPatchApproval",
]);

export function isSupportedInteractiveRequest(method) {
  return SUPPORTED_INTERACTIVE_REQUESTS.has(method);
}

export function interactiveRequestThreadId(message) {
  const legacy = ["execCommandApproval", "applyPatchApproval"].includes(message?.method);
  const id = legacy ? message?.params?.conversationId : message?.params?.threadId;
  return typeof id === "string" && id.trim() ? id : "";
}

export function approvalResponse(approval, decision) {
  const modern = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(approval?.method);
  const legacy = ["execCommandApproval", "applyPatchApproval"].includes(approval?.method);
  if ((!modern && !legacy) || typeof decision !== "string" || !approvalDecisionIds(approval).includes(decision)) {
    const error = new Error("本次请求不提供这个审批选项，请查看当前可用选项");
    error.statusCode = 400;
    error.details = { code: "APPROVAL_DECISION_UNAVAILABLE", dispatched: false, outcomeUnknown: false };
    throw error;
  }
  if (modern) return { decision };
  return { decision: { accept: "approved", acceptForSession: "approved_for_session",
    decline: { denied: { rejection: "Declined from Codex PWA" } }, cancel: "abort" }[decision] };
}

/**
 * Normalize an app-server message before bridge routing. The bridge must use
 * the canonical method for ownership and state transitions while retaining a
 * bounded original method for upgrade diagnostics.
 */
export function normalizeProtocolMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const method = typeof message.method === "string" ? message.method : "";
  if (!method) return message;
  const normalized = normalizeNotificationMethod(method);
  let params = message.params;
  // These two supported legacy requests declare conversationId, not threadId.
  // Bind them to the same authorization, queue and display identity as v2.
  if (["execCommandApproval", "applyPatchApproval"].includes(method)
    && typeof params?.conversationId === "string" && params.conversationId.trim()
    && params.threadId !== params.conversationId) {
    params = { ...params, threadId: params.conversationId };
  }
  if (normalized === method && params === message.params) return message;
  return {
    ...message,
    method: normalized,
    params,
    ...(normalized !== method ? { originalMethod: method.slice(0, 160) } : {}),
  };
}

/**
 * Convert the loosely shaped initialize response from different Codex CLI
 * versions into the stable diagnostic shape exposed by the PWA.
 */
export function normalizeProtocolSnapshot(result, initializedAt = Date.now()) {
  const source = result && typeof result === "object" ? result : {};
  const serverInfo = source.serverInfo && typeof source.serverInfo === "object"
    ? source.serverInfo
    : source.server && typeof source.server === "object" ? source.server : {};
  const capabilitySources = [
    source.capabilities,
    source.advertisedCapabilities,
    serverInfo.capabilities,
    source.server?.capabilities,
  ].filter((value) => value && typeof value === "object" && !Array.isArray(value));
  const userAgent = String(serverInfo.userAgent || source.userAgent || "").slice(0, 240) || null;
  const appServerVersion = protocolVersion(serverInfo.version || source.appServerVersion || userAgent);
  const cliVersion = protocolVersion(serverInfo.cliVersion || source.cliVersion || userAgent || appServerVersion);
  const advertisedCapabilities = {};
  const aliases = {
    experimentalApi: ["experimentalApi", "supportsExperimentalApi"],
    goal: ["goal", "supportsGoal"],
    modelSettings: ["modelSettings", "supportsModelSettings"],
    threadHistory: ["threadHistory", "supportsThreadHistory"],
    serverRequests: ["serverRequests", "supportsServerRequests"],
  };
  for (const [key, names] of Object.entries(aliases)) {
    for (const capability of capabilitySources) {
      const nested = capability.advertised && typeof capability.advertised === "object"
        ? capability.advertised
        : capability;
      const match = names.find((name) => typeof nested[name] === "boolean");
      if (match) {
        advertisedCapabilities[key] = nested[match];
        break;
      }
    }
    if (Object.hasOwn(advertisedCapabilities, key)) continue;
    if (capabilitySources.some((capability) => {
      const nested = capability.advertised && typeof capability.advertised === "object" ? capability.advertised : capability;
      return Array.isArray(nested.methods) && nested.methods.includes(key);
    })) advertisedCapabilities[key] = true;
  }
  return {
    protocolVersion: protocolVersion(source.protocolVersion || source.protocol?.version),
    cliVersion,
    appServerVersion,
    serverName: String(serverInfo.name || source.serverName || "").slice(0, 120) || null,
    userAgent,
    advertisedCapabilities,
    bridgeCapabilities: {
      threadList: true,
      threadHistory: true,
      modelList: true,
      threadSettings: true,
      serverRequests: true,
      eventReplay: true,
      clientMessageCorrelation: true,
    },
    initializedAt: result ? initializedAt : null,
  };
}

export function isUnsupportedRpcError(error) {
  return error?.details?.code === -32601
    || /method not found|unsupported|unknown method|not implemented/i.test(String(error?.message || ""));
}


export function isThreadWriteConflict(error) {
  const text = `${error?.message || ""} ${JSON.stringify(error?.details || {})}`;
  return error?.details?.code === "THREAD_WRITE_CONFLICT"
    || /active\s+writer|writer.*(?:active|busy|owned)|(?:already|currently).*(?:writing|steer|running)|cannot\s+(?:start|steer|interrupt).*turn/i.test(text);
}


function boundedEvidenceText(value, limit = 120) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, limit) : "";
}

export function protocolWriterEvidence(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const nested = details.details && typeof details.details === "object" ? details.details : {};
  const candidates = [
    details.activeWriter,
    details.writer,
    details.writerDevice,
    details.owner,
    details.data?.activeWriter,
    details.metadata?.activeWriter,
    nested.activeWriter,
    nested.writer,
    nested.writerDevice,
    nested.owner,
  ];
  const value = candidates.find((candidate) => candidate && (typeof candidate === "string" || typeof candidate === "object"));
  if (!value) return null;
  if (typeof value === "string") {
    const label = boundedEvidenceText(value);
    return label ? { label, source: "app-server" } : null;
  }
  const label = boundedEvidenceText(value.label || value.name || value.device || value.client || value.source || value.id);
  const client = boundedEvidenceText(value.client);
  const device = boundedEvidenceText(value.device || value.deviceLabel);
  const source = boundedEvidenceText(value.source || value.kind);
  const id = boundedEvidenceText(value.id);
  if (!label && !client && !device && !source && !id) return null;
  return {
    ...(label ? { label } : {}),
    ...(client ? { client } : {}),
    ...(device ? { device } : {}),
    ...(source ? { source } : {}),
    ...(id ? { id } : {}),
    reportedBy: "app-server",
  };
}


export async function resumeThread(codex, threadId) {
  let result;
  try {
    result = await codex.request("thread/resume", { threadId, excludeTurns: true });
  } catch (error) {
    const details = `${error?.message || ""} ${JSON.stringify(error?.details || {})}`;
    if (error?.details?.code !== -32602 || !/excludeTurns|unknown field/i.test(details)) throw error;
    result = await codex.request("thread/resume", { threadId });
  }
  return result;
}
