const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
export const PERMISSION_PRESETS = new Set(["request", "auto", "full"]);

function cloneSandboxPolicy(value) {
  if (!value || typeof value !== "object") return null;
  return JSON.parse(JSON.stringify(value));
}

function workspaceWritePolicy(current = null) {
  if (current?.type === "workspaceWrite") return cloneSandboxPolicy(current);
  return {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function permissionPresetFromSettings(settings = {}) {
  const sandboxType = settings.sandboxPolicy?.type || settings.sandbox?.type || settings.sandbox;
  const approvalPolicy = settings.approvalPolicy;
  const reviewer = settings.approvalsReviewer;
  if (sandboxType === "dangerFullAccess" || sandboxType === "danger-full-access") {
    return approvalPolicy === "never" ? "full" : "custom";
  }
  if (sandboxType === "workspaceWrite" || sandboxType === "workspace-write") {
    if (approvalPolicy === "on-request" && reviewer === "auto_review") return "auto";
    if (approvalPolicy === "on-request" && reviewer === "user") return "request";
  }
  return "custom";
}

export function permissionPresetRpc(preset, currentSandbox = null) {
  if (!PERMISSION_PRESETS.has(preset)) throw new Error("Unsupported permission preset");
  if (preset === "full") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: preset === "auto" ? "auto_review" : "user",
    sandboxPolicy: workspaceWritePolicy(currentSandbox),
  };
}

export function threadStartPermission(preset) {
  if (!PERMISSION_PRESETS.has(preset)) throw new Error("Unsupported permission preset");
  if (preset === "full") {
    return { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" };
  }
  return {
    approvalPolicy: "on-request",
    approvalsReviewer: preset === "auto" ? "auto_review" : "user",
    sandbox: "workspace-write",
  };
}

export function serializeThreadSettings(response = {}) {
  // `thread/read` returns settings on `thread`, while `thread/resume` returns
  // the same values at the response root. Accept both shapes so a newer or
  // older app-server cannot silently replace a recorded model with defaults.
  const sources = [response, response?.thread, response?.settings, response?.thread?.settings]
    .filter((source) => source && typeof source === "object");
  const firstString = (...keys) => {
    for (const source of sources) {
      for (const key of keys) {
        if (typeof source[key] === "string" && source[key].trim()) return source[key];
      }
    }
    return null;
  };
  const firstValue = (...keys) => {
    for (const source of sources) {
      for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null) return source[key];
      }
    }
    return null;
  };
  const settings = {
    model: firstString("model"),
    effort: firstString("reasoningEffort", "effort"),
    approvalPolicy: firstValue("approvalPolicy"),
    approvalsReviewer: firstValue("approvalsReviewer"),
    sandboxPolicy: cloneSandboxPolicy(firstValue("sandboxPolicy", "sandbox")),
  };
  settings.permissionPreset = permissionPresetFromSettings(settings);
  return settings;
}

export function parseSettingsOverrides(raw, currentSettings = {}) {
  if (raw === undefined || raw === null) return { rpc: {}, applied: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Settings must be an object");
  const rpc = {};
  const applied = {};

  if (Object.hasOwn(raw, "model")) {
    const model = String(raw.model || "").trim().slice(0, 120);
    if (!model) throw new Error("Model override cannot be empty");
    rpc.model = model;
    applied.model = model;
  }
  if (Object.hasOwn(raw, "effort")) {
    if (raw.effort === null || raw.effort === "") {
      rpc.effort = null;
      applied.effort = null;
    } else {
      const effort = String(raw.effort);
      if (!EFFORTS.has(effort)) throw new Error("Unsupported reasoning effort");
      rpc.effort = effort;
      applied.effort = effort;
    }
  }
  if (Object.hasOwn(raw, "permissionPreset")) {
    const permissionPreset = String(raw.permissionPreset);
    const permission = permissionPresetRpc(permissionPreset, currentSettings.sandboxPolicy);
    Object.assign(rpc, permission);
    Object.assign(applied, permission, { permissionPreset });
  }
  return { rpc, applied };
}

export function mergeThreadSettings(current = {}, applied = {}) {
  const merged = {
    ...current,
    ...applied,
    sandboxPolicy: cloneSandboxPolicy(applied.sandboxPolicy || current.sandboxPolicy),
  };
  merged.permissionPreset = permissionPresetFromSettings(merged);
  return merged;
}
