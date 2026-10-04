const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizePresetPool, createPresetPool } = require("../src/workbenches/translation-compare/ai/preset-pool");

test("预设池归一化并保留独立并发上限", () => {
  const pool = normalizePresetPool([{ id: "fast", concurrency: 8 }, { presetId: "strict", name: "严格", concurrency: 2 }]);
  assert.deepEqual(pool.map((item) => [item.presetId, item.concurrency]), [["fast", 8], ["strict", 2]]);
});

test("预设池按负载选择并根据结果动态调整配额", () => {
  const scheduler = createPresetPool([
    { id: "fast", concurrency: 4 },
    { id: "strict", concurrency: 2 },
  ]);
  scheduler.setPending({ fast: 3, strict: 3 });
  const first = scheduler.next();
  assert.ok(first);
  scheduler.begin(first.presetId, 1);
  scheduler.finish(first.presetId, 1, { ok: false });
  const after = scheduler.snapshot().find((item) => item.presetId === first.presetId);
  assert.equal(after.quota, 2);
  assert.ok(scheduler.snapshot().every((item) => item.activeRows.length === 0));
});
