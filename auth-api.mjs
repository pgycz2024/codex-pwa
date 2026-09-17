import { uiText } from "./public/ui-copy.js";
import {
  DEVICE_COOKIE,
  deviceCookie,
  isUnsafeMethod,
  parseCookies,
} from "./auth-store.mjs";

export function createAuthApi({
  authStore,
  loginRateLimiter,
  globalLoginRateLimiter,
  codex,
  appVersion,
  sseClients,
  closeSseClient,
  closeDeviceStreams,
  closeOtherDeviceStreams,
  onSessionsChanged = async () => {},
  readBody,
  sendJson,
}) {
  function sendUnauthorized(response) {
    sendJson(response, 401, { error: uiText("authentication.sendUnauthorized.error"), authRequired: true });
  }

  function requestDeviceToken(request) {
    return parseCookies(request.headers.cookie || "")[DEVICE_COOKIE] || "";
  }

  async function authenticateRequest(request) {
    if (!authStore.enabled) return { kind: "disabled", session: { authenticated: true, csrfToken: null } };
    const token = requestDeviceToken(request);
    const session = await authStore.authenticateToken(token);
    return session ? { kind: "session", token, session } : null;
  }

  function requireCsrf(request, authentication) {
    if (!isUnsafeMethod(request.method) || authentication?.kind !== "session") return;
    if (!authStore.csrfMatches(authentication.session, request.headers["x-codex-pwa-csrf"])) {
      const error = new Error(uiText("authentication.requireCsrf.text"));
      error.statusCode = 403;
      throw error;
    }
  }

  function deviceLabel(userAgent) {
    const value = String(userAgent || "");
    if (/android/i.test(value)) return uiText("authentication.deviceLabel.text4");
    if (/iphone|ipad/i.test(value)) return "iPhone / iPad";
    if (/windows/i.test(value)) return uiText("authentication.deviceLabel.text3");
    if (/macintosh|mac os/i.test(value)) return uiText("authentication.deviceLabel.text2");
    return uiText("authentication.deviceLabel.text");
  }

  function loginRateLimitKey(request, username) {
    const address = String(request.socket?.remoteAddress || "unknown").slice(0, 128);
    const userAgent = String(request.headers["user-agent"] || "unknown").slice(0, 500);
    return `${address}\n${userAgent}\n${String(username || "").slice(0, 120)}`;
  }

  function credentialUsername(value, label = uiText("common.username")) {
    const normalized = String(value ?? "").trim();
    if (!normalized || normalized.length > 120 || /[\0-\x1f\x7f]/u.test(normalized)) {
      throw new Error(uiText("authentication.credentialUsername.text", label));
    }
    return normalized;
  }

  function credentialPassword(value, label = uiText("common.password")) {
    const normalized = String(value ?? "");
    if (normalized.length < 8 || normalized.length > 4_096 || /[\0\r\n]/u.test(normalized)) {
      throw new Error(uiText("authentication.credentialPassword.text", label));
    }
    return normalized;
  }

  async function handleAuthApi(request, response, url) {
    if (url.pathname === "/api/health" && request.method === "GET") {
      const ready = codex.status === "ready";
      sendJson(response, ready ? 200 : 503, { ok: ready, bridge: codex.status, version: appVersion });
      return true;
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      if (!authStore.enabled) {
        sendJson(response, 200, { authenticated: true, authEnabled: false, csrfToken: null });
        return true;
      }
      const body = await readBody(request);
      const username = String(body.username || "").slice(0, 120);
      const limiterKey = loginRateLimitKey(request, username);
      const retryAfter = Math.max(
        loginRateLimiter.retryAfterSeconds(limiterKey),
        globalLoginRateLimiter.retryAfterSeconds("instance"),
      );
      if (retryAfter) {
        sendJson(response, 429, { error: uiText("authentication.handleAuthApi.error7", retryAfter) }, { "retry-after": retryAfter });
        return true;
      }
      const password = String(body.password || "").slice(0, 4_096);
      if (!(await authStore.verifyCredentials(username, password))) {
        loginRateLimiter.recordFailure(limiterKey);
        globalLoginRateLimiter.recordFailure("instance");
        sendJson(response, 401, { error: uiText("authentication.handleAuthApi.error6"), authRequired: true });
        return true;
      }
      loginRateLimiter.reset(limiterKey);
      const remember = body.remember !== false;
      const userAgent = request.headers["user-agent"] || "";
      const created = await authStore.createSession({
        remember,
        userAgent,
        label: String(body.deviceLabel || deviceLabel(userAgent)).slice(0, 120),
      });
      sendJson(
        response,
        200,
        { ...created.session, username: await authStore.currentUsername(), authEnabled: true },
        { "set-cookie": deviceCookie(created.token, { remember }) },
      );
      return true;
    }

    if (url.pathname === "/api/auth/credentials/change" && request.method === "POST") {
      if (!authStore.enabled) {
        sendJson(response, 400, { error: uiText("authentication.handleAuthApi.error5") });
        return true;
      }
      const authentication = await authenticateRequest(request);
      if (authentication) requireCsrf(request, authentication);
      const body = await readBody(request);
      const currentUsername = String(body.currentUsername || "").slice(0, 120);
      const currentPassword = String(body.currentPassword || "").slice(0, 4_096);
      const rawNewUsername = String(body.newUsername ?? "").trim();
      const rawNewPassword = String(body.newPassword ?? "");
      if (!rawNewUsername && !rawNewPassword) throw new Error(uiText("devices.saveCredentials.textContent3"));
      const newUsername = rawNewUsername ? credentialUsername(rawNewUsername, uiText("authentication.handleAuthApi.credentialUsername")) : "";
      const newPassword = rawNewPassword ? credentialPassword(rawNewPassword, uiText("authentication.handleAuthApi.credentialPassword")) : "";
      const limiterKey = loginRateLimitKey(request, currentUsername);
      const retryAfter = Math.max(
        loginRateLimiter.retryAfterSeconds(limiterKey),
        globalLoginRateLimiter.retryAfterSeconds("instance"),
      );
      if (retryAfter) {
        sendJson(response, 429, { error: uiText("authentication.handleAuthApi.error4", retryAfter) }, { "retry-after": retryAfter });
        return true;
      }
      const changed = await authStore.changeCredentials({
        currentUsername,
        currentPassword,
        newUsername,
        newPassword,
      });
      if (!changed.ok) {
        if (changed.reason === "unchanged") {
          sendJson(response, 400, { error: uiText("authentication.handleAuthApi.error3") });
          return true;
        }
        loginRateLimiter.recordFailure(limiterKey);
        globalLoginRateLimiter.recordFailure("instance");
        sendJson(response, 401, { error: uiText("authentication.handleAuthApi.error2") });
        return true;
      }
      loginRateLimiter.reset(limiterKey);
      globalLoginRateLimiter.reset("instance");
      for (const client of [...sseClients.keys()]) closeSseClient(client);
      await onSessionsChanged();
      sendJson(
        response,
        200,
        { ok: true, username: changed.username, sessionsRevoked: true },
        { "set-cookie": deviceCookie("", { clear: true }) },
      );
      return true;
    }

    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      const authentication = await authenticateRequest(request);
      if (!authentication) {
        sendUnauthorized(response);
        return true;
      }
      sendJson(response, 200, {
        ...authentication.session,
        username: await authStore.currentUsername(),
        authenticated: true,
        authEnabled: authStore.enabled,
      });
      return true;
    }

    if (url.pathname === "/api/auth/devices" && request.method === "GET") {
      const authentication = await authenticateRequest(request);
      if (!authentication) {
        sendUnauthorized(response);
        return true;
      }
      const onlineIds = new Set([...sseClients.values()].map((client) => client.deviceId).filter(Boolean));
      const devices = (await authStore.listSessions(authentication.token || ""))
        .map((device) => ({ ...device, online: onlineIds.has(device.id) }));
      sendJson(response, 200, { devices, currentDeviceId: authentication.session?.id || null });
      return true;
    }

    const deviceMatch = url.pathname.match(/^\/api\/auth\/devices\/([^/]+)$/);
    if (deviceMatch && request.method === "PATCH") {
      const authentication = await authenticateRequest(request);
      if (!authentication) {
        sendUnauthorized(response);
        return true;
      }
      requireCsrf(request, authentication);
      const id = decodeURIComponent(deviceMatch[1]);
      const body = await readBody(request);
      const device = await authStore.renameSession(id, body.label);
      if (!device) {
        sendJson(response, 404, { error: uiText("authentication.handleAuthApi.error") });
        return true;
      }
      sendJson(response, 200, { device });
      return true;
    }

    if (deviceMatch && request.method === "DELETE") {
      const authentication = await authenticateRequest(request);
      if (!authentication) {
        sendUnauthorized(response);
        return true;
      }
      requireCsrf(request, authentication);
      const id = decodeURIComponent(deviceMatch[1]);
      const revoked = await authStore.revokeSession(id);
      if (!revoked) {
        sendJson(response, 404, { error: uiText("authentication.handleAuthApi.error") });
        return true;
      }
      closeDeviceStreams(id);
      await onSessionsChanged();
      const current = authentication.session?.id === id;
      sendJson(
        response,
        200,
        { ok: true, current },
        current ? { "set-cookie": deviceCookie("", { clear: true }) } : {},
      );
      return true;
    }

    if (url.pathname === "/api/auth/logout-others" && request.method === "POST") {
      const authentication = await authenticateRequest(request);
      if (!authentication) {
        sendUnauthorized(response);
        return true;
      }
      requireCsrf(request, authentication);
      const currentId = authentication.session?.id || "";
      const revokedIds = await authStore.revokeOthers(currentId);
      for (const id of revokedIds) closeDeviceStreams(id);
      closeOtherDeviceStreams(currentId);
      await onSessionsChanged();
      sendJson(response, 200, { ok: true, revoked: revokedIds.length });
      return true;
    }

    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const authentication = await authenticateRequest(request);
      if (!authentication) {
        sendUnauthorized(response);
        return true;
      }
      requireCsrf(request, authentication);
      if (authentication.kind === "session") {
        await authStore.revokeToken(authentication.token);
        closeDeviceStreams(authentication.session?.id);
        await onSessionsChanged();
      }
      sendJson(response, 200, { ok: true }, { "set-cookie": deviceCookie("", { clear: true }) });
      return true;
    }

    if (url.pathname === "/api/auth/logout-all" && request.method === "POST") {
      const authentication = await authenticateRequest(request);
      if (!authentication) {
        sendUnauthorized(response);
        return true;
      }
      requireCsrf(request, authentication);
      await authStore.revokeAll();
      for (const client of [...sseClients.keys()]) closeSseClient(client);
      await onSessionsChanged();
      sendJson(response, 200, { ok: true }, { "set-cookie": deviceCookie("", { clear: true }) });
      return true;
    }
    return false;
  }

  return { handleAuthApi, authenticateRequest, requireCsrf, sendUnauthorized };
}
