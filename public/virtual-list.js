export function boundedWindow(total, size, requestedStart = null) {
  const safeTotal = Math.max(0, Number.parseInt(total, 10) || 0);
  const safeSize = Math.max(1, Number.parseInt(size, 10) || 1);
  const maximumStart = Math.max(0, safeTotal - safeSize);
  const start = Math.min(maximumStart, Math.max(0, requestedStart ?? maximumStart));
  return { start, end: Math.min(safeTotal, start + safeSize), enabled: safeTotal > safeSize };
}

export function fixedVirtualRange({ total, scrollTop, rowHeight, viewportHeight, overscan = 0 }) {
  const safeTotal = Math.max(0, Number.parseInt(total, 10) || 0);
  const safeRowHeight = Math.max(1, Number(rowHeight) || 1);
  const safeViewport = Math.max(safeRowHeight, Number(viewportHeight) || safeRowHeight);
  const safeOverscan = Math.max(0, Number.parseInt(overscan, 10) || 0);
  const visibleRows = Math.max(1, Math.ceil(safeViewport / safeRowHeight));
  const start = Math.max(0, Math.floor(Math.max(0, Number(scrollTop) || 0) / safeRowHeight) - safeOverscan);
  const end = Math.min(safeTotal, start + visibleRows + safeOverscan * 2);
  return { start, end };
}
