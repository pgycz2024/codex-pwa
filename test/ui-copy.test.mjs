import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { UI_COPY, uiText } from "../public/ui-copy.js";
import { renderStaticCopy } from "../scripts/sync-ui-copy.mjs";

test("Chinese dialogs have Chinese context headings and consistent device actions", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const eyebrows = [...html.matchAll(/<span\b[^>]*class="eyebrow"[^>]*>([\s\S]*?)<\/span>/g)];
  assert.ok(eyebrows.length >= 10);
  for (const [, label] of eyebrows) {
    assert.match(label.replace(/<!--[\s\S]*?-->/g, ""), /\p{Script=Han}/u,
      "Dialog context should use the interface language");
  }
  assert.doesNotMatch(html, /注销全部设备|注销其他设备/);
});

test("copy interpolation does not interpret user values as templates or HTML", () => {
  const key = "files.deleteSelectedFileBrowserEntries.title";
  assert.equal(uiText(key, 3), "删除选中的 3 个项目？");
  assert.equal(uiText(key, "{1}<img src=x onerror=alert(1)>"), "删除选中的 {1}<img src=x onerror=alert(1)> 个项目？");
  assert.throws(() => uiText(key), /Missing UI copy argument/);
  assert.throws(() => uiText("constructor"), /Unknown UI copy key/);
  assert.throws(() => uiText("missing.product.copy"), /Unknown UI copy key/);
  assert.ok(Object.isFrozen(UI_COPY));
});

test("static copy synchronization preserves controls, nested icons and accessible names", async () => {
  const source = '<button data-copy-aria-label="common.close" aria-label="old" value="cancel"><i>×</i><!--copy:common.close-->old<!--/copy--></button>';
  const rendered = renderStaticCopy(source);
  assert.match(rendered, /aria-label="关闭" value="cancel"/);
  assert.match(rendered, /<i>×<\/i><!--copy:common.close-->关闭<!--\/copy-->/);
  assert.equal(renderStaticCopy(rendered), rendered);
  const injected = renderStaticCopy(source, () => '<img src=x onerror="attack()">&');
  assert.doesNotMatch(injected, /<img/);
  assert.match(injected, /&lt;img src=x onerror=&quot;attack\(\)&quot;&gt;&amp;/);
  assert.throws(() => renderStaticCopy('<!--copy:missing.key-->text<!--/copy-->'), /Unknown UI copy key/);
  assert.throws(() => renderStaticCopy('<button data-copy-title="common.close">×</button>'), /has no title/);
  for (const name of ["index.html", "file-preview.html"]) {
    const html = await readFile(new URL(`../public/${name}`, import.meta.url), "utf8");
    assert.equal(renderStaticCopy(html), html, `${name} must ship correct text before JavaScript loads`);
  }
});

test("settings and dialog managers use catalog text while preserving upstream identifiers", async () => {
  for (const name of ["task-settings", "file-browser", "directory-browser", "file-preview", "device-manager", "access-roots",
    "thread-actions", "goal-actions", "approval-actions", "approval-decisions", "task-composer", "push-notifications",
    "history-nodes", "thread-list-view", "diagnostics-view"]) {
    const source = await readFile(new URL(`../public/${name}.js`, import.meta.url), "utf8");
    assert.match(source, /import \{ uiText \} from "\.\/ui-copy\.js"/);
    assert.doesNotMatch(source, /\p{Script=Han}/u, `${name} should not duplicate product copy`);
  }
  const { EFFORT_LABELS, PERMISSION_LABELS } = await import("../public/task-settings.js");
  assert.equal(EFFORT_LABELS.ultra, "极致（ultra）");
  assert.equal(PERMISSION_LABELS.auto, uiText("common.permissionAuto"));
  const { APPROVAL_CHOICES } = await import("../public/approval-decisions.js");
  assert.deepEqual(APPROVAL_CHOICES.map((choice) => choice[1]), ["accept", "acceptForSession", "decline", "cancel"]);
});

test("local settings and Goal validation use readable copy without changing protocol values", async () => {
  const { parseSettingsOverrides } = await import("../thread-settings.mjs");
  assert.throws(() => parseSettingsOverrides({ effort: "not-an-effort" }, {}), /不支持该推理强度/);
  const { createThreadService } = await import("../thread-service.mjs");
  const service = createThreadService({ codexHome: "/example", runtime: {} });
  assert.throws(() => service.goalSetParams("task", { objective: "x".repeat(4001) }), /Goal 目标描述不能超过 4000 个字符/);
  assert.deepEqual(service.goalSetParams("task", { status: "paused", tokenBudget: 0 }), { threadId: "task", status: "paused", tokenBudget: 0 });
});

test("all shipped copy references exist and templates have complete positional arguments", async () => {
  const root = new URL("..", import.meta.url);
  const paths = [
    ...(await readdir(root)).filter((name) => name.endsWith(".mjs")),
    ...(await readdir(new URL("public/", root))).filter((name) => name.endsWith(".js")).map((name) => `public/${name}`),
  ];
  for (const path of paths) {
    const source = await readFile(new URL(path, root), "utf8");
    for (const [, key] of source.matchAll(/\buiText\("([^"]+)"/g)) assert.ok(Object.hasOwn(UI_COPY, key), `${path}: ${key}`);
    for (const [, key] of source.matchAll(/\buiText\("([^"]+)"\)/g)) assert.doesNotThrow(() => uiText(key), `${path}: missing arguments for ${key}`);
  }
  for (const [key, template] of Object.entries(UI_COPY)) {
    const indexes = [...new Set([...template.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
    assert.deepEqual(indexes, indexes.map((_, index) => index), `${key}: skipped argument`);
    assert.doesNotMatch(uiText(key, ...indexes.map((index) => `value-${index}`)), /\{\d+\}/);
  }
});
