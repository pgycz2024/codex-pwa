import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const allowedNames = new Set([
  "CODEX_PWA_HOST",
  "CODEX_PWA_PORT",
  "CODEX_PWA_ROOTS",
  "CODEX_BIN",
  "CODEX_HOME",
  "CODEX_PWA_APP_SERVER_MODE",
  "CODEX_PWA_DAEMON_SOCKET",
  "CODEX_PWA_PASSWORD_FILE",
  "CODEX_PWA_USERNAME_FILE",
  "CODEX_PWA_SESSION_FILE",
  "CODEX_PWA_INSTANCE_NAME",
  "CODEX_PWA_NETWORK_LABEL",
  "CODEX_PWA_PRIVATE_IP",
  "CODEX_PWA_LOOPBACK_ONLY",
]);

export function parseEnvironmentFile(source) {
  const result = new Map();
  for (const rawLine of String(source || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || !allowedNames.has(match[1])) continue;
    let value = match[2];
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) throw new Error(`Invalid quoted value for ${match[1]}`);
      value = value.slice(1, -1).replace(/\\([\\"])/gu, "$1");
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'") || value.length < 2) throw new Error(`Invalid quoted value for ${match[1]}`);
      value = value.slice(1, -1);
    }
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      throw new Error(`Invalid control character in ${match[1]}`);
    }
    result.set(match[1], value);
  }
  return result;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: node scripts/read-env.mjs ENV_FILE");
  const values = parseEnvironmentFile(await readFile(file, "utf8"));
  for (const [name, value] of values) process.stdout.write(`${name}\0${value}\0`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
