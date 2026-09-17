export function approvalRequestId(value) {
  if (typeof value === "string" && value.length) return value;
  if (Number.isSafeInteger(value)) return String(value);
  return null;
}

export function sameApprovalRequest(previous, next) {
  if (!previous || !next) return false;
  return previous.method === next.method && previous.requestToken === next.requestToken
    && JSON.stringify(previous.params || {}) === JSON.stringify(next.params || {})
    && JSON.stringify(previous.fileChangeContext || null) === JSON.stringify(next.fileChangeContext || null);
}
