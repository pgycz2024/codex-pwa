import * as pdfjs from "/vendor/pdfjs/build/pdf.mjs";
import { Marked } from "/vendor/marked/marked.esm.js";
import DOMPurify from "/vendor/dompurify/purify.es.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.mjs";

const elements = {
  preview: document.getElementById("preview"),
  fileName: document.getElementById("fileName"),
  fileMeta: document.getElementById("fileMeta"),
  downloadButton: document.getElementById("downloadButton"),
  zoomControls: document.getElementById("zoomControls"),
  zoomOutButton: document.getElementById("zoomOutButton"),
  zoomInButton: document.getElementById("zoomInButton"),
  zoomLabel: document.getElementById("zoomLabel"),
};

const path = new URLSearchParams(window.location.search).get("path") || "";
const rawUrl = `/api/files/raw?path=${encodeURIComponent(path)}`;
const downloadUrl = `${rawUrl}&download=1`;
let zoom = 1;
let pdfDocument = null;
let pageObserver = null;
let pdfLoadMoreObserver = null;
let pdfDocumentNode = null;
let pdfNextPage = 1;
let renderGeneration = 0;
const PDF_PAGE_BATCH_SIZE = 100;
const markdown = new Marked({ breaks: true, gfm: true });

document.documentElement.dataset.theme = localStorage.getItem("codex-pwa-theme") || "dark";

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function jsonResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function showError(error) {
  elements.preview.replaceChildren();
  const card = document.createElement("section");
  card.className = "error-card";
  const heading = document.createElement("h1");
  heading.textContent = "文件无法打开";
  const detail = document.createElement("p");
  detail.textContent = error?.message || "服务器没有返回这个文件。";
  card.append(heading, detail);
  elements.preview.append(card);
  elements.fileMeta.textContent = "预览失败";
}

function showDownload(meta) {
  const card = document.createElement("section");
  card.className = "download-card";
  const heading = document.createElement("h1");
  heading.textContent = "此格式暂不支持在线预览";
  const detail = document.createElement("p");
  detail.textContent = `${meta.name} · ${formatSize(meta.size)}，可以下载后使用手机上的对应应用打开。`;
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = meta.name;
  link.textContent = "下载文件";
  card.append(heading, detail, link);
  elements.preview.replaceChildren(card);
}

async function showText(meta) {
  if (meta.size > 2 * 1024 * 1024) {
    showDownload(meta);
    return;
  }
  const response = await fetch(rawUrl);
  if (!response.ok) throw new Error(`读取文本失败（HTTP ${response.status}）`);
  const pre = document.createElement("pre");
  pre.className = "text-preview";
  pre.textContent = await response.text();
  elements.preview.replaceChildren(pre);
}

async function showMarkdown(meta) {
  if (meta.size > 4 * 1024 * 1024) {
    showDownload(meta);
    return;
  }
  const response = await fetch(rawUrl);
  if (!response.ok) throw new Error(`读取 Markdown 失败（HTTP ${response.status}）`);
  const html = markdown.parse(await response.text());
  const article = document.createElement("article");
  article.className = "markdown-preview";
  article.innerHTML = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "srcset"],
  });
  for (const link of article.querySelectorAll("a[href]")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  elements.preview.replaceChildren(article);
}

function showImage(meta) {
  const image = document.createElement("img");
  image.className = "image-preview";
  image.alt = meta.name;
  image.src = rawUrl;
  image.addEventListener("error", () => showError(new Error("图片解码失败")), { once: true });
  elements.preview.replaceChildren(image);
}

function showMedia(meta) {
  const media = document.createElement(meta.mimeType.startsWith("video/") ? "video" : "audio");
  media.className = "media-preview";
  media.controls = true;
  media.preload = "metadata";
  media.src = rawUrl;
  media.addEventListener("error", () => showError(new Error("媒体文件无法播放")), { once: true });
  elements.preview.replaceChildren(media);
}

function availablePageWidth() {
  return Math.max(260, Math.min(960, elements.preview.clientWidth - 18)) * zoom;
}

async function renderPdfPage(slot, force = false) {
  if (!pdfDocument || (slot.dataset.rendered === "true" && !force) || slot.dataset.rendering === "true") return;
  slot.dataset.rendering = "true";
  const generation = renderGeneration;
  const pageNumber = Number.parseInt(slot.dataset.page, 10);
  try {
    const page = await pdfDocument.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const cssScale = availablePageWidth() / baseViewport.width;
    const cssViewport = page.getViewport({ scale: cssScale });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const renderViewport = page.getViewport({ scale: cssScale * pixelRatio });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    canvas.style.width = `${Math.floor(cssViewport.width)}px`;
    canvas.style.height = `${Math.floor(cssViewport.height)}px`;
    slot.style.width = `${Math.floor(cssViewport.width) + 2}px`;
    slot.style.height = `${Math.floor(cssViewport.height) + 2}px`;
    const context = canvas.getContext("2d", { alpha: false });
    await page.render({ canvasContext: context, viewport: renderViewport }).promise;
    if (generation !== renderGeneration) return;
    const label = slot.querySelector(".pdf-page-label");
    slot.replaceChildren(canvas, label);
    slot.classList.remove("pending");
    slot.dataset.rendered = "true";
  } finally {
    slot.dataset.rendering = "false";
  }
}

function releasePdfPage(slot) {
  if (slot.dataset.rendered !== "true" || slot.dataset.rendering === "true") return;
  const label = slot.querySelector(".pdf-page-label");
  slot.replaceChildren(label);
  slot.dataset.rendered = "false";
  slot.classList.add("pending");
}

async function rerenderVisiblePages() {
  renderGeneration += 1;
  const slots = [...elements.preview.querySelectorAll('.pdf-page[data-rendered="true"]')];
  for (const slot of slots) {
    slot.dataset.rendered = "false";
    slot.classList.add("pending");
    renderPdfPage(slot, true).catch(showError);
  }
}

function updateZoom(nextZoom) {
  zoom = Math.max(0.75, Math.min(2, nextZoom));
  elements.zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  elements.zoomOutButton.disabled = zoom <= 0.75;
  elements.zoomInButton.disabled = zoom >= 2;
  rerenderVisiblePages();
}

async function showPdf(meta) {
  elements.zoomControls.classList.remove("hidden");
  elements.fileMeta.textContent = `${formatSize(meta.size)} · 正在载入 PDF…`;
  const loadingTask = pdfjs.getDocument({
    url: rawUrl,
    withCredentials: true,
    cMapUrl: "/vendor/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    wasmUrl: "/vendor/pdfjs/wasm/",
  });
  loadingTask.onProgress = ({ loaded, total }) => {
    if (total) elements.fileMeta.textContent = `${formatSize(meta.size)} · 正在载入 ${Math.round((loaded / total) * 100)}%`;
  };
  pdfDocument = await loadingTask.promise;
  elements.fileMeta.textContent = `${pdfDocument.numPages} 页 · ${formatSize(meta.size)}`;

  pdfDocumentNode = document.createElement("section");
  pdfDocumentNode.className = "pdf-document";
  pdfNextPage = 1;
  elements.preview.replaceChildren(pdfDocumentNode);

  pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) renderPdfPage(entry.target).catch(showError);
      else releasePdfPage(entry.target);
    }
  }, { root: elements.preview, rootMargin: "900px 0px" });
  pdfLoadMoreObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) appendPdfPageBatch();
  }, { root: elements.preview, rootMargin: "1200px 0px" });
  appendPdfPageBatch();
}

function appendPdfPageBatch() {
  if (!pdfDocument || !pdfDocumentNode || pdfNextPage > pdfDocument.numPages) return;
  const previousLoader = pdfDocumentNode.querySelector(".pdf-load-more");
  if (previousLoader) {
    pdfLoadMoreObserver?.unobserve(previousLoader);
    previousLoader.remove();
  }
  const endPage = Math.min(pdfDocument.numPages, pdfNextPage + PDF_PAGE_BATCH_SIZE - 1);
  const fragment = document.createDocumentFragment();
  for (let pageNumber = pdfNextPage; pageNumber <= endPage; pageNumber += 1) {
    const slot = document.createElement("article");
    slot.className = "pdf-page pending";
    slot.dataset.page = String(pageNumber);
    const width = availablePageWidth();
    slot.style.width = `${Math.floor(width) + 2}px`;
    slot.style.height = `${Math.floor(width * 1.414)}px`;
    const label = document.createElement("span");
    label.className = "pdf-page-label";
    label.textContent = `${pageNumber} / ${pdfDocument.numPages}`;
    slot.append(label);
    fragment.append(slot);
    pageObserver.observe(slot);
  }
  pdfNextPage = endPage + 1;
  pdfDocumentNode.append(fragment);
  if (pdfNextPage <= pdfDocument.numPages) {
    const loader = document.createElement("button");
    loader.type = "button";
    loader.className = "pdf-load-more";
    loader.textContent = `继续载入页面（${pdfNextPage}–${Math.min(pdfDocument.numPages, pdfNextPage + PDF_PAGE_BATCH_SIZE - 1)}）`;
    loader.addEventListener("click", appendPdfPageBatch);
    pdfDocumentNode.append(loader);
    pdfLoadMoreObserver.observe(loader);
  }
}

async function initialize() {
  if (!path.startsWith("/")) throw new Error("文件路径无效");
  const meta = await jsonResponse(await fetch(`/api/files/meta?path=${encodeURIComponent(path)}`));
  document.title = `${meta.name} · Codex Remote`;
  elements.fileName.textContent = meta.name;
  elements.fileMeta.textContent = `${formatSize(meta.size)} · ${meta.mimeType.split(";")[0]}`;
  elements.downloadButton.href = downloadUrl;
  elements.downloadButton.download = meta.name;
  elements.downloadButton.classList.remove("hidden");

  if (meta.previewKind === "pdf") await showPdf(meta);
  else if (meta.previewKind === "image") showImage(meta);
  else if (meta.previewKind === "markdown") await showMarkdown(meta);
  else if (meta.previewKind === "text") await showText(meta);
  else if (meta.previewKind === "media") showMedia(meta);
  else showDownload(meta);
}

elements.zoomOutButton.addEventListener("click", () => updateZoom(zoom - 0.25));
elements.zoomInButton.addEventListener("click", () => updateZoom(zoom + 0.25));
window.addEventListener("beforeunload", () => {
  pageObserver?.disconnect();
  pdfLoadMoreObserver?.disconnect();
  pdfDocument?.destroy();
});

initialize().catch(showError);
