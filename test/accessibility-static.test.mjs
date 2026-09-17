import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installDialogFocus } from "../public/dialog-focus.js";

const source = new URL("../public/index.html", import.meta.url);

test("a delayed close event cannot steal focus from a reopened dialog", async () => {
  let restored = 0;
  let onClose;
  const trigger = { isConnected: true, focus: () => { restored += 1; } };
  const initial = { isConnected: true, focus() {} };
  const dialog = { open: false, contains: () => false, querySelector: () => initial,
    querySelectorAll: () => [initial], showModal() { this.open = true; }, close() { this.open = false; },
    addEventListener(name, callback) { if (name === "close") onClose = callback; } };
  installDialogFocus([dialog], { documentRef: { activeElement: trigger, querySelectorAll: () => dialog.open ? [dialog] : [] } });
  dialog.showModal();
  await new Promise((resolve) => setImmediate(resolve));
  dialog.close();
  assert.equal(restored, 1);
  dialog.showModal();
  onClose();
  assert.equal(restored, 1, "the previous opening's close event must not restore the trigger again");
  dialog.close();
  assert.equal(restored, 2, "the new opening still retains its return target");
});

test("both themes keep normal text and action labels at WCAG AA contrast", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const blocks = [...css.matchAll(/:root[^{}]*\{([^}]+)\}/gu)].slice(0, 2);
  const luminance = (hex) => hex.slice(1).match(/../gu).map((pair) => Number.parseInt(pair, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  let previous = {};
  for (const [index, block] of blocks.entries()) {
    const colors = { ...previous, ...Object.fromEntries([...block[1].matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gu)].map((match) => [match[1], match[2]])) };
    previous = colors;
    const pairs = ["text", "text-soft", "muted", "muted-2"].flatMap((text) =>
      ["bg", "sidebar", "panel", "panel-2", "panel-3", "surface-hover"].map((background) => [text, background]));
    pairs.push(["action-text", "action-bg"], ["action-text", "action-bg-hover"], ["action-text", "danger-action-bg"]);
    for (const status of ["green", "blue", "amber", "red", "purple"]) pairs.push([status, `${status}-bg`]);
    for (const [text, background] of pairs) {
      assert.ok(colors[text] && colors[background], `${text}/${background} colors are defined`);
      const a = luminance(colors[text]);
      const b = luminance(colors[background]);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(ratio >= 4.5, `${index ? "light" : "dark"} ${text}/${background}: ${ratio.toFixed(2)} < 4.5`);
    }
  }
});

test("tab controls expose a complete accessible relationship with their panels", async () => {
  const html = await readFile(source, "utf8");
  for (const id of ["recentTab", "allHistoryTab", "archivedTab", "changesTab", "infoTab"]) {
    const element = html.match(new RegExp(`<button[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(element, `${id} exists`);
    assert.match(element, /role="tab"/);
    assert.match(element, /aria-selected="(?:true|false)"/);
    assert.match(element, /aria-controls="[^"]+"/);
    assert.match(element, /tabindex="(?:0|-1)"/);
  }
  for (const id of ["threadList", "changesPanel", "infoPanel"]) {
    const element = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0];
    assert.ok(element, `${id} exists`);
    assert.match(element, /role="tabpanel"/);
    assert.match(element, /aria-labelledby="[^"]+"/);
    assert.match(element, /tabindex="0"/);
  }
});

test("the client keeps roving tabindex and aria-hidden state synchronized", async () => {
  const [app, listView, navigation] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/thread-list-view.js", import.meta.url), "utf8"),
    readFile(new URL("../public/tab-navigation.js", import.meta.url), "utf8"),
  ]);
  assert.match(app, /import \{ wireTabKeyboard \} from "\.\/tab-navigation\.js"/);
  assert.match(navigation, /export function wireTabKeyboard\(tabs, activate\)/);
  assert.match(listView, /tab\.setAttribute\("tabindex", active \? "0" : "-1"\)/);
  assert.match(listView, /elements\.threadList\.setAttribute\("aria-labelledby", id\)/);
  assert.match(app, /elements\.changesPanel\.setAttribute\("aria-hidden", String\(!changes\)\)/);
  assert.match(app, /elements\.infoPanel\.setAttribute\("aria-hidden", String\(changes\)\)/);
});
