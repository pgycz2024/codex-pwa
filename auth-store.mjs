import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEVICE_COOKIE = "codex_pwa_device";
export const TRUSTED_DEVICE_DAYS = 90;
const SESSION_ONLY_HOURS = 12;

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(left, right) {
  const leftBuffer = createHash("sha256").update(String(left)).digest();
  const rightBuffer = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || Object.hasOwn(cookies, name)) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function deviceCookie(token, { remember = true, clear = false } = {}) {
  const attributes = [
    `${DEVICE_COOKIE}=${clear ? "" : encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
  ];
  if (clear) attributes.push("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  else if (remember) attributes.push(`Max-Age=${TRUSTED_DEVICE_DAYS * 24 * 60 * 60}`);
  return attributes.join("; ");
}

export function isUnsafeMethod(method) {
  return !new Set(["GET", "HEAD", "OPTIONS"]).has(String(method || "GET").toUpperCase());
}

export class LoginRateLimiter {
  constructor({ maxFailures = 10, windowMs = 10 * 60 * 1000, maxKeys = 512 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.failures = new Map();
  }

  prune(key = "default", now = Date.now()) {
    const failures = (this.failures.get(key) || []).filter((timestamp) => now - timestamp < this.windowMs);
    this.failures.delete(key);
    if (failures.length) this.failures.set(key, failures);
    return failures;
  }

  retryAfterSeconds(key = "default", now = Date.now()) {
    const failures = this.prune(key, now);
    if (failures.length < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((failures[0] + this.windowMs - now) / 1000));
  }

  recordFailure(key = "default", now = Date.now()) {
    const failures = this.prune(key, now);
    failures.push(now);
    this.failures.set(key, failures);
    while (this.failures.size > this.maxKeys) this.failures.delete(this.failures.keys().next().value);
  }

  reset(key = "default") {
    this.failures.delete(key);
  }
}

export class TrustedDeviceStore {
  constructor({ passwordFile = "", sessionFile = "", username = "codex" } = {}) {
    this.passwordFile = passwordFile;
    this.sessionFile = sessionFile;
    this.username = username;
    this.queue = Promise.resolve();
  }

  get enabled() {
    return Boolean(this.passwordFile);
  }

  async currentPassword() {
    if (!this.enabled) return "";
    return (await readFile(this.passwordFile, "utf8")).trim();
  }

  async verifyCredentials(username, password) {
    if (!this.enabled) return true;
    const expectedPassword = await this.currentPassword();
    return safeEqual(username, this.username) && safeEqual(password, expectedPassword);
  }

  async passwordDigest() {
    return sha256(await this.currentPassword());
  }

  async withLock(action) {
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => {});
    return run;
  }

  async readState() {
    if (!this.sessionFile) return { version: 2, sessions: [] };
    try {
      const parsed = JSON.parse(await readFile(this.sessionFile, "utf8"));
      return {
        version: 2,
        sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [],
      };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 2, sessions: [] };
      throw error;
    }
  }

  async writeState(state) {
    if (!this.sessionFile) return;
    const directory = dirname(this.sessionFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${this.sessionFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.sessionFile);
    await chmod(this.sessionFile, 0o600);
  }

  async pruneState(state, now = Date.now()) {
    const passwordDigest = await this.passwordDigest();
    let changed = false;
    const sessions = [];
    for (const rawSession of state.sessions) {
      if (!(Number(rawSession.expiresAt) > now && safeEqual(rawSession.passwordDigest, passwordDigest))) {
        changed = true;
        continue;
      }
      const session = { ...rawSession };
      if (!session.id) {
        session.id = randomBytes(12).toString("base64url");
        changed = true;
      }
      sessions.push(session);
    }
    return { state: { version: 2, sessions }, changed };
  }

  async createSession({ userAgent = "", label = "", remember = true } = {}) {
    return this.withLock(async () => {
      const now = Date.now();
      const token = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(24).toString("base64url");
      const loaded = await this.readState();
      const { state } = await this.pruneState(loaded, now);
      const expiresAt = now + (remember ? TRUSTED_DEVICE_DAYS * 24 * 60 * 60 * 1000 : SESSION_ONLY_HOURS * 60 * 60 * 1000);
      const session = {
        id: randomBytes(12).toString("base64url"),
        tokenHash: sha256(token),
        csrfToken,
        createdAt: now,
        expiresAt,
        lastUsedAt: now,
        remembered: Boolean(remember),
        label: String(label || "此设备").slice(0, 120),
        userAgent: String(userAgent || "").slice(0, 500),
        passwordDigest: await this.passwordDigest(),
      };
      state.sessions.push(session);
      state.sessions = state.sessions.slice(-100);
      await this.writeState(state);
      return { token, session: this.publicSession(session) };
    });
  }

  publicSession(session) {
    return {
      authenticated: true,
      csrfToken: session.csrfToken,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      remembered: Boolean(session.remembered),
      label: session.label || "此设备",
      id: session.id,
      lastUsedAt: session.lastUsedAt,
    };
  }

  publicDevice(session, currentTokenHash = "") {
    return {
      id: session.id,
      label: session.label || "此设备",
      userAgent: session.userAgent || "",
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastUsedAt: session.lastUsedAt,
      remembered: Boolean(session.remembered),
      current: Boolean(currentTokenHash && safeEqual(session.tokenHash, currentTokenHash)),
    };
  }

  async authenticateToken(token) {
    if (!token) return null;
    return this.withLock(async () => {
      const now = Date.now();
      const loaded = await this.readState();
      const pruned = await this.pruneState(loaded, now);
      const tokenHash = sha256(token);
      const session = pruned.state.sessions.find((candidate) => safeEqual(candidate.tokenHash, tokenHash));
      let changed = pruned.changed;
      if (session && now - Number(session.lastUsedAt || 0) >= 60 * 60 * 1000) {
        session.lastUsedAt = now;
        changed = true;
      }
      if (changed) await this.writeState(pruned.state);
      return session ? this.publicSession(session) : null;
    });
  }

  csrfMatches(session, supplied) {
    return Boolean(session?.csrfToken && supplied && safeEqual(session.csrfToken, supplied));
  }

  async revokeToken(token) {
    if (!token) return false;
    return this.withLock(async () => {
      const loaded = await this.readState();
      const tokenHash = sha256(token);
      const sessions = loaded.sessions.filter((session) => !safeEqual(session.tokenHash, tokenHash));
      if (sessions.length === loaded.sessions.length) return false;
      await this.writeState({ version: 2, sessions });
      return true;
    });
  }

  async listSessions(currentToken = "") {
    return this.withLock(async () => {
      const loaded = await this.readState();
      const pruned = await this.pruneState(loaded);
      if (pruned.changed) await this.writeState(pruned.state);
      const currentTokenHash = currentToken ? sha256(currentToken) : "";
      return pruned.state.sessions
        .map((session) => this.publicDevice(session, currentTokenHash))
        .sort((left, right) => Number(right.lastUsedAt || 0) - Number(left.lastUsedAt || 0));
    });
  }

  async renameSession(id, label) {
    return this.withLock(async () => {
      const loaded = await this.readState();
      const pruned = await this.pruneState(loaded);
      const session = pruned.state.sessions.find((candidate) => candidate.id === id);
      if (!session) return null;
      session.label = String(label || "此设备").trim().slice(0, 120) || "此设备";
      await this.writeState(pruned.state);
      return this.publicDevice(session);
    });
  }

  async revokeSession(id) {
    return this.withLock(async () => {
      const loaded = await this.readState();
      const pruned = await this.pruneState(loaded);
      const sessions = pruned.state.sessions.filter((session) => session.id !== id);
      if (sessions.length === pruned.state.sessions.length) {
        if (pruned.changed) await this.writeState(pruned.state);
        return false;
      }
      await this.writeState({ version: 2, sessions });
      return true;
    });
  }

  async revokeOthers(currentId) {
    return this.withLock(async () => {
      const loaded = await this.readState();
      const pruned = await this.pruneState(loaded);
      const sessions = pruned.state.sessions.filter((session) => session.id === currentId);
      const revokedIds = pruned.state.sessions.filter((session) => session.id !== currentId).map((session) => session.id);
      await this.writeState({ version: 2, sessions });
      return revokedIds;
    });
  }

  async revokeAll() {
    return this.withLock(async () => {
      await this.writeState({ version: 2, sessions: [] });
    });
  }
}
