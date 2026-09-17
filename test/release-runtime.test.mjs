import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { verifyReleaseManifest } from "../scripts/verify-release-manifest.mjs";
import { verifyReleaseRuntime } from "../scripts/verify-release-runtime.mjs";

const exec = promisify(execFile);

test("packaged runtime rejects a missing precache resource after static checks pass", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pwa-release-runtime-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new URL("..", import.meta.url);
  const script = await readFile(new URL("scripts/make-release.sh", source), "utf8");
  const entries = script.match(/release_items=\(\s*([\s\S]*?)\n\)/)?.[1]?.trim().split(/\s+/);
  assert.ok(entries?.includes("server.mjs"));
  for (const entry of entries) await cp(new URL(entry, source), join(root, entry), { recursive: true });

  // The file inventory and module imports remain valid, but cache.addAll would
  // reject this URL and prevent the Service Worker from installing.
  const swPath = join(root, "public/sw.js");
  const sw = await readFile(swPath, "utf8");
  assert.match(sw, /const ASSETS = \[/);
  await writeFile(swPath, sw.replace("const ASSETS = [", 'const ASSETS = ["/missing-release-resource.js",'));
  const lines = [];
  async function inventory(folder, prefix = "") {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await inventory(path, `${relative}/`);
      else {
        const hash = createHash("sha256").update(await readFile(path)).digest("hex");
        lines.push(`${hash}  ./${relative}`);
      }
    }
  }
  await inventory(root);
  const manifest = `${lines.sort().join("\n")}\n`;
  await writeFile(join(root, "RELEASE-MANIFEST.sha256"), manifest);
  assert.equal(await verifyReleaseManifest(root), lines.length);
  const { stdout } = await exec(process.execPath, ["--experimental-vm-modules",
    fileURLToPath(new URL("scripts/verify-release-modules.mjs", source)), root]);
  assert.match(stdout, /local imports/);

  const reports = [];
  await assert.rejects(verifyReleaseRuntime(root, { report: (message) => reports.push(message) }), (error) => {
    assert.match(error.message, /Service Worker installation asset: \/missing-release-resource\.js/);
    assert.equal(error.actual, 404);
    assert.equal(error.expected, 200);
    return true;
  });
  assert.deepEqual(reports, [], "failed acceptance must not report success");
  assert.equal(await readFile(join(root, "RELEASE-MANIFEST.sha256"), "utf8"), manifest);
  assert.equal(await verifyReleaseManifest(root), lines.length, "failed runtime verification leaves the candidate unchanged");
});
