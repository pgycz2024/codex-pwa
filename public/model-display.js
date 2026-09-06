function titleCaseModelPart(value) {
  return value.replace(/[A-Za-z]+/g, (word) => `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`);
}

/** Return a readable label when app-server has not advertised a model yet. */
export function modelDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const gptMatch = /^gpt[-_](\d+(?:\.\d+)?)(?:[-_](.+))?$/i.exec(raw);
  if (gptMatch) {
    const suffix = gptMatch[2]
      ? `-${gptMatch[2].split(/[-_]+/).filter(Boolean).map(titleCaseModelPart).join("-")}`
      : "";
    return `GPT${gptMatch[1]}${suffix}`;
  }
  if (/^[a-z]+\d/i.test(raw)) return `${raw[0].toUpperCase()}${raw.slice(1)}`;
  return raw;
}

export function resolveModel(value, models = []) {
  const key = String(value || "").trim();
  if (!key) return models.find((item) => item.isDefault) || null;
  return models.find((item) => (item.model || item.id) === key)
    || {
      id: key,
      model: key,
      displayName: modelDisplayName(key),
      supportedReasoningEfforts: [],
    };
}
