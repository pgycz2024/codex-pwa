import { realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve, sep } from "node:path";

const rasterImages = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);

const mediaFiles = new Map([
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
]);

const textExtensions = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".css", ".csv", ".go", ".h", ".hpp",
  ".diff", ".ini", ".ipynb", ".java", ".js", ".json", ".jsonl", ".log", ".md", ".mjs", ".patch", ".py", ".r",
  ".rs", ".sh", ".sql", ".tex", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

export function isPathWithinRoots(candidate, roots) {
  if (!candidate || typeof candidate !== "string") return false;
  const resolved = resolve(candidate);
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${sep}`));
}

export async function isCanonicalPathWithinRoots(candidate, roots, { allowMissing = false } = {}) {
  if (!candidate || typeof candidate !== "string" || !isAbsolute(candidate) || !isPathWithinRoots(candidate, roots)) {
    return false;
  }
  let probe = resolve(candidate);
  while (true) {
    try {
      return isPathWithinRoots(await realpath(probe), roots);
    } catch (error) {
      if (!allowMissing || (error?.code !== "ENOENT" && error?.code !== "ENOTDIR")) return false;
      const parent = dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

export function filePresentation(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".pdf") {
    return { extension, mimeType: "application/pdf", previewKind: "pdf", inline: true };
  }
  if (rasterImages.has(extension)) {
    return { extension, mimeType: rasterImages.get(extension), previewKind: "image", inline: true };
  }
  if (mediaFiles.has(extension)) {
    return { extension, mimeType: mediaFiles.get(extension), previewKind: "media", inline: true };
  }
  if (extension === ".md" || extension === ".markdown") {
    return { extension, mimeType: "text/markdown; charset=utf-8", previewKind: "markdown", inline: true };
  }
  if (textExtensions.has(extension)) {
    return { extension, mimeType: "text/plain; charset=utf-8", previewKind: "text", inline: true };
  }
  return { extension, mimeType: "application/octet-stream", previewKind: "download", inline: false };
}

export function parseByteRange(header, size) {
  if (!header) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return { kind: "invalid" };

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: "invalid" };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return { kind: "invalid" };
    }
    end = Math.min(end, size - 1);
  }

  return { kind: "range", start, end };
}

function encodedFilename(filename) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

export function contentDisposition(filePath, download = false) {
  const filename = basename(filePath) || "file";
  const fallback = filename
    .replace(/[^\x20-\x7e]+/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 160) || "file";
  return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encodedFilename(filename)}`;
}
