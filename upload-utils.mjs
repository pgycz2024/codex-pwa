import { basename, extname } from "node:path";

function truncateUtf8(value, maxBytes) {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

export function safeUploadFilename(filename, maxBytes = 180) {
  const leaf = basename(String(filename || "").replaceAll("\\", "/"))
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  let normalized = leaf && !/^\.+$/.test(leaf) ? leaf : "uploaded-file";
  if (normalized.startsWith(".codex-pwa-upload-")) normalized = `uploaded-${normalized.slice(18)}`;

  const extension = extname(normalized);
  const safeExtension = truncateUtf8(extension, Math.min(40, maxBytes - 1));
  const stem = extension ? normalized.slice(0, -extension.length) : normalized;
  const safeStem = truncateUtf8(stem, Math.max(1, maxBytes - Buffer.byteLength(safeExtension)));
  return `${safeStem || "uploaded-file"}${safeExtension}`;
}

export function numberedUploadFilename(filename, number) {
  if (!number) return filename;
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem}-${number + 1}${extension}`;
}
