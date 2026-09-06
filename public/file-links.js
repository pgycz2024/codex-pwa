function decodedPath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function localReferencePath(href) {
  if (!href || typeof href !== "string") return null;
  let value = href.trim();
  if (!value) return null;
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();

  if (value.startsWith("file://")) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return null;
      return decodedPath(url.pathname);
    } catch {
      // Some Codex clients emit file URLs containing unescaped spaces. Fall
      // back to the path portion instead of discarding an otherwise valid link.
      const fallback = value.replace(/^file:\/\/(?:localhost)?/i, "");
      return fallback.startsWith("/") ? decodedPath(fallback.split(/[?#]/, 1)[0]) : null;
    }
  }

  if (/^sandbox:/i.test(value)) {
    let sandboxPath = value.slice("sandbox:".length);
    if (sandboxPath.startsWith("//")) sandboxPath = sandboxPath.slice(2);
    if (!sandboxPath.startsWith("/")) sandboxPath = `/${sandboxPath}`;
    return decodedPath(sandboxPath.split(/[?#]/, 1)[0]);
  }

  if (value.startsWith("/")) return decodedPath(value.split(/[?#]/, 1)[0]);
  return null;
}

export function serverFilePath(href, roots = []) {
  const candidate = localReferencePath(href);

  if (!candidate) return null;
  const root = roots.find((allowedRoot) => (
    candidate === allowedRoot || candidate.startsWith(`${allowedRoot.replace(/\/$/, "")}/`)
  ));
  return root && candidate !== root ? candidate : null;
}

function markdownLocalDestination(value) {
  const candidate = localReferencePath(value);
  if (!candidate) return null;
  // Markdown link destinations cannot contain literal spaces, and balanced
  // parentheses are ambiguous to many parsers. Encode those characters while
  // retaining a normal absolute path for serverFilePath() to validate later.
  return encodeURI(candidate).replaceAll("(", "%28").replaceAll(")", "%29");
}

function linkDestinationEnd(line, start) {
  let depth = 1;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function normalizeMarkdownLine(line) {
  let output = "";
  let inlineCodeFence = 0;
  let index = 0;
  while (index < line.length) {
    if (line[index] === "`") {
      let end = index + 1;
      while (line[end] === "`") end += 1;
      const runLength = end - index;
      output += line.slice(index, end);
      inlineCodeFence = inlineCodeFence === runLength ? 0 : inlineCodeFence || runLength;
      index = end;
      continue;
    }

    if (!inlineCodeFence && line[index] === "[" && line[index - 1] !== "\\") {
      const labelEnd = line.indexOf("](", index + 1);
      if (labelEnd > index) {
        const destinationStart = labelEnd + 2;
        const destinationEnd = linkDestinationEnd(line, destinationStart);
        if (destinationEnd > destinationStart) {
          const destination = line.slice(destinationStart, destinationEnd).trim();
          const normalized = markdownLocalDestination(destination);
          if (normalized) {
            output += `${line.slice(index, destinationStart)}${normalized})`;
            index = destinationEnd + 1;
            continue;
          }
        }
      }
    }

    output += line[index];
    index += 1;
  }
  return output;
}

/**
 * Make Codex's local-file Markdown links parseable even when paths contain
 * spaces, Unicode, or parentheses. Fenced and inline code are copied as-is.
 */
export function normalizeMarkdownFileLinks(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  let fenced = null;
  return lines.map((line) => {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenced) {
      if (fence && fence[1][0] === fenced.character && fence[1].length >= fenced.length) fenced = null;
      return line;
    }
    if (fence) {
      fenced = { character: fence[1][0], length: fence[1].length };
      return line;
    }
    return normalizeMarkdownLine(line);
  }).join("\n");
}

export function filePreviewHref(path) {
  return `/file-preview.html?path=${encodeURIComponent(path)}`;
}

export function fileRawHref(path) {
  return `/api/files/raw?path=${encodeURIComponent(path)}`;
}
