const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench } = require("./workbench-fixture");

function render(ui, metrics, overrides = {}) {
  ui.run(`renderAiStatus(${JSON.stringify({
    kind: "ai", projectKey: "project", rowsSignature: "rows", results: [], metrics, ...overrides,
  })});`);
  return ui.element("aiCacheHitRate");
}

test("缓存用量：真实注入脚本按 token 占比显示，悬停保留统计范围与缓存写入", () => {
  const ui = createWorkbench(undefined, { strictIds: true });
  assert.match(ui.html.split("<script>")[0], /id="aiCacheHitRate"[^>]*aria-label=/);
  const badge = render(ui, {
    modelCalls: 3, cacheReportedCalls: 3, cacheReportedPromptTokens: 10000,
    cachedPromptTokens: 7500, cacheMissPromptTokens: 2500, cacheWritePromptTokens: 1500,
  });
  assert.equal(badge.textContent, "缓存命中: 75.0%");
  assert.match(badge.title, /缓存读取 7,500 \/ 10,000 token；未命中 2,500/);
  assert.match(badge.title, /缓存写入 1,500 token（包含在未命中输入中）/);
  assert.match(badge.title, /3 \/ 3 次调用/);
  assert.match(badge.getAttribute("aria-label"), /75.0%/);
});

test("缓存用量：未报告不能显示为零，部分报告不被未知输入稀释", () => {
  const ui = createWorkbench(undefined, { strictIds: true });
  let badge = render(ui, { modelCalls: 2, promptTokens: 5000 });
  assert.equal(badge.textContent, "缓存命中: —");
  assert.match(badge.title, /接口未返回缓存用量/);
  badge = render(ui, {
    modelCalls: 3, promptTokens: 10000, cacheReportedCalls: 2,
    cacheReportedPromptTokens: 4000, cachedPromptTokens: 1000, cacheMissPromptTokens: 3000,
  });
  assert.equal(badge.textContent, "缓存命中: 25.0%（部分）");
  assert.match(badge.title, /2 \/ 3 次调用；未报告的调用不参与/);
  badge = render(ui, { modelCalls: 1, cacheReportedCalls: 1, cacheReportedPromptTokens: 1000, cachedPromptTokens: 0 });
  assert.equal(badge.textContent, "缓存命中: 0.0%");
});

test("缓存用量：切轮、清除、外项目与旧服务响应清掉旧占比和悬停数字", () => {
  const ui = createWorkbench(undefined, { strictIds: true });
  const metrics = { modelCalls: 1, cacheReportedCalls: 1, cacheReportedPromptTokens: 1000, cachedPromptTokens: 800 };
  for (const action of [
    () => render(ui, {}, { runId: "next" }),
    () => ui.run("renderClearedAiStatus();"),
    () => render(ui, metrics, { projectKey: "other" }),
    () => render(ui, undefined),
    () => ui.run("clearLocalAiCache();"),
  ]) {
    render(ui, metrics);
    action();
    const badge = ui.element("aiCacheHitRate");
    assert.equal(badge.textContent, "缓存命中: —");
    assert.doesNotMatch(badge.title, /800|80\.0%/);
  }
});

test("缓存用量：零输入和异常数字不会显示 NaN 或超过 100%", () => {
  const ui = createWorkbench(undefined, { strictIds: true });
  assert.equal(render(ui, { modelCalls: 1, cacheReportedCalls: 1 }).textContent, "缓存命中: —");
  assert.equal(render(ui, {
    modelCalls: 1, cacheReportedCalls: 1, cacheReportedPromptTokens: 100, cachedPromptTokens: 1000,
  }).textContent, "缓存命中: 100.0%");
  assert.equal(render(ui, {
    modelCalls: 1, cacheReportedCalls: 1, cacheReportedPromptTokens: "bad", cachedPromptTokens: -1,
  }).textContent, "缓存命中: —");
});
