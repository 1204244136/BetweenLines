const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture, toastMessages } = require("./workbench-fixture");

const presetKey = "translation-compare-ai-presets-v2";
const initial = "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\n初审改案：初审方案";
const dispute = initial + "\nStylist复审[调整]：复审有不同方案\n复审改案：复审方案";
const starts = (ui) => ui.posts.filter((post) => post.url === "/api/ai-proofread/start");

async function workbench(presets = []) {
  const ui = createWorkbench(storageFixture({ [presetKey]: JSON.stringify(presets) }));
  await ui.settle();
  ui.run('aiIds.model.value = "main-model"; saveAiConfig();');
  return ui;
}

for (const model of ["", "   ", "custom"]) {
  test(`主模型 ${JSON.stringify(model)} 不得启动，也不得清空已有备注`, async () => {
    const ui = await workbench();
    ui.run(`aiIds.model.value = ${JSON.stringify(model)}; notes["1"] = { note: ${JSON.stringify(initial)}, aiDone: true }; saveAiConfig();`);
    assert.equal(ui.element("stage1Start").disabled, true);
    assert.equal(ui.element("aiStartAll").disabled, true);
    for (const stage of ["stage1", "all"]) await ui.run(`promptAndStartAi("${stage}")`);
    await ui.settle();
    assert.equal(starts(ui).length, 0);
    assert.equal(ui.element("aiConfirmDialog").open, false);
    assert.equal(ui.run('notes["1"].note'), initial);
    assert.match(toastMessages(ui).join("|"), /阶段一.*模型/);
  });
}

for (const stage of ["stage1", "stage2", "stage3"]) {
  test(`${stage} 适用列表内空模型不能被其它有效预设掩盖`, async () => {
    const ui = await workbench([
      { id: "good", name: "有效", protocol: "compatible", model: "good-model" },
      { id: "empty", name: "未配置", protocol: "compatible", model: "" },
    ]);
    ui.run(`stagePresetSelections.${stage} = ["good", "empty"]; updateStagePresetDependencies();`);
    assert.equal(ui.element(`${stage}Start`).disabled, true);
    assert.equal(ui.element("aiStartAll").disabled, true);
    for (const target of [stage, "all"]) await ui.run(`promptAndStartAi("${target}")`);
    await ui.settle();
    assert.equal(starts(ui).length, 0);
    assert.match(toastMessages(ui).join("|"), /未配置.*模型/);
  });
}

test("下游未添加预设时禁用独立开始，一键开始仍只运行有效初审", async () => {
  const ui = await workbench();
  assert.equal(ui.element("stage1Start").disabled, false);
  assert.equal(ui.element("stage2Start").disabled, true);
  assert.equal(ui.element("stage3Start").disabled, true);
  assert.equal(ui.element("aiStartAll").disabled, false);
  await ui.element("aiStartAll").dispatch("click");
  await ui.settle();
  assert.equal(starts(ui).length, 1);
  assert.equal(starts(ui)[0].body.stage, "all");
  assert.equal(starts(ui)[0].body.stylistConfig, null);
  assert.equal(starts(ui)[0].body.arbiterConfig, null);
});

for (const stage of ["stage2", "stage3"]) {
  test(`${stage} 独立启动只检查自身模型，保留其它阶段停止入口`, async () => {
    const ui = await workbench([{ id: "good", name: "有效", protocol: "compatible", model: "good-model" }]);
    const note = stage === "stage2" ? initial : dispute;
    ui.run(`aiIds.model.value = ""; stagePresetSelections.${stage} = ["good"]; notes["1"] = { note: ${JSON.stringify(note)} }; updateStagePresetDependencies();`);
    assert.equal(ui.element(`${stage}Start`).disabled, false);
    await ui.element(`${stage}Start`).dispatch("click");
    await ui.settle();
    assert.equal(starts(ui).length, 1);
    assert.equal(starts(ui)[0].body.stage, stage);
    ui.run(`currentAiRunning = true; latestStageControls = { ${stage}: { running: true } }; stagePresetSelections.${stage} = []; setAllStageButtonsRunning();`);
    assert.equal(ui.element(`${stage}Stop`).disabled, false);
    assert.equal(ui.element("aiStopAll").disabled, false);
  });
}

test("重跑弹窗打开后模型失效，确认清空仍应保留已有备注", async () => {
  const ui = await workbench();
  ui.run(`notes["1"] = { note: ${JSON.stringify(initial)}, aiDone: true };`);
  await ui.element("stage1Start").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true);
  ui.run('aiIds.model.value = ""; saveAiConfig();');
  await ui.element("aiConfirmClear").dispatch("click");
  await ui.settle();
  assert.equal(starts(ui).length, 0);
  assert.equal(ui.run('notes["1"].note'), initial);
});

for (const stage of ["stage1", "stage2", "stage3"]) {
  test(`${stage} 失效预设不得回落，移除后立即恢复按钮`, async () => {
    const ui = await workbench();
    ui.run(`stagePresetSelections.${stage} = ["deleted"]; updateStagePresetDependencies();`);
    assert.equal(ui.element(`${stage}Start`).disabled, true);
    assert.equal(ui.element("aiStartAll").disabled, true);
    await ui.run(`promptAndStartAi("${stage}")`);
    await ui.run('promptAndStartAi("all")');
    assert.equal(starts(ui).length, 0);
    assert.match(toastMessages(ui).join("|"), /预设已失效/);
    ui.run(`stagePresetSelections.${stage} = []; updateStagePresetDependencies();`);
    assert.equal(ui.element("aiStartAll").disabled, false);
    assert.equal(ui.element(`${stage}Start`).disabled, stage !== "stage1");
  });
}

test("补全主模型后立即解锁开始，空主配置不影响有效初审预设", async () => {
  const ui = await workbench([{ id: "good", name: "有效", protocol: "compatible", model: "good-model" }]);
  ui.run('aiIds.model.value = ""; saveAiConfig();');
  assert.equal(ui.element("stage1Start").disabled, true);
  ui.run('aiIds.model.value = "fixed-model"; saveAiConfig();');
  assert.equal(ui.element("stage1Start").disabled, false);
  ui.run('aiIds.model.value = ""; stagePresetSelections.stage1 = ["good"]; updateStagePresetDependencies();');
  assert.equal(ui.element("stage1Start").disabled, false);
  await ui.element("stage1Start").dispatch("click");
  await ui.settle();
  assert.equal(starts(ui).length, 1);
  assert.equal(starts(ui)[0].body.model, "good-model");
});

test("直接启动与清除旧运行记录均不能绕过空模型门禁", async () => {
  const ui = await workbench();
  ui.run('aiIds.model.value = ""; saveAiConfig();');
  const reception = JSON.stringify(ui.run("aiResultReception.snapshot()"));
  await ui.run('startAiProofread({ stage: "stage1" })');
  assert.equal(starts(ui).length, 0);
  assert.equal(ui.run("pendingStageStarts.size"), 0);
  assert.equal(JSON.stringify(ui.run("aiResultReception.snapshot()")), reception);
  ui.run("renderClearedAiStatus()");
  assert.equal(ui.element("stage1Start").disabled, true);
  assert.equal(ui.element("aiStartAll").disabled, true);
});
