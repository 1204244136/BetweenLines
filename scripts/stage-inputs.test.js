const assert = require("node:assert/strict");
const test = require("node:test");
const {
  prepareStageInputs, isStage2Candidate, isStage3DisputeRow,
} = require("../src/workbenches/translation-compare/ai/stage-inputs");
const { ROWS } = require("./workbench-fixture");

// 与 multiline-stage-notes 的现有多段样本相同；这里只检验准备时字段保留与阶段归属。
const initialRevision = "窗外的雨渐渐停了。\n\n他收起雨伞，沿着街道往前走。";
const reviewedRevision = "窗外的雨终于停了。\n\n他收好雨伞，沿着街道继续前行。";
const finalRevision = "窗外的雨已经停了。\n\n他收起雨伞，沿着街道继续前行。";
const passed = "[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改";
const initial = [
  "[AI校对]", "语义是否相同：不同", "是否需要修改：是",
  "Gatekeeper初审：建议修改时间与动作的表述。", "初审改案：" + initialRevision,
  "分析：初审保留两段叙述。", "修改结果：" + initialRevision,
].join("\n");
const reviewed = [
  "[AI校对]", "语义是否相同：不同", "是否需要修改：是",
  "Gatekeeper初审：建议修改时间与动作的表述。", "初审改案：" + initialRevision,
  "Stylist复审[调整]：调整措辞并保留分段。", "复审改案：" + reviewedRevision,
  "分析：复审方案提交仲裁。", "修改结果：" + reviewedRevision,
].join("\n");
const arbitrated = [
  reviewed, "Arbiter仲裁[结合方案]：结合两份方案，保留两段叙述。",
  "仲裁改案：" + finalRevision, "修改结果：" + finalRevision,
].join("\n");
const unclear = "[AI校对]\n语义是否相同：不同\n是否需要修改：待终审\nGatekeeper初审：指代不明，无法确认\n分析：指代不明，无法确认";
const failedReview = unclear + "\nStylist复审调用异常：stylist down";
const labels = { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" };
const indexes = (items) => items.map((item) => item.row?.index ?? item.index);

function prepare({ rows = ROWS, stage = "stage2", continueOnly = false, rowNotes = {},
  completed = [], resolved = [], config = {}, plan = {}, ...options } = {}) {
  return prepareStageInputs({
    rows, labels,
    config: {
      targetStage: stage, proofreadMode: "bilingual", target: "cn", continueOnly,
      rowNotes, completedIndexes: new Set(completed), ...config,
    },
    plan: { startsAt: stage, cascadeToStylist: true, cascadeToArbiter: true, ...plan },
    resolvedByTermTable: new Set(resolved), ...options,
  });
}

function memory(overrides = {}) {
  return {
    note: initial,
    stageResult: { needsEdit: true, decision: "neither" },
    decision: { needsEdit: true, decision: "neither", revisedText: initialRevision },
    ...overrides,
  };
}

test("三个起点按原口径划分队列：completed、术语定案和已走过阶段不共用一个 skip 计数", async (t) => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ ...ROWS[0], index: index + 1 }));
  const rowNotes = { 1: initial, 2: initial, 3: initial, 4: reviewed, 5: arbitrated, 6: passed, 7: "", 8: failedReview };
  const cases = [
    { stage: "stage1", continueOnly: false, stage1: [3, 4, 5, 6, 7, 8], stage2: [], stage3: [], skip: 1 },
    { stage: "stage1", continueOnly: true, stage1: [5, 6, 7], stage2: [3, 8], stage3: [4], skip: 1 },
    { stage: "stage2", continueOnly: false, stage1: [], stage2: [2, 3, 4, 5, 8], stage3: [], skip: 2 },
    { stage: "stage2", continueOnly: true, stage1: [], stage2: [2, 3, 8], stage3: [4], skip: 3 },
    { stage: "stage3", continueOnly: false, stage1: [], stage2: [], stage3: [4, 5], skip: 5 },
    { stage: "stage3", continueOnly: true, stage1: [], stage2: [], stage3: [4], skip: 6 },
  ];
  for (const expected of cases) {
    await t.test(`${expected.stage} / continueOnly=${expected.continueOnly}`, () => {
      const result = prepare({ rows, rowNotes, stage: expected.stage, continueOnly: expected.continueOnly,
        completed: [1], resolved: [2] });
      assert.deepEqual(indexes(result.stage1Rows), expected.stage1);
      assert.deepEqual(indexes(result.stageItems.stage2), expected.stage2);
      assert.deepEqual(indexes(result.stageItems.stage3), expected.stage3);
      assert.equal(result.skippedDone, expected.skip);
      for (const item of [...result.stageItems.stage2, ...result.stageItems.stage3]) {
        assert.equal(item.row, rows[item.row.index - 1], "条目保留原 row，派发仍可附加预设字段");
      }
    });
  }
});

test("是否接入下游决定级联准备；内存分歧不能替代仲裁续跑所需的复审备注", () => {
  const reusableResults = new Map([[1, memory({ arbCheck: { triggered: true } })]]);
  const sourceOnly = prepare({ stage: "stage1", continueOnly: true,
    rowNotes: { 2: initial, 3: reviewed }, reusableResults,
    plan: { cascadeToStylist: false, cascadeToArbiter: false } });
  assert.deepEqual(indexes(sourceOnly.stage1Rows), [1, 2, 3]);
  assert.deepEqual(sourceOnly.stageItems, { stage2: [], stage3: [] });
  const continued = prepare({ stage: "stage1", continueOnly: true, reusableResults,
    plan: { cascadeToStylist: false, cascadeToArbiter: true } });
  assert.deepEqual(indexes(continued.stage1Rows), [1, 2, 3]);
  assert.deepEqual(continued.stageItems.stage3, []);
});

test("缺失备注快照允许内存候选；显式 {} 与不吻合备注不能从旧内存复活待办", () => {
  const prior = memory();
  const reusableResults = new Map([[1, prior]]);
  const absent = prepare({ rows: [ROWS[0]], reusableResults });
  assert.equal(absent.stageItems.stage2.length, 1);
  assert.equal(absent.stageItems.stage2[0].decision.revisedText, initialRevision);
  const empty = prepare({ rows: [ROWS[0]], reusableResults, notesSnapshotProvided: true });
  assert.deepEqual(empty.stageItems.stage2, []);
  assert.equal(empty.skippedDone, 1);
  const cleared = prepare({ rows: [ROWS[0]], reusableResults, notesSnapshotProvided: true, rowNotes: { 1: passed } });
  assert.deepEqual(cleared.stageItems.stage2, []);
});

test("优先 prior，缺失时才读 current；最新备注吻合可无损复用，不吻合回到备注重建", () => {
  const prior = memory({ note: "人工记录\n\n" + initial + "\n\n人工补充", decision: {
    needsEdit: true, decision: "neither", revisedText: initialRevision, summary: "prior-marker",
  } });
  const current = memory({ decision: { needsEdit: true, decision: "neither", summary: "current-marker" } });
  const reads = [];
  const selected = prepare({ rows: [ROWS[0]], rowNotes: { 1: initial }, notesSnapshotProvided: true,
    reusableResults: new Map([[1, prior]]), currentResultFor(index) { reads.push(index); return current; } });
  assert.equal(selected.stageItems.stage2[0].decision.summary, "prior-marker");
  assert.deepEqual(reads, []);
  const fallback = prepare({ rows: [ROWS[0]], currentResultFor(index) { reads.push(index); return current; } });
  assert.equal(fallback.stageItems.stage2[0].decision.summary, "current-marker");
  assert.deepEqual(reads, [1]);
  const mismatched = prepare({ rows: [ROWS[0]], rowNotes: { 1: unclear }, notesSnapshotProvided: true,
    reusableResults: new Map([[1, prior]]), currentResultFor: () => assert.fail("prior 不吻合时不改用第二份旧结论") });
  assert.equal(mismatched.stageItems.stage2[0].decision.better, "unclear");
  assert.equal(mismatched.stageItems.stage2[0].decision.revisedText, "");
  assert.notEqual(mismatched.stageItems.stage2[0].decision.summary, "prior-marker");
});

test("非空备注控制候选资格，不能让更强的内存改案或分歧覆盖明确通过备注", () => {
  const prior = memory({ arbCheck: { triggered: true } });
  for (const stage of ["stage2", "stage3"]) {
    const result = prepare({ stage, rows: [ROWS[0]], rowNotes: { 1: passed }, reusableResults: new Map([[1, prior]]) });
    assert.deepEqual(result.stageItems[stage], []);
    assert.equal(result.skippedDone, 1);
  }
});

test("复审浅拷贝 decision 并补 better，仲裁续跑共享完整复审 decision；重跑从备注重建", () => {
  const nested = { retained: true };
  const decision = { needsEdit: true, decision: "neither", revisedText: initialRevision, nested };
  const prior = memory({ decision });
  const stage2 = prepare({ rows: [ROWS[0]], reusableResults: new Map([[1, prior]]) }).stageItems.stage2[0];
  assert.notEqual(stage2.decision, decision);
  assert.equal(stage2.decision.nested, nested);
  assert.equal(stage2.decision.better, "neither");
  assert.equal(Object.hasOwn(decision, "better"), false);
  const uncertain = memory({ decision, stageResult: { needsContext: true, decision: "unclear" } });
  assert.equal(prepare({ rows: [ROWS[0]], reusableResults: new Map([[1, uncertain]]) }).stageItems.stage2[0].decision.better, "unclear");

  const completeDecision = { ...decision, stylistReview: { revisedText: reviewedRevision, critique: { attitude: "modify" } } };
  const reviewedMemory = memory({ note: reviewed, decision: completeDecision, arbCheck: { triggered: true } });
  const options = { stage: "stage3", rows: [ROWS[0]], rowNotes: { 1: reviewed }, notesSnapshotProvided: true,
    reusableResults: new Map([[1, reviewedMemory]]) };
  const stage3 = prepare({ ...options, continueOnly: true }).stageItems.stage3[0];
  assert.equal(stage3.decision, completeDecision);
  assert.deepEqual(stage3.arbCheck, { triggered: true });
  assert.equal(stage3.lowScore, null);
  const rerun = prepare({ ...options, continueOnly: false }).stageItems.stage3[0];
  assert.notEqual(rerun.decision, completeDecision);
  assert.equal(rerun.decision.stylistReview.revisedText, reviewedRevision);
});

test("双语固定译文目标，三语选择 B/C；文本取原 tw，空内存字段保持 || fallback", () => {
  const row = { ...ROWS[0], tw: "台版原文", twCn: "不同的简繁归一化展示" };
  const emptyFields = memory({ targetKey: "", targetLabel: "", targetText: "", counterpartKey: "", counterpartLabel: "", counterpartText: "" });
  const cases = [
    { proofreadMode: "bilingual", target: "tw", targetKey: "cn", counterpartKey: "jp" },
    { proofreadMode: "trilingual", target: "cn", targetKey: "cn", counterpartKey: "tw" },
    { proofreadMode: "trilingual", target: "tw", targetKey: "tw", counterpartKey: "cn" },
  ];
  for (const expected of cases) {
    const result = prepare({ rows: [row], config: expected, reusableResults: new Map([[1, emptyFields]]) });
    const item = result.stageItems.stage2[0];
    assert.equal(item.targetKey, expected.targetKey);
    assert.equal(item.counterpartKey, expected.counterpartKey);
    assert.equal(item.targetText, row[expected.targetKey]);
    assert.equal(item.counterpartText, row[expected.counterpartKey]);
    assert.equal(item.targetLabel, labels[expected.targetKey]);
    assert.equal(item.counterpartLabel, labels[expected.counterpartKey]);
  }
  const reconstructed = prepare({ rows: [row], rowNotes: { 1: initial }, labels: { jp: "", cn: "", tw: "" },
    config: { proofreadMode: "trilingual", target: "tw" } }).stageItems.stage2[0];
  assert.equal(reconstructed.targetText, row.tw);
  assert.equal(reconstructed.targetLabel, "非原文 C");
  assert.equal(reconstructed.counterpartLabel, "非原文 B");
});

test("备注重建只读最新轮次，保留多段初审和复审改案，排除人工前后缀", () => {
  const full = "人工记录\n\n" + initial + "\n\n" + reviewed + "\n\n人工补充";
  const result = prepare({ stage: "stage3", rows: [ROWS[0]], rowNotes: { 1: full } });
  const item = result.stageItems.stage3[0];
  assert.equal(item.decision.stage1RevisedText, initialRevision);
  assert.equal(item.decision.revisedText, initialRevision);
  assert.equal(item.decision.stage2RevisedText, reviewedRevision);
  assert.equal(item.decision.stylistReview.revisedText, reviewedRevision);
  assert.equal(item.decision.stylistReview.critique.rationale, "调整措辞并保留分段。");
  assert.equal(item.decision.summary, "复审方案提交仲裁。");
  assert.doesNotMatch(JSON.stringify(item.decision), /人工记录|人工补充/);
  assert.equal(item.lowScore, null);
});

test("复审调用失败的待终审行仍是存疑候选，摘要内存缺复审详情时从备注补齐仲裁输入", () => {
  const failed = prepare({ rows: [ROWS[0]], rowNotes: { 1: failedReview }, continueOnly: true });
  assert.equal(failed.stageItems.stage2.length, 1);
  const decision = failed.stageItems.stage2[0].decision;
  assert.equal(decision.needsContext, true);
  assert.equal(decision.better, "unclear");
  assert.equal(decision.revisedText, "");
  assert.equal(decision.summary, "指代不明，无法确认");
  const summaryMemory = memory({ note: reviewed, stageResult: { stage: "stylist", decision: "escalate" },
    decision: undefined, arbCheck: { triggered: true } });
  const arbitration = prepare({ stage: "stage3", continueOnly: true, rows: [ROWS[0]], rowNotes: { 1: reviewed },
    notesSnapshotProvided: true, reusableResults: new Map([[1, summaryMemory]]) });
  assert.equal(arbitration.stageItems.stage3[0].decision.stylistReview.revisedText, reviewedRevision);
  assert.equal(arbitration.stageItems.stage3[0].decision.stage1RevisedText, initialRevision);
});

test("继续模式排除内存已复审/已仲裁，但显式重跑仍保留对应候选", () => {
  const reviewedMemory = memory({ stylistReview: { retained: true } });
  const arbitratedMemory = memory({ arbitration: { winner: "synthesis" } });
  for (const [stage, prior] of [["stage2", reviewedMemory], ["stage3", arbitratedMemory]]) {
    const options = { stage, rows: [ROWS[0]], reusableResults: new Map([[1, prior]]) };
    const continued = prepare({ ...options, continueOnly: true });
    assert.deepEqual(continued.stageItems[stage], []);
    assert.equal(continued.skippedDone, 1);
    const rerun = prepare({ ...options, continueOnly: false });
    assert.equal(rerun.stageItems[stage].length, 1);
    assert.equal(rerun.skippedDone, 0);
  }
});

test("main 兼容导出复用同一候选函数，保留阶段三的旧 row 参数", () => {
  const main = require("../src/workbenches/translation-compare/ai/ai-proofread");
  assert.equal(main.isStage2Candidate, isStage2Candidate);
  assert.equal(main.isStage3DisputeRow, isStage3DisputeRow);
  assert.equal(main.isStage2Candidate(unclear), true);
  assert.equal(main.isStage3DisputeRow(ROWS[0], reviewed), true);
});
