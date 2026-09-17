import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateVapidConfiguration } from "../push-service.mjs";

test("push setup writes private keys once and never prints or replaces the private key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pwa-push-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "configuration with spaces", "vapid.json");
  const setup = () => promisify(execFile)(process.execPath, [fileURLToPath(new URL("../scripts/setup-push.mjs", import.meta.url)),
    "--subject", "https://pwa.example/contact", "--output", output]);
  const first = await setup();
  const config = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(validateVapidConfiguration(config), config);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(first.stdout.includes(config.privateKey), false);
  config.proxy = "https://proxy-test:private-fixture@proxy.example:8443/";
  await writeFile(output, JSON.stringify(config));
  const second = await setup();
  assert.match(second.stdout, /Existing VAPID keys preserved/);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), config);
  assert.equal(second.stdout.includes(config.privateKey), false);
  assert.equal(second.stdout.includes(config.proxy), false);
});
