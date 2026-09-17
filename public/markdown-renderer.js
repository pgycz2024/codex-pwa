import { createMathExtensions } from "./markdown-math.js";
import { filePreviewHref, fileRawHref, normalizeMarkdownFileLinks, serverFilePath } from "./file-links.js";
import { addMessageOutline } from "./message-outline.js";
import { Marked } from "/vendor/marked/marked.esm.js";
import DOMPurify from "/vendor/dompurify/purify.es.mjs";
import katex from "/vendor/katex/katex.mjs";

function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function mathPlaceholder(tex, displayMode) {
  const tag = displayMode ? "div" : "span";
  const mode = displayMode ? "block" : "inline";
  return `<${tag} class="math-shell ${mode}">${escapeHtml(tex)}</${tag}>`;
}

function renderMath(container) {
  for (const shell of container.querySelectorAll(".math-shell")) {
    const tex = shell.textContent || "";
    const displayMode = shell.classList.contains("block");
    katex.render(tex, shell, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
      maxExpand: 1_000,
      maxSize: 50,
    });
  }
}

function enhanceTables(container) {
  for (const table of [...container.querySelectorAll("table")]) {
    if (table.closest(".markdown-table-scroll")) continue;
    const wrapper = createElement("div", "markdown-table-scroll");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "可横向滚动的表格");
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
}

function enhanceCodeBlocks(container) {
  for (const pre of [...container.querySelectorAll("pre")]) {
    if (pre.closest(".code-block")) continue;
    const code = pre.querySelector(":scope > code");
    const language = [...(code?.classList || [])]
      .find((className) => className.startsWith("language-"))
      ?.slice("language-".length) || "code";
    const wrapper = createElement("div", "code-block");
    const heading = createElement("div", "code-heading");
    const copy = createElement("button", "copy-code", "复制");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(code?.textContent || pre.textContent || "");
      copy.textContent = "已复制";
      setTimeout(() => { copy.textContent = "复制"; }, 1200);
    });
    heading.append(createElement("span", "", language), copy);
    pre.replaceWith(wrapper);
    wrapper.append(heading, pre);
  }
}

export function createMarkdownRenderer({ getRoots = () => [] } = {}) {
  const markdown = new Marked({ breaks: true, gfm: true });
  markdown.use({ extensions: createMathExtensions(mathPlaceholder) });

  function renderMarkdown(container, source, { anchorPrefix = "" } = {}) {
    const normalizedSource = normalizeMarkdownFileLinks(source);
    const html = markdown.parse(normalizedSource);
    const fragment = DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
      FORBID_ATTR: ["style", "srcset"],
    });
    container.replaceChildren(fragment);
    const roots = getRoots();
    for (const link of container.querySelectorAll("a[href]")) {
      const localPath = serverFilePath(link.getAttribute("href"), roots);
      if (localPath) {
        link.href = filePreviewHref(localPath);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.classList.add("server-file-link");
        link.dataset.fileType = localPath.split(".").at(-1)?.toLowerCase() || "file";
        link.title = `预览服务器文件：${localPath}`;
      } else if (/^https?:\/\//i.test(link.href)) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    }
    for (const image of [...container.querySelectorAll("img[src]")]) {
      const localPath = serverFilePath(image.getAttribute("src"), roots);
      if (!localPath) continue;
      const previewHref = filePreviewHref(localPath);
      image.src = fileRawHref(localPath);
      image.classList.add("inline-server-image");
      image.dataset.serverPath = localPath;
      image.title = `预览服务器图片：${localPath}`;
      const existingLink = image.closest("a[href]");
      if (existingLink) {
        existingLink.href = previewHref;
        existingLink.target = "_blank";
        existingLink.rel = "noopener noreferrer";
        existingLink.classList.add("inline-server-image-link");
      } else {
        const previewLink = createElement("a", "inline-server-image-link");
        previewLink.href = previewHref;
        previewLink.target = "_blank";
        previewLink.rel = "noopener noreferrer";
        image.replaceWith(previewLink);
        previewLink.append(image);
      }
    }
    addMessageOutline(container, anchorPrefix);
    renderMath(container);
    enhanceTables(container);
    enhanceCodeBlocks(container);
  }

  return { renderMarkdown };
}
