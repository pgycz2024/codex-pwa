import { normalizeEpochSeconds } from "./time-display.js";

const priority = { message: 6, notification: 5, emitted: 4, bridge: 3, pending: 2, browser: 2, "turn-start": 1, "turn-end": 1 };
function firstTime(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    const milliseconds = /(?:Ms|_ms)$/.test(key);
    if (milliseconds && (typeof value !== "number" && typeof value !== "string")) continue;
    const time = milliseconds ? normalizeEpochSeconds(Number(value) / 1000) : normalizeEpochSeconds(value);
    if (time) return time;
  }
  return 0;
}
const startKeys = ["startedAt", "started_at", "startedAtMs", "started_at_ms", "createdAt", "created_at"];
const endKeys = ["completedAt", "completed_at", "completedAtMs", "completed_at_ms"];
const sentKeys = ["sentAt", "sent_at", "sentAtMs", "sent_at_ms", ...startKeys];

export function resolveMessageTiming({ role, item = {}, turn = {}, previous = {}, params = {},
  phase = "", emittedAtMs = 0, observedAt = 0, browserAt = 0, pendingAt = 0 } = {}) {
  const timing = { ...previous };
  const put = (field, value, source, replace = false) => {
    if (!value) return;
    const before = timing[field];
    if (!before || priority[source] > priority[before.source] || (replace && priority[source] === priority[before.source])) {
      timing[field] = { value, source };
    }
  };
  put("startedAt", firstTime(item, startKeys), "message", true);
  put("completedAt", firstTime(item, endKeys), "message", true);
  if (role === "user") put("sentAt", firstTime(item, sentKeys), "message", true);
  put("startedAt", firstTime(params, startKeys), "notification");
  put("completedAt", firstTime(params, endKeys), "notification");
  if (role === "user") put("sentAt", firstTime(params, sentKeys), "notification");
  if (phase) {
    const field = role === "user" ? "sentAt" : phase === "started" ? "startedAt" : "completedAt";
    // A completion notification's generic timestamp is not a user's send time.
    if (role !== "user" || phase === "started") {
      put(field, firstTime(params, ["timestamp"]), "notification");
      // The envelope records event emission, not an authoritative message time.
      // Keep it approximate, and never use a completion event to move user send time.
      if (Number.isSafeInteger(emittedAtMs) && emittedAtMs > 0 && emittedAtMs <= 8.64e15) {
        put(field, emittedAtMs / 1000, "emitted");
      }
    }
    if (role !== "user" || phase === "started" || !timing.sentAt) {
      put(field, normalizeEpochSeconds(observedAt), "bridge");
      put(field, normalizeEpochSeconds(browserAt), "browser");
    }
  }
  if (role === "user") put("sentAt", normalizeEpochSeconds(pendingAt), "pending");
  const turnStart = firstTime(turn, startKeys);
  const turnEnd = firstTime(turn, endKeys);
  put("startedAt", turnStart, "turn-start");
  if (role === "user") put("sentAt", turnStart, "turn-start");
  else put("completedAt", turnEnd, "turn-end");
  return timing;
}

export function displayedMessageTime(timing = {}, role) {
  const point = role === "user" ? timing.sentAt : timing.completedAt || timing.startedAt;
  return { timestamp: point?.value || 0, source: point?.source || "", estimated: Boolean(point && priority[point.source] < 5) };
}

export const MESSAGE_TIME_SOURCES = {
  message: "消息记录时间", notification: "通知记录时间", emitted: "事件发出时间（近似消息时间）", bridge: "服务器接收时间",
  pending: "本地记录时间", browser: "浏览器接收时间", "turn-start": "本轮开始时间（消息时间缺失）", "turn-end": "本轮结束时间（消息时间缺失）",
};
