const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture } = require("./workbench-fixture");
const { createPresetTools } = require("../src/workbenches/translation-compare/ai-presets");

const original = "他站在房间门口，认真地看了看走廊尽头的窗户，随后转身走进了安静的房间。";
const initial = "他站在房间门口，仔细地看了看走廊尽头的窗户，随后转身走进了安静的房间。";
const reviewed = "他站在房间门口，仔细地望了望走廊尽头的窗户，随后转身走进了安静的房间。";
const arbitrated = "他站在房间门口，仔细地望了望走廊尽头的窗户，然后转身走进了安静的房间。";

function initialNote() {
  return ["[AI校对]", "语义是否相同：不同", "是否需要修改：是",
    "Gatekeeper初审：用词需要修改。", "初审改案：" + initial, "修改结果：" + initial].join("\n");
}

function pendingArbitrationNote() {
  return ["[AI校对]", "语义是否相同：不同", "是否需要修改：待终审",
    "Gatekeeper初审：用词需要修改。", "初审改案：" + initial,
    "Stylist复审[调整]：调整表达，提交仲裁。", "复审改案：" + reviewed].join("\n");
}

function completedNote() {
  return ["[AI校对]", "语义是否相同：不同", "是否需要修改：是",
    "Gatekeeper初审：用词需要修改。", "初审改案：" + initial,
    "Stylist复审[调整]：调整表达。", "复审改案：" + reviewed,
    "Arbiter仲裁[combined]：综合两个版本。", "仲裁改案：" + arbitrated,
    "修改结果：" + arbitrated].join("\n");
}

function workbench(note = initialNote(), targetText = original) {
  const storage = storageFixture();
  const presetTools = createPresetTools();
  for (const stage of [2, 3]) {
    presetTools.savePreset(storage, { id: "preset-" + stage, name: "阶段" + stage,
      protocol: "compatible", baseUrl: "https://example.invalid/v1", model: "model-" + stage });
  }
  const ui = createWorkbench(storage, { rows: [
    { index: 1, jp: "原文", cn: targetText, relation: "1:1", signature: "sig-1", score: 0.9 },
  ] });
  ui.run(`notes["1"] = ${JSON.stringify({ note, manualDone: false, aiDone: true })}; applyFilters()`);
  return ui;
}

function render(ui) {
  return ui.run('renderNoteSummary(notes["1"], "1")');
}

function stageButton(html, stage) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map((match) => match[0]).find((button) => button.includes(`data-apply-stage="${stage}"`)) || "";
}

function expectDisabled(html, stage) {
  const button = stageButton(html, stage);
  assert.ok(button, `阶段 ${stage} 应显示版本按钮`);
  assert.match(button, /\sdisabled(?:\s|=|>)/, `阶段 ${stage} 尚无可用改案，应禁用`);
  assert.doesNotMatch(button, /class="[^"]*\bis-active\b/, "不可用版本不得显示为当前版本");
}

function expectEnabled(html, stage) {
  const button = stageButton(html, stage);
  assert.ok(button, `阶段 ${stage} 应显示版本按钮`);
  assert.doesNotMatch(button, /\sdisabled(?:\s|=|>)/, `阶段 ${stage} 有完整改案，应可选择`);
}

async function addStage(ui, stage) {
  const select = ui.element(`stage${stage}PresetSelect`);
  select.value = "preset-" + stage;
  await select.dispatch("change", { target: select });
  ui.element(`stage${stage}PresetAdd`).click();
}

function assertCannotApply(ui, stage) {
  const before = ui.run("JSON.stringify(notes)");
  ui.run(`applyStageRevision("1", "${stage}")`);
  assert.equal(ui.run("JSON.stringify(notes)"), before, `阶段 ${stage} 不可用时不得改写备注中的修改结果`);
}

function attachVisibleRevisionSlot(ui) {
  // 最小 DOM 夹具不解析 HTML 子节点；只挂接可见行与版本栏容器，
  // 阶段配置事件、版本按钮 HTML 与文本编辑状态仍运行真实注入脚本。
  ui.run(`
    const revisionEditorForTest = { value: "正在编辑且尚未离开输入框的文本", focused: true };
    let visibleSlotHtmlForTest = renderNoteSummary(notes["1"], "1")
      .match(/<div class="revision-stage-pills"[\\s\\S]*?<\\/div>/)?.[0] || "";
    let visibleSlotUpdatesForTest = 0;
    const visibleSlotForTest = {};
    Object.defineProperty(visibleSlotForTest, "innerHTML", {
      get() { return visibleSlotHtmlForTest; },
      set(value) { visibleSlotHtmlForTest = value; visibleSlotUpdatesForTest += 1; },
    });
    const visibleRowForTest = { querySelector(selector) {
      if (selector === "[data-revision-stage-slot]") return visibleSlotForTest;
      if (selector.includes("revision-editor")) return revisionEditorForTest;
      return null;
    } };
    renderedRowsById.set("1", visibleRowForTest);
    document.activeElement = revisionEditorForTest;
  `);
}

test("版本按钮：未启用下游时，初审改案和修改结果同时存在也不显示复审或终审", () => {
  const ui = workbench();
  const html = render(ui);
  assert.equal(stageButton(html, 2), "");
  assert.equal(stageButton(html, 3), "");
});

test("版本按钮：仅选择候选预设不代表启用下游阶段", async () => {
  const ui = workbench();
  for (const stage of [2, 3]) {
    const select = ui.element(`stage${stage}PresetSelect`);
    select.value = "preset-" + stage;
    await select.dispatch("change", { target: select });
  }
  assert.equal(stageButton(render(ui), 2), "");
  assert.equal(stageButton(render(ui), 3), "");
});

test("版本按钮：已添加复审且该行待复审时显示禁用按钮，终审尚无待办则隐藏", async () => {
  const ui = workbench();
  await addStage(ui, 2);
  await addStage(ui, 3);
  const html = render(ui);
  expectDisabled(html, 2);
  assert.equal(stageButton(html, 3), "");
  assertCannotApply(ui, 2);
});

test("版本按钮：终审可独立启用，待终审且没有默认改案时仍显示禁用终审", async () => {
  const ui = workbench(pendingArbitrationNote());
  await addStage(ui, 3);
  const html = render(ui);
  expectEnabled(html, 1);
  expectEnabled(html, 2);
  expectDisabled(html, 3);
  assert.doesNotMatch(html, /class="revision-editor"|data-writeback-revision=|class="copy-revision"/,
    "等待终审的过程稿不能自动变成可写回的默认成品");
  assertCannotApply(ui, 3);
});

test("版本按钮：已启用下游但该行无需复审或仲裁时不显示待执行按钮", async () => {
  const ui = workbench(["[AI校对]", "语义是否相同：相同", "是否需要修改：否", "Gatekeeper初审：无需修改。"].join("\n"));
  await addStage(ui, 2);
  await addStage(ui, 3);
  assert.equal(stageButton(render(ui), 2), "");
  assert.equal(stageButton(render(ui), 3), "");
});

test("版本按钮：真实阶段改案在预设移除后仍可选择，且选择写入对应文本", async () => {
  const ui = workbench(completedNote());
  await addStage(ui, 2);
  await addStage(ui, 3);
  for (const stage of [2, 3]) ui.element(`stage${stage}PresetTags`).children[0].children[2].click();
  for (const [stage, expected] of [[1, initial], [2, reviewed], [3, arbitrated]]) {
    expectEnabled(render(ui), stage);
    ui.run(`applyStageRevision("1", "${stage}")`);
    assert.equal(ui.run('notes["1"].revisionText'), expected);
    assert.equal(ui.run('notes["1"].revisionStageActive'), String(stage));
  }
});

test("版本按钮：真实复审记录缺改案时显示禁用按钮，不能用初审替代复审文本", () => {
  const ui = workbench(["[AI校对]", "语义是否相同：不同", "是否需要修改：待终审",
    "Gatekeeper初审：提出修改。", "初审改案：" + initial,
    "Stylist复审[驳回]：当前改案不成立，提交仲裁。"].join("\n"));
  expectDisabled(render(ui), 2);
  assertCannotApply(ui, 2);
});

test("版本按钮：终审存疑且未提供可用改案时禁用终审，保留初审历史稿供明确选择", () => {
  const ui = workbench(["[AI校对]", "语义是否相同：不同", "是否需要修改：待人工确认",
    "Gatekeeper初审：提出修改。", "初审改案：" + initial,
    "Stylist复审[驳回]：当前改案不成立，提交仲裁。",
    "Arbiter仲裁[存疑待定]：无法确定修改结果，转人工确认。"].join("\n"));
  const html = render(ui);
  expectEnabled(html, 1);
  expectDisabled(html, 2);
  expectDisabled(html, 3);
  assertCannotApply(ui, 2);
  assertCannotApply(ui, 3);
});

test("版本按钮：各阶段局部提议不能当成整段版本选择", () => {
  const target = original + '\n\n' + original;
  const ui = workbench(["[AI校对]", "语义是否相同：不同", "是否需要修改：待人工确认",
    "Gatekeeper初审：需要修改词语。", "初审改案：仔细",
    "Stylist复审[调整]：建议调整用词。", "复审改案：认真",
    "Arbiter仲裁[存疑]：局部词语待人工处理。", "仲裁改案：仔细看"].join("\n"), target);
  const html = render(ui);
  for (const stage of [1, 2, 3]) {
    expectDisabled(html, stage);
    assertCannotApply(ui, stage);
  }
});

test("版本选择：没有执行下游时直接调用也不得把初审修改结果冒充复审或终审", () => {
  const ui = workbench();
  assertCannotApply(ui, 2);
  assertCannotApply(ui, 3);
});

test("版本按钮和选择只读取最新一轮，历史复审终审不可混入新初审", () => {
  const ui = workbench(completedNote() + "\n\n人工备注：保留历史记录。\n\n" + initialNote());
  const html = render(ui);
  assert.equal(stageButton(html, 2), "");
  assert.equal(stageButton(html, 3), "");
  assertCannotApply(ui, 2);
  assertCannotApply(ui, 3);
});

test("版本按钮：人工已确认行不显示待执行占位，真实历史稿仍可选择", async () => {
  const ui = workbench();
  await addStage(ui, 2);
  await addStage(ui, 3);
  ui.run('notes["1"].manualDone = true');
  assert.equal(stageButton(render(ui), 2), "");
  assert.equal(stageButton(render(ui), 3), "");
  ui.run(`notes["1"].note = ${JSON.stringify(completedNote())}`);
  for (const stage of [1, 2, 3]) expectEnabled(render(ui), stage);
});

test("版本按钮：复审或终审调用失败保留禁用待重试状态，不能冒充已有改案", async () => {
  for (const [stage, note] of [
    [2, initialNote() + "\nStylist复审调用异常：请求超时。"],
    [3, pendingArbitrationNote() + "\nArbiter仲裁调用异常：请求超时。"],
  ]) {
    const ui = workbench(note);
    await addStage(ui, stage);
    expectDisabled(render(ui), stage);
    assertCannotApply(ui, stage);
  }
});

test("版本按钮：添加和移除阶段预设立即更新版本栏并保留当前编辑器", async () => {
  const ui = workbench();
  attachVisibleRevisionSlot(ui);
  assert.equal(stageButton(ui.run("visibleSlotHtmlForTest"), 2), "");
  await addStage(ui, 2);
  expectDisabled(ui.run("visibleSlotHtmlForTest"), 2);
  assert.equal(ui.run("visibleSlotUpdatesForTest"), 1);
  await ui.element("stage2PresetSelect").dispatch("change");
  assert.equal(ui.run("visibleSlotUpdatesForTest"), 1, "相同配置不重复改写版本栏 DOM");
  ui.element("stage2PresetTags").children[0].children[2].click();
  assert.equal(stageButton(ui.run("visibleSlotHtmlForTest"), 2), "");
  assert.equal(ui.run("visibleSlotUpdatesForTest"), 2);
  assert.equal(ui.run('renderedRowsById.get("1").querySelector(".revision-editor") === revisionEditorForTest'), true);
  assert.equal(ui.run("document.activeElement === revisionEditorForTest"), true);
  assert.equal(ui.run("revisionEditorForTest.value"), "正在编辑且尚未离开输入框的文本");
});

test("版本按钮：无阶段轨迹字段的合法初审仍按待复审状态显示禁用按钮", async () => {
  const ui = workbench(["[AI校对]", "语义是否相同：不同", "是否需要修改：是",
    "分析：用词需要修改。", "修改结果：" + initial].join("\n"));
  await addStage(ui, 2);
  expectDisabled(render(ui), 2);
  assertCannotApply(ui, 2);
});

test("版本按钮：无轨迹且无改案的待复审行，可以从空容器即时出现待执行按钮", async () => {
  const ui = workbench(["[AI校对]", "语义是否相同：不同", "是否需要修改：是", "分析：需要结合更多上下文。"].join("\n"));
  assert.match(render(ui), /data-revision-stage-slot="1"/);
  attachVisibleRevisionSlot(ui);
  assert.equal(ui.run("visibleSlotHtmlForTest"), "");
  await addStage(ui, 2);
  expectDisabled(ui.run("visibleSlotHtmlForTest"), 2);
  ui.element("stage2PresetTags").children[0].children[2].click();
  assert.equal(ui.run("visibleSlotHtmlForTest"), "");
});
