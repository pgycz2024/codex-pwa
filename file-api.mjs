import { uiText } from "./public/ui-copy.js";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, cp, link, lstat, mkdir, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { contentDisposition, filePresentation, isPathWithinRoots, parseByteRange } from "./file-access.mjs";
import { numberedUploadFilename, safeUploadFilename } from "./upload-utils.mjs";
import { directoryBreadcrumbs, validateDirectoryName } from "./directory-utils.mjs";
import { searchAllowedFiles } from "./file-search.mjs";

export function createFileApi({
  roots,
  maxUploadFiles = 20,
  maxUploadFileSize = 256 * 1024 * 1024,
  maxUploadBatchSize = 512 * 1024 * 1024,
  maxDirectoryEntries = 500,
  isAllowedPath,
  resolveAllowedDirectory,
  allowedThread,
  readBody,
  sendJson,
  sensitiveEntryName,
  uploadWriteStreamFactory = (path, options) => createWriteStream(path, options),
  searchFiles = searchAllowedFiles,
}) {
  async function resolveAllowedFile(candidate) {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 8_192 || !isAbsolute(candidate)) {
      const error = new Error(uiText("fileErrors.resolveAllowedFile.text5"));
      error.statusCode = 400;
      throw error;
    }
    if (!isAllowedPath(candidate)) {
      const error = new Error(uiText("fileErrors.resolveAllowedFile.text4"));
      error.statusCode = 403;
      throw error;
    }

    let actual;
    try {
      actual = await realpath(candidate);
    } catch {
      const error = new Error(uiText("fileErrors.resolveAllowedFile.text3"));
      error.statusCode = 404;
      throw error;
    }
    if (!isAllowedPath(actual)) {
      const error = new Error(uiText("fileErrors.resolveAllowedFile.text2"));
      error.statusCode = 403;
      throw error;
    }
    const details = await stat(actual);
    if (!details.isFile()) {
      const error = new Error(uiText("fileErrors.resolveAllowedFile.text"));
      error.statusCode = 400;
      throw error;
    }
    return { actual, details, presentation: filePresentation(actual) };
  }

  async function sendAllowedFile(request, response, url) {
    const { actual, details, presentation } = await resolveAllowedFile(url.searchParams.get("path") || "");
    const range = parseByteRange(request.headers.range, details.size);
    const download = url.searchParams.get("download") === "1" || !presentation.inline;
    const commonHeaders = {
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-disposition": contentDisposition(actual, download),
      "content-type": presentation.mimeType,
      "last-modified": details.mtime.toUTCString(),
      "content-security-policy": "sandbox",
    };

    if (range.kind === "invalid") {
      response.writeHead(416, { ...commonHeaders, "content-range": `bytes */${details.size}` });
      response.end();
      return;
    }

    const start = range.kind === "range" ? range.start : 0;
    const end = range.kind === "range" ? range.end : Math.max(0, details.size - 1);
    const length = details.size === 0 ? 0 : end - start + 1;
    response.writeHead(range.kind === "range" ? 206 : 200, {
      ...commonHeaders,
      "content-length": length,
      ...(range.kind === "range" ? { "content-range": `bytes ${start}-${end}/${details.size}` } : {}),
    });
    if (request.method === "HEAD" || details.size === 0) {
      response.end();
      return;
    }
    createReadStream(actual, { start, end })
      .on("error", () => response.destroy())
      .pipe(response);
  }

  function uploadError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  async function resolveUploadDirectory(url) {
    const threadId = String(url.searchParams.get("threadId") || "").trim();
    const cwd = String(url.searchParams.get("cwd") || "").trim();
    if (threadId && cwd) throw uploadError(uiText("fileErrors.resolveUploadDirectory.uploadError2"));
    if (threadId) {
      const thread = await allowedThread(threadId, false);
      return resolveAllowedDirectory(thread.cwd);
    }
    if (cwd) return resolveAllowedDirectory(cwd);
    throw uploadError(uiText("fileErrors.resolveUploadDirectory.uploadError"));
  }

  async function claimUploadedFile(tempPath, directory, filename) {
    for (let number = 0; number < 10_000; number += 1) {
      const destination = join(directory, numberedUploadFilename(filename, number));
      try {
        await link(tempPath, destination);
        try {
          await unlink(tempPath);
        } catch (error) {
          await unlink(destination).catch(() => {});
          throw error;
        }
        return destination;
      } catch (error) {
        if (error.code === "EEXIST") continue;
        throw error;
      }
    }
    throw uploadError(uiText("files.unusedName", filename), 409);
  }

  async function receiveUploadedFiles(request, directory) {
    if (request.headers["x-codex-pwa-upload"] !== "1") {
      throw uploadError(uiText("fileErrors.receiveUploadedFiles.uploadError5"), 403);
    }
    const declaredSize = Number.parseInt(request.headers["content-length"] || "0", 10);
    if (Number.isFinite(declaredSize) && declaredSize > maxUploadBatchSize + 2 * 1024 * 1024) {
      throw uploadError(uiText("files.uploadFilesToBrowserDirectory.showToast"), 413);
    }

    let parser;
    try {
      parser = Busboy({
        headers: request.headers,
        defParamCharset: "utf8",
        limits: {
          files: maxUploadFiles,
          fileSize: maxUploadFileSize,
          fields: 0,
          parts: maxUploadFiles,
        },
      });
    } catch {
      throw uploadError(uiText("fileErrors.receiveUploadedFiles.uploadError4"));
    }

    let totalBytes = 0;
    let fileCount = 0;
    const tempPaths = new Set();
    const createdPaths = new Set();
    const tasks = [];

    parser.on("file", (fieldName, stream, info) => {
      if (fieldName !== "files") {
        stream.resume();
        return;
      }
      fileCount += 1;
      const filename = safeUploadFilename(info.filename);
      const tempPath = join(directory, `.codex-pwa-upload-${randomUUID()}.part`);
      tempPaths.add(tempPath);
      const task = (async () => {
        let fileBytes = 0;
        const meter = new Transform({
          transform(chunk, encoding, callback) {
            fileBytes += chunk.length;
            totalBytes += chunk.length;
            if (totalBytes > maxUploadBatchSize) {
              callback(uploadError(uiText("files.uploadFilesToBrowserDirectory.showToast"), 413));
            } else {
              callback(null, chunk);
            }
          },
        });
        try {
          await pipeline(stream, meter, uploadWriteStreamFactory(tempPath, { flags: "wx", mode: 0o600 }));
          if (stream.truncated) throw uploadError(uiText("files.tooLarge", filename), 413);
          const destination = await claimUploadedFile(tempPath, directory, filename);
          tempPaths.delete(tempPath);
          createdPaths.add(destination);
          return {
            name: destination.split(sep).at(-1),
            originalName: filename,
            relativePath: relative(directory, destination).split(sep).join("/"),
            size: fileBytes,
            mimeType: info.mimeType || "application/octet-stream",
            previewUrl: `/file-preview.html?path=${encodeURIComponent(destination)}`,
          };
        } catch (error) {
          await unlink(tempPath).catch(() => {});
          tempPaths.delete(tempPath);
          throw error;
        }
      })();
      tasks.push(task);
    });

    const parseResult = await new Promise((resolve) => {
      let failure = null;
      parser.once("filesLimit", () => { failure ||= uploadError(uiText("fileErrors.receiveUploadedFiles.uploadError3"), 413); });
      parser.once("partsLimit", () => { failure ||= uploadError(uiText("fileErrors.receiveUploadedFiles.uploadError2"), 413); });
      parser.once("error", (error) => { failure ||= error; resolve(failure); });
      parser.once("close", () => resolve(failure));
      request.once("aborted", () => parser.destroy(uploadError(uiText("common.uploadCancelled"), 499)));
      request.pipe(parser);
    });

    const settled = await Promise.allSettled(tasks);
    const taskFailure = settled.find((result) => result.status === "rejected")?.reason;
    const failure = parseResult || taskFailure || (fileCount === 0 ? uploadError(uiText("fileErrors.receiveUploadedFiles.uploadError")) : null);
    if (failure) {
      await Promise.all([
        ...[...tempPaths].map((path) => unlink(path).catch(() => {})),
        ...[...createdPaths].map((path) => unlink(path).catch(() => {})),
      ]);
      throw failure;
    }
    return settled.map((result) => result.value);
  }

  async function listDirectories(candidate, showHidden = false, query = "") {
    const directory = await resolveAllowedDirectory(candidate || roots[0]);
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
      throw error;
    }
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase("zh-CN").slice(0, 160);
    const allDirectories = dirents
      .filter((entry) => entry.isDirectory() && (showHidden || (!entry.name.startsWith(".") && !sensitiveEntryName(entry.name))))
      .filter((entry) => !normalizedQuery || entry.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
    const breadcrumbs = directoryBreadcrumbs(directory, roots);
    return {
      path: directory,
      name: basename(directory) || directory,
      parent: breadcrumbs.length > 1 ? dirname(directory) : null,
      breadcrumbs,
      roots: roots.map((root) => ({ name: basename(root) || root, path: root })),
      entries: allDirectories.slice(0, maxDirectoryEntries).map((entry) => ({
        name: entry.name,
        path: join(directory, entry.name),
        hidden: entry.name.startsWith("."),
        sensitive: sensitiveEntryName(entry.name),
      })),
      truncated: allDirectories.length > maxDirectoryEntries,
    };
  }

  async function listFiles(candidate, { showHidden = false, query = "" } = {}) {
    const directory = await resolveAllowedDirectory(candidate || roots[0]);
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
      throw error;
    }
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase("zh-CN").slice(0, 160);
    const eligible = dirents
      .filter((entry) => (entry.isDirectory() || entry.isFile()) && (showHidden || (!entry.name.startsWith(".") && !sensitiveEntryName(entry.name))))
      .filter((entry) => !normalizedQuery || entry.name.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
      .sort((left, right) => {
        const typeDelta = Number(right.isDirectory()) - Number(left.isDirectory());
        return typeDelta || left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
      });
    const selected = eligible.slice(0, maxDirectoryEntries);
    const entries = (await Promise.all(selected.map(async (entry) => {
      const path = join(directory, entry.name);
      try {
        const details = await stat(path);
        if (entry.isDirectory() && !details.isDirectory()) return null;
        if (entry.isFile() && !details.isFile()) return null;
        const presentation = entry.isFile() ? filePresentation(path) : null;
        return {
          name: entry.name,
          path,
          type: entry.isDirectory() ? "directory" : "file",
          hidden: entry.name.startsWith("."),
          size: entry.isFile() ? details.size : null,
          modifiedAt: details.mtimeMs,
          mimeType: presentation?.mimeType || null,
          previewKind: presentation?.previewKind || null,
          sensitive: sensitiveEntryName(entry.name),
        };
      } catch (error) {
        if (new Set(["ENOENT", "EACCES", "EPERM"]).has(error.code)) return null;
        throw error;
      }
    }))).filter(Boolean);
    const breadcrumbs = directoryBreadcrumbs(directory, roots);
    return {
      path: directory,
      name: basename(directory) || directory,
      parent: breadcrumbs.length > 1 ? dirname(directory) : null,
      breadcrumbs,
      roots: roots.map((root) => ({ name: basename(root) || root, path: root })),
      entries,
      truncated: eligible.length > maxDirectoryEntries,
    };
  }

  async function createDirectory(request) {
    if (request.headers["x-codex-pwa-directory"] !== "1") {
      throw uploadError(uiText("fileErrors.createDirectory.uploadError2"), 403);
    }
    const body = await readBody(request);
    const parent = await resolveAllowedDirectory(String(body.parent || ""));
    const validation = validateDirectoryName(body.name);
    if (!validation.ok) throw uploadError(validation.error);
    const candidate = join(parent, validation.name);
    if (!isAllowedPath(candidate)) throw uploadError(uiText("fileErrors.createDirectory.uploadError"), 403);
    try {
      await mkdir(candidate, { mode: 0o750 });
      await chmod(candidate, 0o750);
    } catch (error) {
      if (error.code === "EEXIST") throw uploadError(uiText("fileErrors.mutateResolvedSource.uploadError"), 409);
      if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
      throw error;
    }
    const actual = await resolveAllowedDirectory(candidate);
    return { name: basename(actual), path: actual, parent };
  }

  function validateEntryName(value) {
    const name = String(value || "").normalize("NFC").trim();
    if (!name) throw uploadError(uiText("fileErrors.validateEntryName.uploadError5"));
    if (name === "." || name === "..") throw uploadError(uiText("fileErrors.validateEntryName.uploadError4"));
    if (/[\\/]/.test(name)) throw uploadError(uiText("fileErrors.validateEntryName.uploadError3"));
    if (/[\u0000-\u001f\u007f]/.test(name)) throw uploadError(uiText("fileErrors.validateEntryName.uploadError2"));
    if (Buffer.byteLength(name) > 240) throw uploadError(uiText("fileErrors.validateEntryName.uploadError"));
    return name;
  }

  async function resolveMutationSource(candidate) {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 8_192 || !isAbsolute(candidate)) {
      throw uploadError(uiText("fileErrors.resolveMutationSource.uploadError6"));
    }
    if (!isAllowedPath(candidate)) throw uploadError(uiText("fileErrors.resolveMutationSource.uploadError5"), 403);
    let details;
    try {
      details = await lstat(candidate);
    } catch (error) {
      if (error.code === "ENOENT") throw uploadError(uiText("fileErrors.resolveMutationSource.uploadError4"), 404);
      if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
      throw error;
    }
    if (details.isSymbolicLink()) throw uploadError(uiText("fileErrors.resolveMutationSource.uploadError3"), 403);
    if (!details.isFile() && !details.isDirectory()) throw uploadError(uiText("fileErrors.resolveMutationSource.uploadError2"));
    const actual = await realpath(candidate);
    if (!isAllowedPath(actual)) throw uploadError(uiText("fileErrors.resolveMutationSource.uploadError"), 403);
    return { actual, details };
  }

  async function assertDestinationAbsent(destination) {
    try {
      await lstat(destination);
      throw uploadError(uiText("fileErrors.mutateResolvedSource.uploadError"), 409);
    } catch (error) {
      if (error.statusCode) throw error;
      if (error.code !== "ENOENT") {
        if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
        throw error;
      }
    }
  }

  function temporaryOperationPath(path, operation) {
    return join(dirname(path), `.${basename(path)}.codex-pwa-${operation}-${randomUUID()}`);
  }

  async function deleteResolvedSource(source) {
    if (source.details.isDirectory()) {
      const children = await readdir(source.actual);
      if (children.length) throw uploadError(uiText("fileErrors.deleteResolvedSource.uploadError"), 409);
      await rm(source.actual, { recursive: false });
    } else {
      await unlink(source.actual);
    }
  }

  async function mutateResolvedSource(source, operation, targetDirectory, name) {
    const destination = join(targetDirectory, validateEntryName(name || basename(source.actual)));
    if (!isAllowedPath(destination)) throw uploadError(uiText("fileErrors.mutateResolvedSource.uploadError4"), 403);
    if (destination === source.actual) throw uploadError(uiText("fileErrors.mutateResolvedSource.uploadError3"));
    if (source.details.isDirectory() && isPathWithinRoots(destination, [source.actual])) {
      throw uploadError(uiText("fileErrors.mutateResolvedSource.uploadError2"), 409);
    }
    await assertDestinationAbsent(destination);
    let cleanupPending = null;
    try {
      if (operation === "copy") {
        await copyToFinalPath(source.actual, destination, { recursive: source.details.isDirectory() });
      } else {
        try {
          await rename(source.actual, destination);
        } catch (error) {
          if (error.code !== "EXDEV") throw error;
          cleanupPending = await moveAcrossFilesystems(source.actual, destination, source.details);
        }
      }
    } catch (error) {
      if (error.code === "EEXIST" || error.code === "ENOTEMPTY") throw uploadError(uiText("fileErrors.mutateResolvedSource.uploadError"), 409);
      if (error.code === "EACCES" || error.code === "EPERM") error.statusCode = 403;
      throw error;
    }
    return { operation, path: source.actual, targetPath: destination, cleanupPending };
  }

  async function copyToFinalPath(source, destination, { recursive }) {
    const temporary = temporaryOperationPath(destination, "copying");
    try {
      await cp(source, temporary, { recursive, errorOnExist: true, force: false });
      await assertDestinationAbsent(destination);
      if (recursive) {
        await rename(temporary, destination);
      } else {
        await link(temporary, destination);
        await unlink(temporary).catch((error) => {
          console.warn(`[files] Copied file is ready, but temporary link cleanup failed at ${temporary}: ${error.message}`);
        });
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async function moveAcrossFilesystems(source, destination, details) {
    await copyToFinalPath(source, destination, { recursive: details.isDirectory() });
    const retiredSource = temporaryOperationPath(source, "moved");
    try {
      await rename(source, retiredSource);
    } catch (error) {
      await rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    try {
      await rm(retiredSource, { recursive: details.isDirectory(), force: false });
      return null;
    } catch (error) {
      console.warn(`[files] Move completed, but deferred cleanup remains at ${retiredSource}: ${error.message}`);
      return retiredSource;
    }
  }

  async function operateOnFile(request) {
    if (request.headers["x-codex-pwa-file-operation"] !== "1") {
      throw uploadError(uiText("fileErrors.operateOnFile.uploadError7"), 403);
    }
    const body = await readBody(request);
    const operation = String(body.operation || "").trim().toLowerCase();
    if (!["rename", "move", "copy", "delete"].includes(operation)) throw uploadError(uiText("fileErrors.operateOnFile.uploadError6"));
    if (Array.isArray(body.paths)) {
      if (!["delete", "move", "copy"].includes(operation)) throw uploadError(uiText("fileErrors.operateOnFile.uploadError5"));
      if (body.paths.length === 0) throw uploadError(uiText("fileErrors.operateOnFile.uploadError4"));
      if (body.paths.length > 100) throw uploadError(uiText("fileErrors.operateOnFile.uploadError3"));
      if (body.paths.some((path) => typeof path !== "string" || path.length > 8_192)) {
        throw uploadError(uiText("fileErrors.operateOnFile.uploadError2"));
      }
      const deleted = [];
      const results = [];
      const failed = [];
      const targetDirectory = operation === "delete"
        ? ""
        : await resolveAllowedDirectory(String(body.targetDirectory || ""));
      const sources = [];
      for (const path of [...new Set(body.paths)]) {
        try {
          const source = await resolveMutationSource(path);
          if (roots.includes(source.actual)) throw uploadError(uiText("fileErrors.operateOnFile.uploadError"), 403);
          sources.push({ path, source });
        } catch (error) {
          failed.push({ path, error: error.message, statusCode: error.statusCode || 400 });
        }
      }
      for (const { path, source } of sources) {
        try {
          if (operation === "delete") {
            await deleteResolvedSource(source);
            deleted.push(source.actual);
            results.push({ path: source.actual });
          } else {
            results.push(await mutateResolvedSource(source, operation, targetDirectory, basename(source.actual)));
          }
        } catch (error) {
          failed.push({ path, error: error.message, statusCode: error.statusCode || 500 });
        }
      }
      return { operation, deleted, results, failed };
    }
    const source = await resolveMutationSource(String(body.path || ""));
    if (roots.includes(source.actual)) throw uploadError(uiText("fileErrors.operateOnFile.uploadError"), 403);

    if (operation === "delete") {
      await deleteResolvedSource(source);
      return { operation, path: source.actual };
    }

    const targetDirectory = operation === "rename"
      ? await resolveAllowedDirectory(dirname(source.actual))
      : await resolveAllowedDirectory(String(body.targetDirectory || ""));
    const name = validateEntryName(body.name || basename(source.actual));
    return mutateResolvedSource(source, operation, targetDirectory, name);
  }


  async function handleFileApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/directories") {
      const result = await listDirectories(
        url.searchParams.get("path") || roots[0],
        url.searchParams.get("hidden") === "true",
        url.searchParams.get("query") || "",
      );
      sendJson(response, 200, result);
        return true;
    }

    if (request.method === "POST" && url.pathname === "/api/directories") {
      const result = await createDirectory(request);
      sendJson(response, 201, result);
        return true;
    }

    if (request.method === "GET" && url.pathname === "/api/files/list") {
      const result = await listFiles(url.searchParams.get("path") || roots[0], {
        showHidden: url.searchParams.get("hidden") === "true",
        query: url.searchParams.get("query") || "",
      });
      sendJson(response, 200, result);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/files/search") {
      const query = String(url.searchParams.get("query") || "").trim();
      if (query.length < 2) throw uploadError(uiText("fileErrors.handleFileApi.uploadError"));
      const requestedRoot = String(url.searchParams.get("root") || "").trim();
      const searchRoot = requestedRoot
        ? await resolveAllowedDirectory(requestedRoot)
        : null;
      const result = await searchFiles({
        roots: searchRoot ? [searchRoot] : roots,
        query,
        showHidden: url.searchParams.get("hidden") === "true",
        sensitiveEntryName,
      });
      sendJson(response, 200, {
        ...result,
        path: searchRoot,
        roots: roots.map((root) => ({ name: basename(root) || root, path: root })),
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/files/upload") {
      const directory = await resolveUploadDirectory(url);
      const files = await receiveUploadedFiles(request, directory);
      sendJson(response, 201, { cwd: directory, files });
        return true;
    }

    if (request.method === "POST" && url.pathname === "/api/files/operations") {
      const result = await operateOnFile(request);
      sendJson(response, 200, result);
        return true;
    }

    if (request.method === "GET" && url.pathname === "/api/files/meta") {
      const { actual, details, presentation } = await resolveAllowedFile(url.searchParams.get("path") || "");
      sendJson(response, 200, {
        name: actual.split(sep).at(-1),
        size: details.size,
        modifiedAt: details.mtimeMs,
        mimeType: presentation.mimeType,
        previewKind: presentation.previewKind,
      });
        return true;
    }

    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/files/raw") {
      await sendAllowedFile(request, response, url);
        return true;
    }

    return false;
  }

  return { handleFileApi };
}
