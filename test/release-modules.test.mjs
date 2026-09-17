import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function check(directory) {
  const child = spawn(process.execPath, ["--experimental-vm-modules",
    fileURLToPath(new URL("../scripts/verify-release-modules.mjs", import.meta.url)), directory,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output += data; });
  const [code] = await once(child, "exit");
  return { code, output };
}

async function temporaryDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "pwa-release-imports-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("release module check finds missing transitive imports without executing code", async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, "server.mjs"), `import "./bridge.mjs"; throw new Error("must not execute");`);
  await writeFile(join(root, "bridge.mjs"), `// import "./not-a-module.mjs";
    export { value } from "./protocol.mjs?version=1";`);
  const missing = await check(root);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Missing local module in release: bridge.mjs -> .\/protocol.mjs/);
  await writeFile(join(root, "protocol.mjs"), "export const value = 1;");
  const complete = await check(root);
  assert.equal(complete.code, 0, complete.output);
  assert.match(complete.output, /3 modules, 2 local imports/);
});

test("release module check rejects local imports that depend on the source checkout", async (t) => {
  const root = await temporaryDirectory(t);
  const staged = join(root, "stage");
  await mkdir(staged);
  await writeFile(join(root, "outside.mjs"), "export const value = 1;");
  await writeFile(join(staged, "server.mjs"), 'import "../outside.mjs";');
  const result = await check(staged);
  assert.equal(result.code, 1);
  assert.match(result.output, /escapes the release directory/);
});

test("the actual release inventory includes every local static module dependency", async (t) => {
  const root = await temporaryDirectory(t);
  const source = new URL("..", import.meta.url);
  const script = await readFile(new URL("scripts/make-release.sh", source), "utf8");
  const entries = script.match(/release_items=\(\s*([\s\S]*?)\n\)/)?.[1]?.trim().split(/\s+/);
  assert.ok(entries?.includes("server.mjs"));
  for (const entry of entries) {
    await cp(new URL(entry, source), join(root, entry), { recursive: true });
  }
  const result = await check(root);
  assert.equal(result.code, 0, result.output);
});
