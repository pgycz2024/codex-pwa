import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import webPush from "web-push";
import { validateVapidConfiguration } from "../push-service.mjs";

let subject = "";
let output = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "codex-pwa", "push-vapid.json");
try {
  const args = process.argv.slice(2);
  while (args.length) {
    const option = args.shift();
    if (option === "--subject") subject = args.shift() || "";
    else if (option === "--output") output = resolve(args.shift() || "");
    else throw new Error("Usage: npm run setup:push -- --subject mailto:you@example.com [--output /absolute/private/file.json]");
  }
  if (!subject || /[\r\n\0]/.test(output)) throw new Error("Provide a VAPID contact with --subject (mailto: or HTTPS URL)");
  const config = validateVapidConfiguration({ ...webPush.generateVAPIDKeys(), subject });
  try {
    const details = await stat(output);
    if (!details.isFile() || (details.mode & 0o077)) throw new Error("Existing push configuration must be a private file (mode 600)");
    validateVapidConfiguration(JSON.parse(await readFile(output, "utf8")));
    console.log("Existing VAPID keys preserved.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const temporary = `${output}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await link(temporary, output); // Publish atomically, without replacing existing keys.
    } finally { await rm(temporary, { force: true }); }
    console.log("Private VAPID configuration created (mode 600).");
  }
  const quoted = `"${output.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  console.log(`Add to your PWA environment configuration:\nCODEX_PWA_PUSH_CONFIG_FILE=${quoted}`);
  console.log("No service was restarted. Apply during your next planned PWA update; enable push per device over HTTPS.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
