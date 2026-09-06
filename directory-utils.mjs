import { basename, join, relative, sep } from "node:path";

export function validateDirectoryName(value) {
  const name = String(value || "").normalize("NFC").trim();
  if (!name) return { ok: false, error: "Directory name is required" };
  if (name === "." || name === "..") return { ok: false, error: "Directory name cannot be . or .." };
  if (/[\/\\]/.test(name)) return { ok: false, error: "Directory name cannot contain slashes" };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: "Directory name contains control characters" };
  if (Buffer.byteLength(name) > 200) return { ok: false, error: "Directory name is too long" };
  return { ok: true, name };
}

export function directoryBreadcrumbs(directory, roots) {
  const root = [...roots]
    .filter((candidate) => directory === candidate || directory.startsWith(`${candidate}${sep}`))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return [];
  const crumbs = [{ name: basename(root) || root, path: root }];
  const remainder = relative(root, directory);
  if (!remainder) return crumbs;
  let current = root;
  for (const segment of remainder.split(sep).filter(Boolean)) {
    current = join(current, segment);
    crumbs.push({ name: segment, path: current });
  }
  return crumbs;
}
