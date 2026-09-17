export function normalizeEpochSeconds(value) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  if (typeof value === "string") {
    value = value.trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
      const [year, month, day] = value.slice(0, 10).split("-").map(Number);
      if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return 0;
      const milliseconds = Date.parse(value);
      return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 1000 : 0;
    }
    if (!/^\d+(?:\.\d+)?$/.test(value)) return 0;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  const seconds = number > 1e11 ? number / 1000 : number;
  return seconds <= 8.64e12 ? seconds : 0;
}

export function formatAbsolute(epochSeconds) {
  epochSeconds = normalizeEpochSeconds(epochSeconds);
  if (!epochSeconds) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}

export function formatRelative(epochSeconds, now = Date.now()) {
  epochSeconds = normalizeEpochSeconds(epochSeconds);
  if (!epochSeconds) return "";
  const seconds = Math.max(0, now / 1000 - epochSeconds);
  if (seconds < 50) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(epochSeconds * 1000));
}

export function formatTimestampMs(value) {
  if (!value) return "—";
  return formatAbsolute(Number(value) / 1000);
}
