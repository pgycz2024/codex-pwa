import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { uiText } from "../public/ui-copy.js";

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

// Static fallback stays usable before JavaScript loads. Only explicit text and
// accessible-name bindings are generated; never replace control values or HTML.
export function renderStaticCopy(html, readText = uiText) {
  let rendered = html.replace(/<!--copy:([\w.-]+)-->[\s\S]*?<!--\/copy-->/g,
    (_, key) => `<!--copy:${key}-->${escapeHtml(readText(key))}<!--/copy-->`);
  rendered = rendered.replace(/<[A-Za-z][^>]*>/g, (tag) => {
    for (const [, attribute, key] of tag.matchAll(/\bdata-copy-(aria-label|title|placeholder)="([\w.-]+)"/g)) {
      const pattern = new RegExp(`(\\s${attribute}=")[^"]*(")`);
      if (!pattern.test(tag)) throw new Error(`Copy binding has no ${attribute}: ${key}`);
      tag = tag.replace(pattern, (_, before, after) => before + escapeHtml(readText(key)) + after);
    }
    return tag;
  });
  return rendered;
}

async function sync({ check }) {
  for (const name of ["index.html", "file-preview.html"]) {
    const path = new URL(`../public/${name}`, import.meta.url);
    const source = await readFile(path, "utf8");
    const rendered = renderStaticCopy(source);
    if (source === rendered) continue;
    if (check) throw new Error(`${name} has stale UI copy; run npm run copy:sync`);
    await writeFile(path, rendered);
  }
  console.log(check ? "Static UI copy is synchronized." : "Static UI copy synchronized.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((argument) => argument !== "--check")) throw new Error("Usage: sync-ui-copy.mjs [--check]");
  await sync({ check: process.argv.includes("--check") });
}
