import { spawn } from "node:child_process";

const script = process.argv[2];
if (!["check", "release:local"].includes(script)) {
  throw new Error("Expected check or release:local");
}
const child = spawn("npm", ["run", script], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    process.stdout.write(chunk);
    output = (output + chunk).slice(-2_000_000);
  });
}
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
  if (code === 0 || !process.env.GITHUB_ACTIONS) return;
  // Keep failures available as check annotations, including for maintainers
  // whose repository-scoped deploy key cannot download Actions logs.
  const failures = output.match(/^\s*not ok\b[^\n]*\n(?:[ \t]+[^\n]*\n)*/gm);
  for (const failure of failures || [output.split("\n").slice(-40).join("\n")]) {
    const message = failure.slice(0, 12_000).replaceAll("%", "%25")
      .replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    console.log(`::error title=Verification failed::${message}`);
  }
});
