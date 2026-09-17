import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Integrity check for an extracted release, before npm can run package scripts.
// Authenticity still depends on obtaining the ZIP and its checksum from a trusted release.
export async function verifyReleaseManifest(directory) {
  const root = await realpath(directory);
  const manifestName = "RELEASE-MANIFEST.sha256";
  const manifestPath = join(root, manifestName);
  const metadata = await lstat(manifestPath);
  if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) throw new Error("Invalid release manifest");
  const expected = new Map();
  for (const line of (await readFile(manifestPath, "utf8")).trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64}) [ *]\.\/(.+)$/.exec(line);
    if (!match) throw new Error("Invalid release manifest entry");
    const [, hash, name] = match;
    if (name.includes("\\") || name.includes("\0") || name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Release manifest paths must stay inside the package");
    }
    if (name === manifestName || expected.has(name)) throw new Error("Duplicate or self-referencing manifest entry");
    expected.set(name, hash);
  }
  let count = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) { pending.push(path); continue; }
      if (!entry.isFile()) throw new Error(`Release contains a non-regular file: ${name}`);
      if (name === manifestName) continue;
      const hash = expected.get(name);
      if (!hash) throw new Error(`File missing from release manifest: ${name}`);
      const actual = createHash("sha256").update(await readFile(path)).digest("hex");
      if (hash !== actual) throw new Error(`Release checksum mismatch: ${name}`);
      expected.delete(name);
      count += 1;
    }
  }
  if (expected.size) throw new Error(`Release file missing: ${expected.keys().next().value}`);
  return count;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyReleaseManifest(process.argv[2]).then((count) => {
    console.log(`Release manifest verified: ${count} files.`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
