import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class EventReplayBuffer {
  constructor({ maxEvents = 512, maxBytes = 8 * 1024 * 1024, persistencePath = "" } = {}) {
    this.maxEvents = Math.max(1, Number(maxEvents) || 1);
    this.maxBytes = Math.max(1, Number(maxBytes) || 1);
    this.persistencePath = typeof persistencePath === "string" ? persistencePath.trim() : "";
    this.events = [];
    this.nextId = 1;
    this.bytes = 0;
    this.loadPersisted();
  }

  eventFromPayload(id, payload) {
    const frame = `id: ${id}\ndata: ${JSON.stringify(payload)}\n\n`;
    return { id, frame, bytes: Buffer.byteLength(frame) };
  }

  trim() {
    let removed = false;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const event = this.events.shift();
      this.bytes -= event?.bytes || 0;
      removed = true;
    }
    return removed;
  }

  loadPersisted() {
    if (!this.persistencePath) return;
    try {
      const contents = readFileSync(this.persistencePath, "utf8");
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (!Number.isSafeInteger(record?.id) || record.id < 1 || !Object.hasOwn(record, "payload")) continue;
          const event = this.eventFromPayload(record.id, record.payload);
          this.events.push(event);
          this.bytes += event.bytes;
          this.nextId = Math.max(this.nextId, record.id + 1);
        } catch {
          // Ignore a truncated final record after an interrupted write.
        }
      }
      if (this.trim()) this.persistSnapshot();
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`[sse-replay] Could not load persisted events: ${error.message}`);
    }
  }

  persistRecord(event, payload) {
    if (!this.persistencePath) return;
    mkdirSync(dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    appendFileSync(this.persistencePath, `${JSON.stringify({ id: event.id, payload })}\n`, { mode: 0o600 });
    chmodSync(this.persistencePath, 0o600);
  }

  persistSnapshot() {
    if (!this.persistencePath) return;
    mkdirSync(dirname(this.persistencePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.persistencePath}.${process.pid}.tmp`;
    const contents = this.events.map((event) => {
      const payload = JSON.parse(event.frame.slice(event.frame.indexOf("data: ") + 6, -2));
      return JSON.stringify({ id: event.id, payload });
    }).join("\n");
    writeFileSync(temporaryPath, contents ? `${contents}\n` : "", { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.persistencePath);
  }

  append(payload) {
    const id = this.nextId++;
    const event = this.eventFromPayload(id, payload);
    this.events.push(event);
    this.bytes += event.bytes;
    const removed = this.trim();
    if (this.persistencePath) {
      if (removed) this.persistSnapshot();
      else this.persistRecord(event, payload);
    }
    return event;
  }

  after(afterId = 0) {
    const normalized = Number.isSafeInteger(afterId) && afterId > 0 ? afterId : 0;
    const oldestId = this.events[0]?.id || null;
    return {
      gap: Boolean(normalized && oldestId && oldestId > normalized + 1),
      oldestId,
      events: this.events.filter((event) => event.id > normalized),
    };
  }

  snapshot() {
    return {
      persistent: Boolean(this.persistencePath),
      count: this.events.length,
      bytes: this.bytes,
      oldestId: this.events[0]?.id || null,
      newestId: this.events.at(-1)?.id || null,
      maxEvents: this.maxEvents,
      maxBytes: this.maxBytes,
    };
  }
}
