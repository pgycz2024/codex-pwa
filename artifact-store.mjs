import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import readline from "node:readline";

export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const MAX_JSONL_LINE_CHARS = Math.ceil(MAX_ARTIFACT_BYTES * 1.45) + 256 * 1024;
const ROLLOUT_TAIL_CHUNK_BYTES = 64 * 1024;

async function completeLineOffset(rolloutPath, size) {
  if (!size) return 0;
  const handle = await open(rolloutPath, "r");
  try {
    const finalByte = Buffer.allocUnsafe(1);
    const finalRead = await handle.read(finalByte, 0, 1, size - 1);
    if (finalRead.bytesRead === 1 && finalByte[0] === 0x0a) return size;

    // Keep the final unterminated line eligible for the next incremental scan.
    // Codex normally appends one complete JSON object at a time, but a reader can
    // still catch the file between writes.
    const searchFloor = Math.max(0, size - (MAX_JSONL_LINE_CHARS * 4));
    let cursor = size;
    while (cursor > searchFloor) {
      const start = Math.max(searchFloor, cursor - ROLLOUT_TAIL_CHUNK_BYTES);
      const buffer = Buffer.allocUnsafe(cursor - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      cursor = start;
    }
    // An oversized unterminated line can never pass MAX_JSONL_LINE_CHARS, so it
    // is safe to advance rather than repeatedly rescanning hundreds of MiB.
    return searchFloor === 0 ? 0 : size;
  } finally {
    await handle.close();
  }
}

function cleanBase64(value) {
  const text = String(value || "");
  const comma = text.startsWith("data:") ? text.indexOf(",") : -1;
  return (comma >= 0 ? text.slice(comma + 1) : text).replace(/\s+/g, "");
}

export function decodedBase64Size(value) {
  const text = cleanBase64(value);
  if (!text) return 0;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

export function imagePresentationFromBase64(value) {
  const sample = Buffer.from(cleanBase64(value).slice(0, 48), "base64");
  if (sample.length >= 8 && sample.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: ".png" };
  }
  if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }
  if (sample.length >= 12 && sample.subarray(0, 4).toString("ascii") === "RIFF" && sample.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", extension: ".webp" };
  }
  if (sample.length >= 6 && /^GIF8[79]a$/.test(sample.subarray(0, 6).toString("ascii"))) {
    return { mimeType: "image/gif", extension: ".gif" };
  }
  return { mimeType: "image/png", extension: ".png" };
}

export function normalizeImageArtifact(item = {}, { timestamp = null, turnId = null } = {}) {
  const result = String(item.result || "");
  if (!item.id || !result) return null;
  const byteLength = decodedBase64Size(result);
  if (!byteLength || byteLength > MAX_ARTIFACT_BYTES) return null;
  const presentation = imagePresentationFromBase64(result);
  const shortId = String(item.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(-12) || "image";
  return {
    id: String(item.id),
    type: "image",
    status: result ? "completed" : String(item.status || "inProgress"),
    mimeType: presentation.mimeType,
    extension: presentation.extension,
    byteLength,
    revisedPrompt: String(item.revisedPrompt || item.revised_prompt || "").slice(0, 8_000),
    savedPath: item.savedPath || item.saved_path || null,
    timestamp,
    turnId,
    name: `generated-image-${shortId}${presentation.extension}`,
  };
}

function imagePayload(parsed) {
  if (parsed?.type !== "response_item") return null;
  const payload = parsed.payload;
  return payload?.type === "image_generation_call" ? payload : null;
}

export async function scanRolloutArtifacts(
  rolloutPath,
  { start = 0, artifacts: existingArtifacts = [], activeTurnId: initialTurnId = null } = {},
) {
  const details = await stat(rolloutPath);
  const safeStart = Number.isSafeInteger(start) && start >= 0 && start <= details.size ? start : 0;
  const artifacts = new Map(existingArtifacts.map((artifact) => [artifact.id, artifact]));
  let activeTurnId = initialTurnId;
  if (details.size > safeStart) {
    const input = createReadStream(rolloutPath, {
      encoding: "utf8",
      start: safeStart,
      end: details.size - 1,
    });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line || line.length > MAX_JSONL_LINE_CHARS) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed?.type === "event_msg" && parsed.payload?.type === "task_started") {
        activeTurnId = parsed.payload.turn_id || parsed.payload.turnId || null;
        continue;
      }
      const payload = imagePayload(parsed);
      if (!payload?.result) continue;
      const artifact = normalizeImageArtifact(payload, {
        timestamp: parsed.timestamp || null,
        turnId: activeTurnId,
      });
      if (artifact) artifacts.set(artifact.id, artifact);
    }
  }
  return {
    artifacts: [...artifacts.values()],
    activeTurnId,
    scannedBytes: await completeLineOffset(rolloutPath, details.size),
    size: details.size,
    mtimeMs: details.mtimeMs,
    dev: details.dev,
    ino: details.ino,
  };
}

export async function listRolloutArtifacts(rolloutPath) {
  return (await scanRolloutArtifacts(rolloutPath)).artifacts;
}

export async function readRolloutArtifact(rolloutPath, artifactId) {
  const input = createReadStream(rolloutPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line || line.length > MAX_JSONL_LINE_CHARS) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const payload = imagePayload(parsed);
    if (String(payload?.id || "") !== String(artifactId) || !payload?.result) continue;
    const metadata = normalizeImageArtifact(payload, { timestamp: parsed.timestamp || null });
    if (!metadata) return null;
    const buffer = Buffer.from(cleanBase64(payload.result), "base64");
    if (!buffer.length || buffer.length > MAX_ARTIFACT_BYTES) return null;
    return { metadata, buffer };
  }
  return null;
}
