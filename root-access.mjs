import { uiText } from "./public/ui-copy.js";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

const FORMAT_VERSION = 1;
const MAX_ADDITIONAL_ROOTS = 32;
const MAX_PATH_LENGTH = 8_192;

function pathWithin(candidate, root) {
  return candidate === root || root === sep || candidate.startsWith(`${root}${sep}`);
}

function canonicalDirectory(candidate) {
  const value = String(candidate || "").trim();
  if (!value || value.length > MAX_PATH_LENGTH || !isAbsolute(value)) {
    throw new Error(uiText("rootErrors.canonicalDirectory.text3"));
  }
  let actual;
  try {
    actual = resolve(value);
    actual = realpathSync(actual);
    if (!statSync(actual).isDirectory()) throw new Error(uiText("rootErrors.canonicalDirectory.text2"));
  } catch (error) {
    if (error.message === uiText("rootErrors.canonicalDirectory.text2")) throw error;
    throw new Error(uiText("rootErrors.canonicalDirectory.text"));
  }
  return actual;
}

export class RootAccessManager {
  constructor({ configuredRoots = [], roots = [], home = "", persistedPath = "" } = {}) {
    this.configuredRoots = [...configuredRoots];
    this.roots = roots;
    this.home = home;
    this.persistedPath = persistedPath;
    this.additionalRoots = [];
    this.load();
  }

  load() {
    if (!this.persistedPath) return;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.persistedPath, "utf8"));
    } catch {
      return;
    }
    const candidates = Array.isArray(parsed?.roots) ? parsed.roots : [];
    for (const candidate of candidates.slice(0, MAX_ADDITIONAL_ROOTS)) {
      try {
        const actual = canonicalDirectory(candidate);
        if (this.configuredRoots.some((root) => pathWithin(actual, root))) continue;
        if (this.additionalRoots.includes(actual)) continue;
        this.additionalRoots.push(actual);
      } catch {}
    }
    this.syncRoots();
  }

  syncRoots() {
    this.roots.splice(0, this.roots.length, ...this.configuredRoots, ...this.additionalRoots);
  }

  policy() {
    return {
      configured: this.configuredRoots.length > 0,
      broad: this.home ? this.roots.some((root) => root === this.home) : false,
      home: this.home || null,
      additionalCount: this.additionalRoots.length,
      persisted: Boolean(this.persistedPath),
    };
  }

  snapshot() {
    return {
      configured: this.configuredRoots.map((path) => ({ name: basename(path) || path, path, removable: false })),
      additional: this.additionalRoots.map((path) => ({ name: basename(path) || path, path, removable: true })),
      roots: [...this.roots].map((path) => ({ name: basename(path) || path, path })),
      maxAdditionalRoots: MAX_ADDITIONAL_ROOTS,
    };
  }

  persist() {
    if (!this.persistedPath) return;
    mkdirSync(dirname(this.persistedPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.persistedPath}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ version: FORMAT_VERSION, roots: this.additionalRoots }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.persistedPath);
    chmodSync(this.persistedPath, 0o600);
  }

  add(candidate) {
    const actual = canonicalDirectory(candidate);
    if (this.roots.some((root) => pathWithin(actual, root))) {
      return { added: false, alreadyCovered: true, path: actual, snapshot: this.snapshot() };
    }
    if (this.additionalRoots.length >= MAX_ADDITIONAL_ROOTS) {
      const error = new Error(uiText("rootErrors.labels.text"));
      error.statusCode = 413;
      throw error;
    }
    this.additionalRoots.push(actual);
    this.syncRoots();
    this.persist();
    return { added: true, path: actual, snapshot: this.snapshot() };
  }

  remove(candidate) {
    const value = resolve(String(candidate || "").trim());
    const index = this.additionalRoots.indexOf(value);
    if (index < 0) return { removed: false, snapshot: this.snapshot() };
    this.additionalRoots.splice(index, 1);
    this.syncRoots();
    this.persist();
    return { removed: true, path: value, snapshot: this.snapshot() };
  }
}

export { FORMAT_VERSION, MAX_ADDITIONAL_ROOTS };
