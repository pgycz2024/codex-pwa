import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createStaticServer({ publicDir, vendorMounts, sendJson }) {
  function resolveStaticFile(requestedPath) {
    const mount = vendorMounts.find(({ prefix }) => requestedPath.startsWith(prefix));
    const directory = mount?.directory || publicDir;
    const relativePath = mount ? requestedPath.slice(mount.prefix.length) : requestedPath.slice(1);
    const filePath = resolve(directory, normalize(relativePath));
    if (filePath === directory || !filePath.startsWith(`${directory}${sep}`)) return null;
    return filePath;
  }

  async function serveStatic(request, response, url) {
    const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const filePath = resolveStaticFile(requestedPath);
    if (!filePath) {
      sendJson(response, 403, { error: "Forbidden" });
      return;
    }
    try {
      const details = await stat(filePath);
      if (!details.isFile()) throw new Error("Not a file");
      const extension = extname(filePath);
      const isCoreShell = !requestedPath.startsWith("/vendor/") && (
        requestedPath === "/"
        || new Set([".html", ".js", ".css", ".webmanifest"]).has(extension)
      );
      const cacheControl = requestedPath === "/sw.js" || isCoreShell
        ? "no-cache"
        : requestedPath.startsWith("/vendor/")
          ? "public, max-age=3600, must-revalidate"
          : "public, max-age=86400";
      response.writeHead(200, {
        "content-type": contentTypes[extension] || "application/octet-stream",
        "content-length": details.size,
        "cache-control": cacheControl,
      });
      createReadStream(filePath).pipe(response);
    } catch {
      sendJson(response, 404, { error: "Not found" });
    }
  }

  return { resolveStaticFile, serveStatic };
}
