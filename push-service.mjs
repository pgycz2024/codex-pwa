import { createECDH, createHash, ECDH, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import webPush from "web-push";
import { TASK_NOTICE_COPY, turnOutcomeCopy } from "./public/status-display.js";

const MAX_DEVICES = 100;
const MAX_RECEIPTS = 1024;
const RECEIPT_TTL = 10 * 60_000;
const MESSAGE_TTL = 5 * 60_000;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 160;

function decodeKey(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail("推送密钥格式无效");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value) throw fail("推送密钥长度无效");
  return bytes;
}

export function validatePushSubscription(value) {
  if (typeof value?.endpoint !== "string" || value.endpoint.length > 4096) throw fail("推送地址无效");
  let url;
  try { url = new URL(value.endpoint); } catch { throw fail("推送地址无效"); }
  // A trusted device still must not turn the server into an arbitrary HTTP client.
  const provider = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(url.hostname)
    || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
  if (!provider || url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw fail("推送地址必须属于受支持浏览器的 HTTPS 推送服务");
  }
  const publicKey = decodeKey(value.keys?.p256dh, 65);
  decodeKey(value.keys?.auth, 16);
  try { ECDH.convertKey(publicKey, "prime256v1"); } catch { throw fail("浏览器推送公钥无效"); }
  return { endpoint: url.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

export function validateVapidConfiguration(value) {
  const publicKey = decodeKey(value?.publicKey, 65);
  const privateKey = decodeKey(value?.privateKey, 32);
  const key = createECDH("prime256v1");
  key.setPrivateKey(privateKey);
  if (!key.getPublicKey().equals(publicKey)) throw fail("推送服务器密钥不匹配");
  // The maintained library checks the VAPID subject and JWT signing parameters.
  webPush.getVapidHeaders("https://fcm.googleapis.com", value.subject, value.publicKey, value.privateKey, "aes128gcm");
  let proxy;
  if (value.proxy !== undefined && value.proxy !== "") {
    if (typeof value.proxy !== "string" || value.proxy.length > 2048 || /[\s\x00-\x1f\x7f]/u.test(value.proxy)) throw fail("推送代理配置无效");
    let url;
    try { url = new URL(value.proxy); } catch { throw fail("推送代理配置无效"); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.pathname !== "/" || url.search || url.hash) throw fail("推送代理配置无效");
    // Only the private operator configuration may choose a proxy. Device
    // subscription endpoints remain restricted to HTTPS vendor services.
    proxy = url.href;
  }
  return { subject: value.subject, publicKey: value.publicKey, privateKey: value.privateKey, ...(proxy ? { proxy } : {}) };
}

function noticeFor(payload, now) {
  if (payload?.kind === "bridge/taskRecovered") {
    return noticeFor({ kind: "app-server/notification", message: { method: "turn/completed",
      params: { threadId: payload.threadId, turn: { id: payload.turnId, status: payload.status } } } }, now);
  }
  const message = payload?.message;
  const params = payload?.kind === "app-server/request" ? payload.params : message?.params;
  const threadId = params?.threadId;
  if (!validId(threadId)) return null;
  if (payload.kind === "app-server/request" && validId(String(payload.requestId ?? ""))) {
    const requestToken = typeof payload.requestToken === "string" ? payload.requestToken : "";
    return { threadId, requestId: String(payload.requestId), requestToken, at: now,
      key: `request:${threadId}:${payload.requestId}:${requestToken}`,
      ...TASK_NOTICE_COPY.waiting };
  }
  if (payload.kind !== "app-server/notification" || message?.method !== "turn/completed" || !validId(params.turn?.id)) return null;
  const status = params.turn.status;
  const copy = turnOutcomeCopy(status);
  if (!copy) return null;
  return { threadId, at: now, key: `turn:${threadId}:${params.turn.id}:${status}`,
    title: copy.title, body: copy.body };
}

export class PushService {
  constructor({ authStore, configFile = "", storeFile = "", readThread,
    isRequestPending = () => true, sendNotification = (...args) => webPush.sendNotification(...args), now = () => Date.now(), retryDelay = delay } = {}) {
    Object.assign(this, { authStore, configFile, storeFile, readThread, isRequestPending, sendNotification, now, retryDelay });
    this.config = null;
    this.reason = "服务器尚未配置后台推送";
    this.state = { version: 1, subscriptions: [], receipts: [] };
    this.lock = Promise.resolve();
    this.events = Promise.resolve();
    this.queued = 0;
  }

  async initialize() {
    this.initialized ||= (async () => {
      if (!this.authStore?.enabled) { this.reason = "后台推送需要启用可信设备登录"; return; }
      if (!this.configFile || !this.storeFile) return;
      try {
        const details = await stat(this.configFile);
        if (!details.isFile() || details.size > 16_384 || (details.mode & 0o077)) throw new Error("private configuration required");
        const config = validateVapidConfiguration(JSON.parse(await readFile(this.configFile, "utf8")));
        try {
          if ((await stat(this.storeFile)).size > 1024 * 1024) throw new Error("oversized push store");
          const state = JSON.parse(await readFile(this.storeFile, "utf8"));
          if (state.version !== 1 || !Array.isArray(state.subscriptions) || !Array.isArray(state.receipts)) throw new Error("invalid push store");
          for (const record of state.subscriptions.slice(-MAX_DEVICES)) {
            if (!validId(record.deviceId)) continue;
            try { this.state.subscriptions.push({ ...record, subscription: validatePushSubscription(record.subscription) }); } catch {}
          }
          this.state.receipts = state.receipts.filter((item) => /^[a-f0-9]{64}$/.test(item?.key || "") && Number.isFinite(item.at)).slice(-MAX_RECEIPTS);
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        this.config = config;
        this.reason = null;
      } catch {
        this.reason = "后台推送配置或存储不可用，请检查文件和权限";
      }
    })();
    return this.initialized;
  }

  async withState(action) {
    await this.initialize();
    const transactional = async () => {
      const previous = structuredClone(this.state);
      try { return await action(); }
      catch (error) { this.state = previous; throw error; }
    };
    const run = this.lock.then(transactional, transactional);
    this.lock = run.catch(() => {});
    return run;
  }

  async persist() {
    await mkdir(dirname(this.storeFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.storeFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      await rename(temporary, this.storeFile);
      await chmod(this.storeFile, 0o600);
    } finally { await rm(temporary, { force: true }); }
  }

  async prune() {
    const active = new Set((await this.authStore.listSessions()).map(({ id }) => id));
    const subscriptions = this.state.subscriptions.filter(({ deviceId }) => active.has(deviceId));
    const now = this.now();
    const receipts = this.state.receipts.filter(({ at }) => at <= now && now - at < RECEIPT_TTL).slice(-MAX_RECEIPTS);
    const changed = subscriptions.length !== this.state.subscriptions.length || receipts.length !== this.state.receipts.length;
    this.state = { version: 1, subscriptions, receipts };
    if (changed) await this.persist();
    return active;
  }

  async reconcile() {
    return this.withState(async () => { if (this.config) await this.prune(); });
  }

  async status(deviceId) {
    return this.withState(async () => {
      if (!this.config) return { configured: false, subscribed: false, reason: this.reason };
      await this.prune();
      const record = this.state.subscriptions.find((entry) => entry.deviceId === deviceId);
      return { configured: true, publicKey: this.config.publicKey, subscribed: Boolean(record),
        delivery: record?.delivery || null };
    });
  }

  async subscribe(deviceId, value) {
    const subscription = validatePushSubscription(value);
    await this.withState(async () => {
      if (!this.config) throw fail(this.reason, 503);
      const active = await this.prune();
      if (!active.has(deviceId)) throw fail("请重新登录后开启后台推送", 401);
      this.state.subscriptions = this.state.subscriptions.filter((entry) => entry.deviceId !== deviceId
        && entry.subscription.endpoint !== subscription.endpoint);
      this.state.subscriptions.push({ deviceId, subscription, updatedAt: this.now(), delivery: null });
      this.state.subscriptions = this.state.subscriptions.slice(-MAX_DEVICES);
      await this.persist();
    });
    return this.status(deviceId);
  }

  async unsubscribe(deviceId) {
    await this.withState(async () => {
      if (!this.config) return;
      this.state.subscriptions = this.state.subscriptions.filter((entry) => entry.deviceId !== deviceId);
      await this.persist();
    });
    return { subscribed: false };
  }

  enqueue(payload) {
    const notice = noticeFor(payload, this.now());
    if (!notice || this.queued >= 128) return Promise.resolve();
    this.queued += 1;
    const job = this.events.then(() => this.deliver(notice));
    this.events = job.catch(() => { /* Errors never block SSE or expose provider response bodies. */ }).finally(() => { this.queued -= 1; });
    return this.events;
  }

  relevant(notice) {
    return !this.closed && this.now() - notice.at < MESSAGE_TTL && (!notice.requestId || this.isRequestPending(notice.requestId, notice.threadId, notice.requestToken));
  }

  close() { this.closed = true; }

  async deliver(notice) {
    await this.initialize();
    if (!this.config || !this.relevant(notice)) return;
    const devices = await this.withState(async () => {
      await this.prune();
      return this.state.subscriptions.map(({ deviceId }) => deviceId);
    });
    if (!devices.length) return;
    let index = 0;
    // A slow push service cannot create unbounded concurrent network requests.
    await Promise.all(Array.from({ length: Math.min(4, devices.length) }, async () => {
      while (index < devices.length) await this.deliverTo(devices[index++], notice);
    }));
  }

  async deliverTo(deviceId, notice, attempt = 0) {
    if (!this.relevant(notice)) return;
    // Revalidate the live root policy immediately before dispatch, without subscribing.
    try { await this.readThread(notice.threadId); } catch { return; }
    const receiptKey = digest(`${deviceId}:${notice.key}`);
    const target = await this.withState(async () => {
      await this.prune();
      if (!this.relevant(notice) || this.state.receipts.some(({ key }) => key === receiptKey)) return null;
      return this.state.subscriptions.find((entry) => entry.deviceId === deviceId)?.subscription;
    });
    if (!target) return;
    let statusCode = 0;
    let succeeded = false;
    try {
      const { proxy, ...vapidDetails } = this.config;
      await this.sendNotification(target, JSON.stringify({ threadId: notice.threadId, title: notice.title,
        body: notice.body, eventKey: digest(notice.key) }), {
        vapidDetails, ...(proxy ? { proxy } : {}), TTL: 300, urgency: "normal", timeout: 10_000, contentEncoding: "aes128gcm",
      });
      succeeded = true;
    } catch (error) {
      statusCode = Number.isInteger(error.statusCode) && error.statusCode >= 100 && error.statusCode <= 599 ? error.statusCode : 0;
      if (attempt === 0 && (statusCode === 0 || statusCode === 429 || statusCode >= 500)) {
        const retryAfter = error.headers?.["retry-after"];
        const seconds = /^\d+$/.test(String(retryAfter || "")) ? Number(retryAfter)
          : retryAfter ? (Date.parse(retryAfter) - Date.now()) / 1000 : 1;
        if (Number.isFinite(seconds) && seconds <= 30 && this.relevant(notice)) {
          await this.retryDelay(Math.max(1000, seconds * 1000));
          return this.deliverTo(deviceId, notice, attempt + 1);
        }
      }
    }
    await this.withState(async () => {
      const record = this.state.subscriptions.find((entry) => entry.deviceId === deviceId && entry.subscription.endpoint === target.endpoint);
      if (!record) return;
      if ([404, 410].includes(statusCode)) this.state.subscriptions = this.state.subscriptions.filter((entry) => entry !== record);
      else record.delivery = { attemptedAt: this.now(), ok: succeeded, statusCode,
        lastSuccessAt: succeeded ? this.now() : record.delivery?.lastSuccessAt || null };
      if (succeeded) {
        this.state.receipts.push({ key: receiptKey, at: this.now() });
        this.state.receipts = this.state.receipts.slice(-MAX_RECEIPTS);
      }
      await this.persist();
    });
  }
}
