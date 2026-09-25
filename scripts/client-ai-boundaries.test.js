const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  createStageController,
  nextConcurrencyAfterLimit,
  backoffDelayMs,
  shouldRetryRow,
} = require("../src/workbenches/translation-compare/ai/concurrency-controller");

function loadDiff() {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "workbench-diff.js"), "utf8");
  const context = { globalThis: {}, Uint8Array, Map, Array, String, Math };
  vm.runInNewContext(source, context);
  return context.globalThis.WorkbenchDiff;
}

test("客户端差异模块可独立运行并正确转义、合并和截断", () => {
  const diff = loadDiff();
  const escapeHtml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const render = diff.createDiffRenderer({ escapeHtml, maxCacheSize: 2 });
  assert.equal(render("甲", "乙"), "<del>甲</del><ins>乙</ins>");
  assert.equal(render("<", "&"), "<del>&lt;</del><ins>&amp;</ins>");
  assert.equal(render("相同", "相同"), "相同");
  assert.equal(render("a".repeat(300), "b".repeat(300)).includes("<del>"), true);
  assert.equal(diff.compactDiffParts([{ type: "same", value: "a" }, { type: "same", value: "b" }], escapeHtml), "ab");
});

test("并发控制器只负责策略状态，不依赖 AI 任务模块", () => {
  const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
  const controller = createStageController({ stageKey: "stage1", label: "初审", config: { concurrency: 4, smartConcurrency: true, concurrencyMax: 8 }, clampInteger: clamp });
  assert.deepEqual({ current: controller.currentConcurrency, max: controller.maxConcurrency, smart: controller.isSmart }, { current: 4, max: 8, smart: true });
  assert.equal(nextConcurrencyAfterLimit(8), 5);
  assert.equal(nextConcurrencyAfterLimit(3), 2);
  assert.equal(backoffDelayMs(1, "2"), 2000);
  assert.equal(backoffDelayMs(2, "invalid"), 2250);
  assert.equal(shouldRetryRow(3, 3, false), true);
  assert.equal(shouldRetryRow(4, 3, false), false);
  assert.equal(shouldRetryRow(1, 3, true), false);

  // 并发上限放开到 32：20 必须原样保留，越界才截断到上限。
  const wide = createStageController({
    stageKey: "stage1",
    label: "初审",
    config: { concurrency: 20, smartConcurrency: true, concurrencyMax: 20 },
    clampInteger: clamp,
  });
  assert.deepEqual({ current: wide.currentConcurrency, max: wide.maxConcurrency }, { current: 20, max: 20 });

  const clamped = createStageController({
    stageKey: "stage1",
    label: "初审",
    config: { concurrency: 99, smartConcurrency: true, concurrencyMax: 99 },
    clampInteger: clamp,
  });
  assert.deepEqual({ current: clamped.currentConcurrency, max: clamped.maxConcurrency }, { current: 32, max: 32 });
});
