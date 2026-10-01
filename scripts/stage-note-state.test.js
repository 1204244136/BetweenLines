const test = require("node:test");
const assert = require("node:assert/strict");
const { latestAiNotePart, stageNoteState } = require("../src/workbenches/translation-compare/ai/stage-note-state");
const { createWorkbench, storageFixture, currentKey } = require("./workbench-fixture");

const initial = "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\n初审改案：本轮初审方案";
const unclear = "[AI校对]\n是否需要修改：待人工确认\nGatekeeper初审：初审存疑";
const reviewed = initial + "\nStylist复审[采纳]：同意\n复审改案：本轮初审方案";
const dispute = initial + "\nStylist复审[调整]：语序调整\n复审改案：本轮复审方案";
const arbitrated = dispute + "\nArbiter仲裁[复审方案]：采纳复审\n仲裁改案：本轮复审方案";

test("最新审核轮次：旧复审、旧仲裁和人工前后缀不污染本轮，兼容 CRLF", () => {
  for (const lineEnding of ["\n", "\r\n"]) {
    const note = ["人工备注", arbitrated, initial, "人工补充"].join("\n\n").replace(/\n/g, lineEnding);
    assert.equal(latestAiNotePart(note), initial.replace(/\n/g, lineEnding));
    const state = stageNoteState(note);
    assert.equal(state.pendingReview, true);
    assert.equal(state.reviewed, false);
    assert.equal(state.arbitrated, false);
    assert.equal(state.pendingArbitration, false);
  }
});

test("待复审只计本轮提改或存疑；历史提改不能污染本轮通过或失败", () => {
  for (const note of [initial, unclear, initial + "\nStylist复审："]) {
    assert.equal(stageNoteState(note).pendingReview, true);
  }
  for (const note of [reviewed, arbitrated, "[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改", "[AI校对]\n调用失败：超时"]) {
    assert.equal(stageNoteState(initial + "\n\n" + note).pendingReview, false);
  }
  assert.equal(stageNoteState(arbitrated + "\n\n" + dispute).pendingArbitration, true);
  assert.equal(stageNoteState("人工记录\n是否需要修改：是").pendingReview, false);
});

function fixture(records) {
  return createWorkbench(storageFixture({ [currentKey]: JSON.stringify(records) }), {
    rows: Object.keys(records).map((id) => ({ index: Number(id), jp: `原文${id}`, cn: `译文${id}`, signature: `sig-${id}` })),
    apiResponses: { "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "latest-round", results: [] } } },
  });
}

test("从初审继续剩下的：失败、终止及空备注行在单阶段和级联时都必须重试", async () => {
  for (const cascade of [false, true]) {
    const records = {
      1: { note: arbitrated + "\n\n[AI校对]\n调用失败：请求超时" },
      2: { note: "[AI校对]\n校对已终止。" },
      3: { note: "人工备注" },
      4: { note: "[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改" },
      5: { note: arbitrated },
      6: { note: initial, manualDone: true },
      7: { note: "" },
    };
    const ui = fixture(records);
    if (cascade) {
      ui.storage.setItem("translation-compare-ai-presets-v2", JSON.stringify([
        { id: "retry-stylist", name: "复审", protocol: "compatible", model: "test-stylist", baseUrl: "http://localhost:1234/v1" },
      ]));
      ui.run('aiIds.stage2Preset.value = "retry-stylist"');
    }
    await ui.run('startAiProofread({ continueOnly: true, stage: "stage1" })');
    const post = ui.posts.find((p) => p.url === "/api/ai-proofread/start");
    assert.ok(post);
    assert.equal(Boolean(post.body.stylistConfig), cascade);
    assert.deepEqual(post.body.completedIndexes.sort(), [4, 5, 6], "只能跳过有可用结论或人工确认的行");
    assert.equal(post.body.rowNotes[1], records[1].note, "保留原失败证据与历史记录");
  }
});

test("待复审统计、点击筛选、启动弹窗及请求跳过列表同源，历史备注保持原样", async () => {
  const records = {
    1: { note: arbitrated + "\n\n" + initial },
    2: { note: reviewed + "\n\n" + unclear },
    3: { note: initial, manualDone: true },
    4: { note: reviewed },
    5: { note: initial + "\n\n[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改" },
    6: { note: initial + "\n\n[AI校对]\n调用失败：超时" },
  };
  const ui = fixture(records);
  assert.equal(Number(ui.element("metricStage2Pending").textContent), 2);
  await ui.element("stage2PendingItem").dispatch("click");
  assert.deepEqual(Array.from(ui.run("filteredRows.map(row => row.index)")), [1, 2]);
  ui.run('aiIds.stage2Preset.value = "test-preset"');
  await ui.element("stage2Start").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true);
  assert.match(ui.element("aiConfirmMessage").innerHTML, /<strong>1<\/strong> 条文学复审方案.*<strong>2<\/strong> 条初审建议待复审/);
  await ui.element("aiConfirmKeep").dispatch("click");
  const post = ui.posts.find((p) => p.url === "/api/ai-proofread/start");
  assert.ok(post);
  assert.deepEqual(post.body.completedIndexes.sort(), [3, 4, 5, 6]);
  assert.equal(post.body.rowNotes[1], records[1].note);
  assert.equal(ui.run('notes["1"].note'), records[1].note);
  assert.equal(ui.run('parseAutomatedNote(notes["1"].note).stage2'), null);
  assert.equal(ui.run('parseAutomatedNote(notes["1"].note).stage1Revision'), "本轮初审方案");
});

test("全部旧轮次已复审但本轮待复审时，点击阶段二直接启动且不跳过", async () => {
  const ui = fixture({ 1: { note: reviewed + "\n\n" + initial } });
  ui.run('aiIds.stage2Preset.value = "test-preset"');
  await ui.element("stage2Start").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, false);
  const post = ui.posts.find((p) => p.url === "/api/ai-proofread/start");
  assert.ok(post);
  assert.deepEqual(post.body.completedIndexes, []);
});

test("仲裁待办按本轮逐行计数，已人工确认的历史定案不抵扣其它待办", async () => {
  const ui = fixture({
    1: { note: arbitrated + "\n\n" + dispute },
    2: { note: arbitrated, manualDone: true },
    3: { note: arbitrated + "\n\n" + initial },
  });
  assert.equal(ui.run("computeStageMetricsFromNotes().stage3Pending"), 1);
  assert.equal(Number(ui.element("metricStage3Pending").textContent), 1);
  await ui.element("stage3PendingItem").dispatch("click");
  assert.deepEqual(Array.from(ui.run("filteredRows.map(row => row.index)")), [1]);
  ui.run('aiIds.stage3Preset.value = "test-preset"');
  await ui.element("stage3Start").dispatch("click");
  const post = ui.posts.find((p) => p.url === "/api/ai-proofread/start");
  assert.ok(post);
  assert.equal(post.body.completedIndexes.includes(1), false);
});

test("重跑复审或仲裁只清当前轮次，完整保留历史轮次和人工备注", () => {
  for (const stage of ["stage2", "stage3"]) {
    const prefix = "人工备注\n\n" + arbitrated + "\n\n";
    const suffix = "\n\n人工补充";
    const ui = fixture({ 1: { note: prefix + arbitrated + suffix } });
    assert.equal(ui.run(`clearUnconfirmedStageNotes(${JSON.stringify(stage)})`), 1);
    const note = ui.run('notes["1"].note');
    assert.ok(note.startsWith(prefix));
    assert.ok(note.endsWith(suffix));
    const state = stageNoteState(note);
    assert.equal(state.arbitrated, false);
    assert.equal(state.reviewed, stage === "stage3");
  }
});
