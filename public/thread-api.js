function querySuffix(query) {
  if (!query) return "";
  const value = query instanceof URLSearchParams ? query.toString() : String(query).replace(/^\?/, "");
  return value ? `?${value}` : "";
}

export function createThreadApi({ api } = {}) {
  if (typeof api !== "function") throw new TypeError("createThreadApi requires an api function");
  const id = (threadId) => encodeURIComponent(String(threadId));

  return {
    list(query) {
      return api(`/api/threads${querySuffix(query)}`);
    },
    get(threadId, query) {
      return api(`/api/threads/${id(threadId)}${querySuffix(query)}`);
    },
    turns(threadId, query) {
      return api(`/api/threads/${id(threadId)}/turns${querySuffix(query)}`);
    },
    transcript(threadId, turnId) {
      const query = new URLSearchParams({ turnId: String(turnId) });
      return api(`/api/threads/${id(threadId)}/transcript?${query}`);
    },
    output(threadId, itemId) {
      return api(`/api/threads/${id(threadId)}/outputs/${id(itemId)}`);
    },
    artifacts(threadId) {
      return api(`/api/threads/${id(threadId)}/artifacts`);
    },
  };
}

export { querySuffix };
