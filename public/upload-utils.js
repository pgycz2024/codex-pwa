export function appendUploadedFileReferences(prompt, files = []) {
  const paths = [...new Set(files.map((file) => file.relativePath).filter(Boolean))];
  const normalizedPrompt = String(prompt || "").trim();
  if (!paths.length) return normalizedPrompt;
  const references = paths.map((path) => `- \`${path.replaceAll("`", "\\`")}\``).join("\n");
  return `${normalizedPrompt}\n\n已上传到当前工作目录的文件：\n${references}`;
}

export function formatUploadSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
