const test = require("node:test");
const assert = require("node:assert/strict");
const { makeHtml } = require("./build-compare");
const { createWorkbench, storageFixture, currentKey } = require("./workbench-fixture");

const NOTE_NEEDS_EDIT = "[AI校对]\n语义是否相同：不同\n是否需要修改：是\nGatekeeper初审：建议修改\n初审改案：改案\n修改结果：改案";
const NOTE_UNCHANGED = "[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：无需修改\n分析：原译准确。";
const NOTE_PREFILTER_PASS = "[规则预筛]\n语义是否相同：相同\n是否需要修改：否\n分析：预筛通过。";
// 「待人工确认」只能由终审分发：这条必须真的走到终审，否则统计口径会把没到终审的存疑行也算进来。
const NOTE_NEEDS_CHECK = "[AI校对]\n语义是否相同：相同\n是否需要修改：待人工确认\nGatekeeper初审：存疑待定\nStylist复审[提交仲裁]：依据不足\nArbiter仲裁[存疑待定]：终审也无法定案\n分析：终审定案为待人工确认。";
const NOTE_PENDING_ARBITER = "[AI校对]\n语义是否相同：相同\n是否需要修改：待终审\nGatekeeper初审：存疑转人工\n分析：还没走到终审。";

function rowsFixture(count) {
  return Array.from({ length: count }, (_, offset) => ({
    index: offset + 1,
    jp: "原文" + (offset + 1),
    cn: "译文" + (offset + 1),
    relation: "1:1",
    score: 0.9,
    signature: "sig-" + (offset + 1),
  }));
}

test("工作台构建：右上角统计栏渲染「修改率」，未校对时显示 —", () => {
  const html = makeHtml(rowsFixture(1), {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: { jp: "A.txt", cn: "B.txt" },
    labels: { jp: "A 原文", cn: "B 译文" },
  }, {
    generatedAt: "2026-01-01T00:00:00.000Z",
    projectKey: "project",
    rowsSignature: "rows",
    notesStorage: { key: "notes" },
  });

  assert.match(html, /<div class="stat" id="modifyRateStat" title="[^"]*"><strong id="modifyRate">—<\/strong>修改率<\/div>/);
});

test("修改率：没有任何自动结论时显示 —，不把 0 行结论读成 0%", () => {
  const ui = createWorkbench(storageFixture({}));
  assert.equal(ui.element("modifyRate").textContent, "—");
  assert.match(ui.element("modifyRateStat").title, /尚无自动校对结论/);
});

test("修改率：最终建议修改 ÷ 已有自动结论，预筛通过、待人工确认与待终审都进分母", () => {
  const ui = createWorkbench(storageFixture({
    [currentKey]: JSON.stringify({
      1: { note: NOTE_PREFILTER_PASS, aiDone: true },
      2: { note: NOTE_UNCHANGED, aiDone: true },
      3: { note: NOTE_NEEDS_EDIT, aiDone: true },
      4: { note: NOTE_NEEDS_CHECK, aiDone: true },
      5: { note: NOTE_PENDING_ARBITER, aiDone: true },
    }),
  }), { rows: rowsFixture(5) });

  assert.equal(ui.element("modifyRate").textContent, "20%");
  assert.match(ui.element("modifyRateStat").title, /最终建议修改 1 行 \/ 已有自动结论 5 行/);
  assert.match(ui.element("modifyRateStat").title, /无需修改 2、待人工确认 1、待终审 1/);
  assert.match(ui.element("modifyRateStat").title, /调用失败的行不计入分母/, "分母口径要在悬停提示里说清，避免与「自动结果」数字对不上时无从解释");
});

test("修改率：调用失败的行不进分母，也不冒充「无需修改」", () => {
  const ui = createWorkbench(storageFixture({
    [currentKey]: JSON.stringify({
      1: { note: NOTE_NEEDS_EDIT, aiDone: true },
      2: { note: "[AI校对]\n调用失败：请求超时", aiDone: true },
    }),
  }), { rows: rowsFixture(2) });

  assert.equal(ui.element("modifyRate").textContent, "100%");
  assert.match(ui.element("modifyRateStat").title, /最终建议修改 1 行 \/ 已有自动结论 1 行/);
});

test("修改率：备注变化后随顶部统计一起刷新，保留一位小数", () => {
  const ui = createWorkbench(storageFixture({}));
  assert.equal(ui.element("modifyRate").textContent, "—");

  ui.run(`
    notes["1"] = { note: ${JSON.stringify(NOTE_NEEDS_EDIT)}, aiDone: true, manualDone: false };
    notes["2"] = { note: ${JSON.stringify(NOTE_UNCHANGED)}, aiDone: true, manualDone: false };
    notes["3"] = { note: ${JSON.stringify(NOTE_UNCHANGED)}, aiDone: true, manualDone: false };
    markNotesDirtyForMetrics();
    updateDoneCount();
  `);
  assert.equal(ui.element("modifyRate").textContent, "33.3%");

  ui.run(`
    notes["2"].manualDone = true;
    notes["2"].done = true;
    markNotesDirtyForMetrics();
    updateDoneCount();
  `);
  assert.equal(ui.element("doneCount").textContent, "1", "人工确认不改变修改率的分母");
  assert.equal(ui.element("modifyRate").textContent, "33.3%");
});
