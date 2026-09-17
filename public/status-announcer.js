import { activeDialog } from "./dialog-focus.js";

// Short status updates belong in the currently accessible surface. The whole
// streaming transcript/history list is deliberately not a live region.
export function createStatusAnnouncer({ documentRef = document } = {}) {
  const regions = new Map();
  function regionFor(host) {
    if (!regions.has(host)) {
      const region = documentRef.createElement("div");
      region.className = "visually-hidden";
      region.dataset.statusAnnouncement = "";
      region.setAttribute("role", "status");
      region.setAttribute("aria-live", "polite");
      region.setAttribute("aria-atomic", "true");
      host.append(region);
      regions.set(host, region);
    }
    return regions.get(host);
  }
  for (const host of [documentRef.body, ...documentRef.querySelectorAll("dialog, #sidebar, #contextPanel")]) regionFor(host);
  return (message) => {
    const host = activeDialog(documentRef)
      || documentRef.querySelector('[aria-modal="true"]') || documentRef.body;
    const region = regionFor(host);
    const text = String(message || "").trim();
    if (region.textContent !== text) region.textContent = text;
  };
}
