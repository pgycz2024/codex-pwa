import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

// Parse static imports/re-exports without evaluating application code or
// needing installed dependencies. Run with --experimental-vm-modules.
export async function verifyReleaseModules(directory) {
  const root = await realpath(directory);
  let modules = 0;
  let imports = 0;
  const inside = (path) => {
    const subpath = relative(root, path);
    return subpath !== ".." && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath);
  };
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) {
        const module = new SourceTextModule(await readFile(path, "utf8"), { identifier: path });
        modules += 1;
        for (const specifier of module.dependencySpecifiers) {
          if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
          const target = fileURLToPath(new URL(specifier, pathToFileURL(path)));
          const label = `${relative(root, path)} -> ${specifier}`;
          if (!inside(target)) throw new Error(`Module import escapes the release directory: ${label}`);
          let canonical;
          try {
            canonical = await realpath(target);
            if (!(await stat(canonical)).isFile()) throw new Error("not a file");
          } catch {
            throw new Error(`Missing local module in release: ${label}`);
          }
          if (!inside(canonical)) throw new Error(`Module import escapes the release directory: ${label}`);
          imports += 1;
        }
      }
    }
  }
  await visit(root);
  return { modules, imports };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (!process.argv[2]) throw new Error("Usage: verify-release-modules.mjs <staged-release-directory>");
    const result = await verifyReleaseModules(process.argv[2]);
    console.log(`Release module check passed: ${result.modules} modules, ${result.imports} local imports.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
