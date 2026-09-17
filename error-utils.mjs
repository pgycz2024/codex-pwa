import { uiText } from "./public/ui-copy.js";
export function approvalRequestChangedError() {
  return Object.assign(new Error(uiText("errors.approvalRequestChangedError.assign")), {
    statusCode: 409,
    details: { code: "APPROVAL_REQUEST_CHANGED", dispatched: false, outcomeUnknown: false },
  });
}

export function publicErrorMessage(error) {
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return uiText("errors.publicErrorMessage.text9");
  }
  if (error?.code === "ENOENT" && error?.path) {
    return uiText("errors.publicErrorMessage.text8");
  }
  if (error?.code === "ENOSPC" || error?.code === "EDQUOT") {
    return uiText("errors.publicErrorMessage.text7");
  }
  if (error?.code === "EEXIST") {
    return uiText("errors.publicErrorMessage.text6");
  }
  if (error?.code === "EISDIR" || error?.code === "ENOTDIR") {
    return uiText("errors.publicErrorMessage.text5");
  }
  if (error?.code === "ELOOP") {
    return uiText("errors.publicErrorMessage.text4");
  }
  if (error?.code === "ENAMETOOLONG") {
    return uiText("errors.publicErrorMessage.text3");
  }
  if (error?.path) {
    return uiText("errors.publicErrorMessage.text2");
  }
  return error?.message || uiText("errors.publicErrorMessage.text");
}

export function normalizeErrorStatus(error, statusCode = 400) {
  if (statusCode === 400 && (error?.code === "ENOSPC" || error?.code === "EDQUOT")) return 507;
  if (statusCode === 400 && error?.code === "EEXIST") return 409;
  return statusCode === 400 && (error?.code === "EACCES" || error?.code === "EPERM")
    ? 403
    : statusCode;
}
