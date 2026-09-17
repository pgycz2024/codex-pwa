import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReleaseManifest } from "../scripts/verify-release-manifest.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pwa-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = '{"name":"release-fixture"}\n';
  const hash = createHash("sha256").update(body).digest("hex");
  const line = `${hash}  ./package.json\n`;
  await writeFile(join(root, "package.json"), body);
  await writeFile(join(root, "RELEASE-MANIFEST.sha256"), line);
  return { root, line, hash };
}

test("release integrity accepts complete content and rejects unlisted or missing files", async (t) => {
  const f = await fixture(t);
  assert.equal(await verifyReleaseManifest(f.root), 1);
  await writeFile(join(f.root, "unexpected.mjs"), "throw new Error('must not execute');");
  await assert.rejects(verifyReleaseManifest(f.root), /File missing from release manifest/);
  await rm(join(f.root, "unexpected.mjs"));
  await rm(join(f.root, "package.json"));
  await assert.rejects(verifyReleaseManifest(f.root), /Release file missing/);
});

test("release integrity rejects links before following them", async (t) => {
  const f = await fixture(t);
  await symlink(join(f.root, "package.json"), join(f.root, "linked-file"));
  await assert.rejects(verifyReleaseManifest(f.root), /non-regular file/);
  await rm(join(f.root, "linked-file"));
  await rm(join(f.root, "RELEASE-MANIFEST.sha256"));
  await symlink(join(f.root, "package.json"), join(f.root, "RELEASE-MANIFEST.sha256"));
  await assert.rejects(verifyReleaseManifest(f.root), /Invalid release manifest/);
});

test("release integrity refuses ambiguous, duplicate and escaping manifest paths", async (t) => {
  const f = await fixture(t);
  for (const body of [
    f.line + f.line,
    `${f.hash}  ./../outside\n`,
    `${f.hash}  .//absolute\n`,
    `${f.hash}  ./folder/../../outside\n`,
    `${f.hash}  ./RELEASE-MANIFEST.sha256\n`,
    "",
  ]) {
    await writeFile(join(f.root, "RELEASE-MANIFEST.sha256"), body);
    await assert.rejects(verifyReleaseManifest(f.root));
  }
});
