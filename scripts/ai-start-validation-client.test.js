const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture, addPoolPreset, toastMessages } = require("./workbench-fixture");

function setup(presets = [], config = {}, options = {}) {
  return createWorkbench(storageFixture({
    "translation-compare-ai-presets-v2": JSON.stringify(presets),
    "translation-compare-ai-config-v2": JSON.stringify({ poolSelections: [], ...config }),
  }), { strictIds: true, ...options });
}
const good = { id: "good", name: "可用模型", model: "model", protocol: "compatible", baseUrl: "https://example.invalid/v1" };

for (const model of ["", "   ", "custom"]) {
  test(`空白或占位模型 ${JSON.stringify(model)} 不能启动池，已有备注保留`, async () => {
    const ui = setup([good, { ...good, id: "bad", name: "未配置", model }]);
    await ui.settle();
    addPoolPreset(ui, "good");
    addPoolPreset(ui, "bad");
    ui.run('notes["1"] = { note: "人工备注", manualDone: true };');
    assert.equal(ui.element("aiPoolStart").disabled, true);
    await ui.element("aiPoolStart").dispatch("click");
    assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/start").length, 0);
    assert.equal(ui.run('notes["1"].note'), "人工备注");
    assert.match(toastMessages(ui).join("|"), /尚未选择模型/);
  });
}

test("空池不回退编辑区主配置，所有阶段关闭也不能启动", async () => {
  const ui = setup([good], { model: "editor-model" });
  await ui.settle();
  assert.equal(ui.element("aiPoolStart").disabled, true);
  addPoolPreset(ui, "good", []);
  assert.equal(ui.element("aiPoolStart").disabled, true);
  await ui.element("aiPoolStart").dispatch("click");
  assert.match(toastMessages(ui).join("|"), /至少.*开启.*阶段/);
  assert.equal(ui.posts.length, 0);
});

test("已失效预设不会被有效预设掩盖，移除后恢复启动", async () => {
  const ui = setup([good], { poolSelections: [{ presetId: "good" }, { presetId: "missing" }] });
  await ui.settle();
  assert.equal(ui.element("aiPoolStart").disabled, true);
  assert.match(ui.element("aiPoolStart").title, /已失效/);
  const invalid = ui.element("aiPoolPresets").children.find((node) => node.dataset.presetId === "missing");
  await invalid._poolControls.remove.dispatch("click");
  assert.equal(ui.element("aiPoolStart").disabled, false);
});

test("只有下游阶段的池可以续跑已有结果，编辑区未配置不影响有效预设", async () => {
  const ui = setup([good]);
  await ui.settle();
  addPoolPreset(ui, "good", ["stage3"]);
  assert.equal(ui.element("aiPoolStart").disabled, false);
  await ui.element("aiPoolStart").dispatch("click");
  const post = ui.posts.find((entry) => entry.url === "/api/ai-proofread/start");
  assert.ok(post);
  assert.equal(post.body.stage, "all");
  assert.deepEqual(post.body.presetPool[0].stages, ["stage3"]);
});

test("旧服务缺少共享池能力时拒绝请求并明确要求重启，不能静默按旧模式运行", async () => {
  const ui = setup([good], { poolSelections: [{ presetId: "good" }] }, {
    statusResponse: () => ({ ok: true, ai: { running: false, kind: "", results: [] } }),
  });
  await ui.settle();
  assert.equal(ui.element("aiPoolStart").disabled, true);
  await ui.element("aiPoolStart").dispatch("click");
  assert.equal(ui.posts.length, 0);
  assert.match(toastMessages(ui).join("|"), /尚不支持共享预设池.*重启/);
});

test("启动前再次检查池配置，直接调用不能绕过模型门禁", async () => {
  const ui = setup([good]);
  await ui.settle();
  await ui.run("startAiProofread()");
  assert.equal(ui.posts.length, 0);
  assert.match(toastMessages(ui).join("|"), /先添加模型预设/);
});

test("阶段全关只暂停路由，不能借此绕过池中失效配置的校验", async () => {
  const ui = setup([good], { poolSelections: [{ presetId: "good" }, { presetId: "missing", stages: [] }] });
  await ui.settle();
  assert.equal(ui.element("aiPoolStart").disabled, true);
  assert.match(ui.element("aiPoolStart").title, /已失效/);
  await ui.element("aiPoolStart").dispatch("click");
  assert.equal(ui.posts.length, 0);
});
