import { uiText } from "./public/ui-copy.js";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { contentDisposition, isPathWithinRoots } from "./file-access.mjs";
import { MAX_ARTIFACT_BYTES, normalizeImageArtifact, readRolloutArtifact, scanRolloutArtifacts } from "./artifact-store.mjs";
import { lruGet, lruSet } from "./bounded-cache.mjs";

export function createThreadArtifacts({
  codexHome,
  allowedThread
}) {
  const artifactIndexCache = new Map();
  const liveArtifacts = new Map();
  let liveArtifactCacheBytes = 0;
  const MAX_ARTIFACT_INDEX_CACHE_ENTRIES = 512;
  const MAX_LIVE_ARTIFACT_CACHE_BYTES = 96 * 1024 * 1024;
  const MAX_LIVE_ARTIFACT_CACHE_ENTRIES = 16;

  function liveArtifactKey(threadId, artifactId) {
    return `${threadId}:${artifactId}`;
  }

  function deleteLiveArtifact(key) {
    const existing = liveArtifacts.get(key);
    if (!existing) return false;
    liveArtifactCacheBytes -= existing.encodedBytes || 0;
    liveArtifacts.delete(key);
    return true;
  }

  function pruneLiveArtifacts() {
    while (
      liveArtifacts.size > MAX_LIVE_ARTIFACT_CACHE_ENTRIES
      || liveArtifactCacheBytes > MAX_LIVE_ARTIFACT_CACHE_BYTES
    ) {
      deleteLiveArtifact(liveArtifacts.keys().next().value);
    }
  }

  function registerLiveArtifact(threadId, turnId, item) {
    if (!threadId || item?.type !== "imageGeneration" || !item.result) return null;
    const metadata = normalizeImageArtifact(item, { turnId });
    if (!metadata) return null;
    const key = liveArtifactKey(threadId, metadata.id);
    const result = String(item.result);
    deleteLiveArtifact(key);
    const encodedBytes = Buffer.byteLength(result);
    liveArtifacts.set(key, { metadata, result, encodedBytes });
    liveArtifactCacheBytes += encodedBytes;
    pruneLiveArtifacts();
    return metadata;
  }

  function sanitizeNotificationForBrowser(message) {
    if (!new Set(["item/started", "item/completed"]).has(message?.method)) return message;
    const item = message.params?.item;
    if (item?.type !== "imageGeneration") return message;
    const metadata = registerLiveArtifact(message.params?.threadId, message.params?.turnId, item);
    return {
      ...message,
      params: {
        ...message.params,
        item: {
          ...item,
          result: "",
          artifact: metadata,
        },
      },
    };
  }

  async function resolveThreadRollout(thread) {
    const candidate = String(thread?.path || "");
    if (!candidate || !isAbsolute(candidate) || extname(candidate) !== ".jsonl") return null;
    let actual;
    try { actual = await realpath(candidate); } catch { return null; }
    if (!isPathWithinRoots(actual, [codexHome])) return null;
    const details = await stat(actual);
    return details.isFile() ? { actual, details } : null;
  }

  function publicArtifact(threadId, artifact) {
    const base = `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encodeURIComponent(artifact.id)}/raw`;
    return {
      ...artifact,
      previewUrl: base,
      downloadUrl: `${base}?download=1`,
    };
  }

  async function listThreadArtifacts(threadId, thread = null) {
    const allowed = thread || await allowedThread(threadId, false);
    const rollout = await resolveThreadRollout(allowed);
    let artifacts = [];
    if (rollout) {
      const cached = lruGet(artifactIndexCache, rollout.actual);
      const sameFile = cached
        && cached.dev === rollout.details.dev
        && cached.ino === rollout.details.ino;
      if (sameFile && cached.size === rollout.details.size && cached.mtimeMs === rollout.details.mtimeMs) {
        artifacts = cached.artifacts;
      } else {
        const canContinue = sameFile
          && rollout.details.size >= cached.scannedBytes
          && rollout.details.size > cached.size;
        const scan = await scanRolloutArtifacts(rollout.actual, canContinue
          ? {
              start: cached.scannedBytes,
              artifacts: cached.artifacts,
              activeTurnId: cached.activeTurnId,
            }
          : {});
        artifacts = scan.artifacts;
        lruSet(artifactIndexCache, rollout.actual, {
          size: scan.size,
          mtimeMs: scan.mtimeMs,
          dev: scan.dev,
          ino: scan.ino,
          artifacts,
          activeTurnId: scan.activeTurnId,
          scannedBytes: scan.scannedBytes,
        }, MAX_ARTIFACT_INDEX_CACHE_ENTRIES);
      }
      for (const artifact of artifacts) deleteLiveArtifact(liveArtifactKey(threadId, artifact.id));
    }
    const merged = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    for (const [key, live] of liveArtifacts) {
      if (!key.startsWith(`${threadId}:`)) continue;
      merged.set(live.metadata.id, live.metadata);
    }
    return [...merged.values()]
      .sort((left, right) => String(left.timestamp || "").localeCompare(String(right.timestamp || "")))
      .map((artifact) => publicArtifact(threadId, artifact));
  }

  async function readThreadArtifact(threadId, artifactId) {
    // Cached bytes must obey the current roots just like rollout-backed bytes.
    const thread = await allowedThread(threadId, false);
    const live = liveArtifacts.get(liveArtifactKey(threadId, artifactId));
    if (live) {
      const value = live.result.startsWith("data:") ? live.result.slice(live.result.indexOf(",") + 1) : live.result;
      const buffer = Buffer.from(value.replace(/\s+/g, ""), "base64");
      if (buffer.length && buffer.length <= MAX_ARTIFACT_BYTES) return { metadata: live.metadata, buffer };
    }
    const rollout = await resolveThreadRollout(thread);
    return rollout ? readRolloutArtifact(rollout.actual, artifactId) : null;
  }

  async function sendThreadArtifact(request, response, threadId, artifactId, url) {
    const artifact = await readThreadArtifact(threadId, artifactId);
    if (!artifact) {
      const error = new Error(uiText("artifactErrors.sendThreadArtifact.text"));
      error.statusCode = 404;
      throw error;
    }
    const download = url.searchParams.get("download") === "1";
    response.writeHead(200, {
      "cache-control": "private, no-store",
      "content-disposition": contentDisposition(artifact.metadata.name, download),
      "content-length": artifact.buffer.length,
      "content-security-policy": "sandbox",
      "content-type": artifact.metadata.mimeType,
    });
    if (request.method === "HEAD") response.end();
    else response.end(artifact.buffer);
  }


  return { sanitizeNotificationForBrowser, listThreadArtifacts, sendThreadArtifact };
}
