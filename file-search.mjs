import { readdir, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { filePresentation } from "./file-access.mjs";

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_DIRECTORIES = 2_000;
const DEFAULT_MAX_DEPTH = 32;

function visibleEntry(entry, showHidden, sensitiveEntryName) {
  if (showHidden) return true;
  return !entry.name.startsWith(".") && !sensitiveEntryName(entry.name);
}

/**
 * Search a bounded subtree without following symbolic links. Results retain
 * the searched root and relative path so the UI can explain where a match was
 * found while still using the canonical absolute path for subsequent actions.
 */
export async function searchAllowedFiles({
  roots = [],
  query,
  showHidden = false,
  maxResults = DEFAULT_MAX_RESULTS,
  maxDirectories = DEFAULT_MAX_DIRECTORIES,
  maxDepth = DEFAULT_MAX_DEPTH,
  sensitiveEntryName = () => false,
} = {}) {
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase("zh-CN").slice(0, 160);
  if (!normalizedQuery) return { query: "", results: [], truncated: false, visitedDirectories: 0 };
  const boundedResults = Number.isSafeInteger(maxResults) && maxResults > 0
    ? Math.min(maxResults, 500)
    : DEFAULT_MAX_RESULTS;
  const boundedDirectories = Number.isSafeInteger(maxDirectories) && maxDirectories > 0
    ? Math.min(maxDirectories, 10_000)
    : DEFAULT_MAX_DIRECTORIES;
  const boundedDepth = Number.isSafeInteger(maxDepth) && maxDepth >= 0
    ? Math.min(maxDepth, 64)
    : DEFAULT_MAX_DEPTH;
  const queue = [...new Set((Array.isArray(roots) ? roots : []).filter(Boolean))]
    .map((root) => ({ path: root, root, depth: 0 }));
  const visited = new Set();
  const results = [];
  let truncated = false;

  while (queue.length && results.length < boundedResults && visited.size < boundedDirectories) {
    const current = queue.shift();
    if (visited.has(current.path)) continue;
    visited.add(current.path);
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOENT") continue;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
    for (const entry of entries) {
      if (!visibleEntry(entry, showHidden, sensitiveEntryName)) continue;
      const path = `${current.path}${current.path.endsWith(sep) ? "" : sep}${entry.name}`;
      const matches = entry.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
      if (entry.isDirectory()) {
        if (matches) {
          results.push({
            name: entry.name,
            path,
            root: current.root,
            relativePath: relative(current.root, path).split(sep).join("/"),
            type: "directory",
            hidden: entry.name.startsWith("."),
            sensitive: sensitiveEntryName(entry.name),
          });
          if (results.length >= boundedResults) break;
        }
        if (current.depth < boundedDepth && visited.size + queue.length < boundedDirectories) {
          queue.push({ path, root: current.root, depth: current.depth + 1 });
        } else {
          truncated = true;
        }
        continue;
      }
      if (!entry.isFile() || !matches) continue;
      try {
        const details = await stat(path);
        const presentation = filePresentation(path);
        results.push({
          name: entry.name,
          path,
          root: current.root,
          relativePath: relative(current.root, path).split(sep).join("/"),
          type: "file",
          hidden: entry.name.startsWith("."),
          sensitive: sensitiveEntryName(entry.name),
          size: details.size,
          modifiedAt: details.mtimeMs,
          mimeType: presentation.mimeType,
          previewKind: presentation.previewKind,
        });
        if (results.length >= boundedResults) break;
      } catch (error) {
        if (!new Set(["ENOENT", "EACCES", "EPERM"]).has(error.code)) throw error;
      }
    }
  }
  if (queue.length || visited.size >= boundedDirectories || results.length >= boundedResults) truncated = true;
  return {
    query: normalizedQuery,
    results,
    truncated,
    visitedDirectories: visited.size,
  };
}

export { DEFAULT_MAX_DIRECTORIES, DEFAULT_MAX_DEPTH, DEFAULT_MAX_RESULTS };
