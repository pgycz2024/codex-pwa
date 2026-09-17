import { uiText } from "./ui-copy.js";
export function createApiClient({
  getAuth = () => ({}),
  setConnection = () => {},
  onUnauthorized = () => {},
  fetchImpl = globalThis.fetch,
} = {}) {
  return async function api(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
    const headers = {
      "content-type": "application/json",
      ...(options.headers || {}),
    };
    const auth = getAuth() || {};
    if (![
      "GET", "HEAD", "OPTIONS",
    ].includes(method) && auth.csrfToken && !path.startsWith("/api/auth/login")) {
      headers["X-Codex-PWA-CSRF"] = auth.csrfToken;
    }
    let response;
    try {
      response = await fetchImpl(path, {
        ...options,
        credentials: "same-origin",
        headers,
      });
    } catch (error) {
      if (error.name !== "AbortError") error.message = uiText("api.networkFailure", error.message);
      error.isNetworkFailure = true;
      error.outcomeUnknown = mutating;
      if (error.name !== "AbortError" && auth.authenticated && !path.startsWith("/api/auth/")) setConnection("offline", error.message);
      throw error;
    }
    let payload;
    try {
      payload = await response.json();
      if (!payload || typeof payload !== "object") throw new Error(uiText("api.createApiClient.text3"));
    } catch {
      const error = new Error(mutating ? uiText("api.createApiClient.text2") : uiText("api.createApiClient.text"));
      error.statusCode = response.status;
      error.outcomeUnknown = mutating;
      throw error;
    }
    if (!response.ok) {
      if (response.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized(payload.error);
      const error = new Error(payload.error || uiText("api.httpFailure", response.status));
      error.statusCode = response.status;
      error.details = payload.details || null;
      error.outcomeUnknown = Boolean(payload.details?.outcomeUnknown);
      throw error;
    }
    return payload;
  };
}
