const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture, addPoolPreset, toastMessages } = require("./workbench-fixture");

const presets = [
  { id: "p1", name: "快速模型", protocol: "compatible", baseUrl: "https://example.invalid/v1", model: "fast", concurrency: 4 },
  { id: "p2", name: "高级模型", protocol: "compatible", baseUrl: "https://example.invalid/v1", model: "advanced", concurrency: 8 },
];
function setup(config = {}, options = {}) {
  return createWorkbench(storageFixture({
    "translation-compare-ai-presets-v2": JSON.stringify(presets),
    "translation-compare-ai-config-v2": JSON.stringify(config),
  }), { strictIds: true, ...options });
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const selected = (ui) => plain(ui.run("sharedPoolSelections"));

test("共享池布局：每阶段仅展示进度，配置与启停入口各只有一处", () => {
  const { html } = setup();
  for (const id of ["aiPoolPresetSelect", "aiPoolPresetAdd", "aiPoolPresets", "aiPoolStart", "aiPoolStop", "aiPoolMode"]) {
    assert.equal([...html.matchAll(new RegExp('id="' + id + '"', "g"))].length, 1, id);
  }
  assert.doesNotMatch(html, /id="(?:stage[123](?:PresetSelect|PresetAdd|Start|Stop)|aiStartAll|aiStopAll)"/);
});

test("候选预设必须添加才进入池，新加入默认允许三个阶段且不重复占一条通道", async () => {
  const ui = setup();
  await ui.settle();
  ui.element("aiPoolPresetSelect").value = "p1";
  await ui.element("aiPoolPresetSelect").dispatch("change");
  assert.deepEqual(selected(ui), []);
  addPoolPreset(ui, "p1");
  addPoolPreset(ui, "p1");
  assert.equal(selected(ui).length, 1);
  assert.deepEqual(selected(ui)[0].stages, ["stage1", "stage2", "stage3"]);
  const config = plain(ui.run("aiConfig()"));
  assert.equal(config.poolEnabled, true);
  assert.equal(config.presetPool.length, 1);
  assert.equal(config.presetPool[0].model, "fast");
  assert.equal(config.poolPriorityEnabled, false);
  assert.equal(config.poolMode, "normal");
});

test("阶段权限和可选优先级写入同一池条目，刷新保持相同路由", async () => {
  const ui = setup();
  await ui.settle();
  addPoolPreset(ui, "p2");
  const controls = ui.element("aiPoolPresets").children[0]._poolControls;
  controls.stages[0].checkbox.checked = false;
  await controls.stages[0].checkbox.dispatch("change");
  ui.element("aiPoolPriorityEnabled").checked = true;
  await ui.element("aiPoolPriorityEnabled").dispatch("change");
  controls.stages[2].priority.value = "9";
  await controls.stages[2].priority.dispatch("change");
  ui.element("aiPoolMode").value = "loop";
  await ui.element("aiPoolMode").dispatch("change");
  assert.deepEqual(selected(ui)[0].stages, ["stage2", "stage3"]);
  assert.equal(selected(ui)[0].stagePriorities.stage3, 9);
  assert.equal(controls.stages[0].priority.disabled, true);
  assert.equal(controls.stages[2].priority.hidden, false);
  ui.run("restoreAiConfig()");
  const config = plain(ui.run("aiConfig()"));
  assert.equal(config.poolPriorityEnabled, true);
  assert.equal(config.poolMode, "loop");
  assert.equal(config.presetPool[0].stagePriorities.stage3, 9);
  assert.deepEqual(config.presetPool[0].stages, ["stage2", "stage3"]);
});

test("移除最后一个预设保持显式空池，候选和旧配置不会重新加入", async () => {
  const ui = setup({ stage1PresetIds: ["p1"] });
  await ui.settle();
  ui.element("aiPoolPresetSelect").value = "p2";
  await ui.element("aiPoolPresets").children[0]._poolControls.remove.dispatch("click");
  ui.run("restoreAiConfig()");
  assert.deepEqual(selected(ui), []);
  assert.equal(ui.element("aiPoolStart").disabled, true);
  const saved = JSON.parse(ui.storage.getItem("translation-compare-ai-project-config-v2:project"));
  assert.deepEqual(saved.poolSelections, []);
  assert.equal(Object.hasOwn(saved, "stage1PresetIds"), false);
});

test("迁移合并旧阶段选择，保留适用范围和显式空数组", () => {
  const ui = setup({ stage1PresetId: "p1", stage2PresetIds: ["p1", "p2"], stage3PresetIds: [], stage3PresetId: "p2" });
  assert.deepEqual(selected(ui).map((item) => [item.presetId, item.stages]), [
    ["p1", ["stage1", "stage2"]], ["p2", ["stage2"]],
  ]);
  ui.run("restoreAiConfig()");
  assert.equal(selected(ui).length, 2, "迁移仅发生一次");
});

test("旧未保存主连接迁入真实预设，保留连接与并发且刷新不重复创建", () => {
  const ui = setup({ protocol: "compatible", provider: "旧提供商", baseUrl: "https://old.invalid/v1", apiKey: "test-key", model: "old-model", concurrency: 7 });
  const first = selected(ui);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].stages, ["stage1"]);
  const config = ui.run("aiConfig()");
  assert.equal(config.presetPool[0].apiKey, "test-key");
  assert.equal(config.presetPool[0].concurrency, 7);
  ui.run("restoreAiConfig()");
  assert.deepEqual(selected(ui), first);
});

test("旧项目配置独立迁移，不继承其它项目的共享池", () => {
  const ui = setup({ poolSelections: [{ presetId: "p1" }] });
  ui.storage.setItem("translation-compare-ai-project-config-v2:project", JSON.stringify({ stage2PresetIds: ["p2"] }));
  ui.run("restoreAiConfig()");
  assert.deepEqual(selected(ui).map((item) => [item.presetId, item.stages]), [["p2", ["stage2"]]]);
});

test("运行时修改统一池原子同步，失败保留本地配置并明确提示", async () => {
  let reject = false;
  const ui = setup({ poolSelections: [{ presetId: "p1" }] }, {
    statusResponse: () => ({ ok: true, ai: { poolSupported: true, poolEnabled: true, running: true, kind: "ai", runId: "pool", projectKey: "project", rowsSignature: "rows", results: [] } }),
    apiResponses: { "/api/ai-proofread/presets": () => reject ? { ok: false, error: "服务暂不可用" } : { ok: true } },
  });
  await ui.settle();
  addPoolPreset(ui, "p2");
  await ui.settle();
  const post = ui.posts.find((entry) => entry.url === "/api/ai-proofread/presets");
  assert.equal(post.body.stage, "all");
  assert.equal(post.body.poolEnabled, true);
  assert.deepEqual(post.body.presets.map((item) => item.presetId), ["p1", "p2"]);
  reject = true;
  ui.run('setPoolPresetStages("p2", ["stage3"])');
  await ui.settle();
  assert.deepEqual(selected(ui)[1].stages, ["stage3"]);
  assert.match(toastMessages(ui).join("|"), /本地配置已保存.*当前运行未应用/);
});

test("状态轮询保留预设节点与焦点，并展示单份共享额度及冷却信息", async () => {
  const ui = setup({ poolSelections: [{ presetId: "p1" }] });
  await ui.settle();
  const node = ui.element("aiPoolPresets").children[0];
  const state = { poolSupported: true, poolEnabled: true, running: true, kind: "ai", runId: "pool", projectKey: "project", rowsSignature: "rows", results: [],
    poolRuntime: { state: "running", mode: "loop", round: 2, presets: [{ presetId: "p1", inFlight: 2, quota: 3, configuredConcurrency: 4, waitReason: "cooldown", retryAt: Date.now() + 30000, activeRows: [1, 2] }] } };
  ui.run(`renderAiStatus(${JSON.stringify(state)})`);
  assert.equal(ui.element("aiPoolPresets").children[0], node);
  assert.equal(node._poolControls.runtime.textContent, "总并发 2/4");
  assert.match(node._poolControls.runtime.title, /运行 2.*共享配额 3.*上限 4.*冷却中/);
  assert.match(ui.element("aiPoolStatus").textContent, /循环.*第 2 轮.*运行中/);
  ui.run(`renderAiStatus(${JSON.stringify({ ...state, running: false, poolRuntime: { ...state.poolRuntime, state: "blocked", blockedReason: "所有预设均拒答" } })})`);
  assert.match(ui.element("aiPoolStatus").textContent, /需要处理.*所有预设均拒答/);
  assert.doesNotMatch(node._poolControls.runtime.textContent, /运行 2|冷却中/);
});

test("旧主配置有未保存修改时迁入修改后的连接，原预设保持不变", () => {
  const ui = setup({ currentPresetId: "p1", protocol: "compatible", baseUrl: "https://changed.invalid/v1", model: "changed", concurrency: 9 });
  const config = ui.run("aiConfig()");
  assert.notEqual(config.presetPool[0].presetId, "p1");
  assert.equal(config.presetPool[0].baseUrl, "https://changed.invalid/v1");
  assert.equal(config.presetPool[0].model, "changed");
  const old = JSON.parse(ui.storage.getItem("translation-compare-ai-presets-v2")).find((preset) => preset.id === "p1");
  assert.equal(old.model, "fast");
});

test("另一个项目的运行状态不得触发本页池配置热更新", async () => {
  const ui = setup({ poolSelections: [{ presetId: "p1" }] }, {
    statusResponse: () => ({ ok: true, ai: { poolSupported: true, poolEnabled: true, running: true, kind: "ai", runId: "other", projectKey: "other", rowsSignature: "different", results: [] } }),
  });
  await ui.settle();
  addPoolPreset(ui, "p2");
  await ui.settle();
  assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/presets").length, 0);
  assert.equal(selected(ui).length, 2, "仍保存本页下次使用的配置");
});

test("阻塞收尾的面板与通知不宣称审核完成", async () => {
  const ui = setup({ poolSelections: [{ presetId: "p1" }] });
  await ui.settle();
  const base = { kind: "ai", poolEnabled: true, poolSupported: true, projectKey: "project", rowsSignature: "rows", runId: "blocked-run", results: [] };
  ui.run(`renderAiStatus(${JSON.stringify({ ...base, running: true, poolRuntime: { state: "running", mode: "loop", round: 1, presets: [] } })})`);
  ui.run(`renderAiStatus(${JSON.stringify({ ...base, running: false, finishedAt: "2026-11-13T00:00:00Z", poolRuntime: { state: "blocked", mode: "loop", round: 2, blockedReason: "仍有 1 行异常", presets: [] } })})`);
  assert.equal(ui.element("aiPanelState").textContent, "审核待处理");
  assert.match(toastMessages(ui).join("|"), /审核尚未完成.*仍有 1 行异常/);
  assert.doesNotMatch(toastMessages(ui).join("|"), /AI 校对完成/);
});

test("仅存过主连接的旧项目也独立迁移，不继承其它项目的新池", () => {
  const ui = setup({ poolSelections: [{ presetId: "p1" }] });
  ui.storage.setItem("translation-compare-ai-project-config-v2:project", JSON.stringify({ protocol: "compatible", model: "project-model", baseUrl: "https://project.invalid/v1" }));
  ui.run("restoreAiConfig()");
  const pool = ui.run("poolPresetsFor()");
  assert.equal(pool.length, 1);
  assert.notEqual(pool[0].presetId, "p1");
  assert.equal(pool[0].model, "project-model");
});

test("新池字段损坏也不会从旧阶段记录复活已移除预设", () => {
  const ui = setup({ poolSelections: null, stage1PresetIds: ["p1"] });
  assert.deepEqual(selected(ui), []);
});

test("热更新请求串行且合并连续编辑，旧回包不能覆盖新运行的提示", async () => {
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  let calls = 0;
  const state = { poolSupported: true, poolEnabled: true, running: true, kind: "ai", runId: "pool-one", projectKey: "project", rowsSignature: "rows", results: [] };
  const ui = setup({ poolSelections: [{ presetId: "p1" }] }, {
    statusResponse: () => ({ ok: true, ai: state }),
    apiResponses: { "/api/ai-proofread/presets": () => ++calls === 1 ? first : { ok: true } },
  });
  await ui.settle();
  addPoolPreset(ui, "p2");
  await ui.settle();
  ui.run('setPoolPresetStages("p2", ["stage2"])');
  ui.run('setPoolPresetStages("p2", ["stage3"])');
  await ui.settle();
  assert.equal(calls, 1);
  resolveFirst({ ok: true });
  await ui.settle();
  assert.equal(calls, 2);
  const posts = ui.posts.filter((item) => item.url === "/api/ai-proofread/presets");
  assert.deepEqual(posts[1].body.presets.find((item) => item.presetId === "p2").stages, ["stage3"]);
  assert.equal(posts[1].body.runId, "pool-one");

  let rejectOld;
  const late = new Promise((resolve) => { rejectOld = resolve; });
  const isolated = setup({ poolSelections: [{ presetId: "p1" }] }, {
    statusResponse: () => ({ ok: true, ai: state }),
    apiResponses: { "/api/ai-proofread/presets": () => late },
  });
  await isolated.settle();
  addPoolPreset(isolated, "p2");
  await isolated.settle();
  isolated.run(`renderAiStatus(${JSON.stringify({ ...state, runId: "pool-two" })})`);
  rejectOld({ ok: false, error: "旧运行已结束" });
  await isolated.settle();
  assert.doesNotMatch(toastMessages(isolated).join("|"), /旧运行已结束/);
});

test("预设存储写失败不写迁移完成标记，小配置可写也保留旧分配供下次重试", async () => {
  const legacy = { protocol: "compatible", baseUrl: "https://old.invalid/v1", model: "unsaved-main", stage2PresetIds: ["p2"] };
  const storage = storageFixture({
    "translation-compare-ai-presets-v2": JSON.stringify(presets),
    "translation-compare-ai-config-v2": JSON.stringify(legacy),
  });
  const write = storage.setItem.bind(storage);
  let failPresets = true;
  storage.setItem = (key, value) => {
    if (failPresets && key === "translation-compare-ai-presets-v2") throw new Error("QuotaExceededError");
    write(key, value);
  };
  const ui = createWorkbench(storage, { strictIds: true });
  await ui.settle();
  assert.equal(storage.getItem("translation-compare-ai-project-config-v2:project"), null);
  assert.equal(ui.element("aiPoolStart").disabled, true);
  assert.match(toastMessages(ui).join("|"), /旧主配置尚未迁入预设池.*原配置已保留/);
  ui.run("saveAiConfig()");
  const saved = JSON.parse(storage.getItem("translation-compare-ai-project-config-v2:project"));
  assert.equal(Object.hasOwn(saved, "poolSelections"), false);
  assert.deepEqual(saved.stage2PresetIds, ["p2"]);
  failPresets = false;
  ui.run("restoreAiConfig()");
  assert.equal(ui.run("poolMigrationPending"), false);
  const pool = ui.run("poolPresetsFor()");
  assert.equal(pool.some((item) => item.model === "unsaved-main" && item.stages.includes("stage1")), true);
  assert.equal(pool.some((item) => item.presetId === "p2" && item.stages.includes("stage2")), true);
  assert.equal(JSON.parse(storage.getItem("translation-compare-ai-project-config-v2:project")).poolSelections.length, 2);
});
