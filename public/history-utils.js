export const DIFF_CHUNK_SIZE = 240;

export function chronologicalTurns(turns, sortDirection = "desc") {
  const values = Array.isArray(turns) ? [...turns] : [];
  return sortDirection === "desc" ? values.reverse() : values;
}

export function countDiffLines(diff) {
  const value = String(diff || "");
  if (!value) return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

export function nextDiffChunkEnd(total, current, chunkSize = DIFF_CHUNK_SIZE) {
  return Math.min(Math.max(0, total), Math.max(0, current) + Math.max(1, chunkSize));
}
