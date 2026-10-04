const test = require("node:test");
const assert = require("node:assert/strict");
const { latestAiNotePart, stageNoteState } = require("../src/workbenches/translation-compare/ai/stage-note-state");
const { createWorkbench, storageFixture, currentKey, projectKey } = require("./workbench-fixture");

const initialRevision = "窗外的雨渐渐停了。\n\n他收起雨伞，沿着街道往前走。";
const reviewedRevision = "窗外的雨终于停了。\n\n他收好雨伞，沿着街道继续前行。";
const finalRevision = "窗外的雨已经停了。\n\n他收起雨伞，沿着街道继续前行。";
const initial = [
  "[AI校对]", "语义是否相同：不同", "是否需要修改：是",
  "Gatekeeper初审：建议修改时间与动作的表述。",
  "初审改案：" + initialRevision,
  "分析：初审保留两段叙述。",
  "修改结果：" + initialRevision,
].join("\n");
const reviewed = [
  "[AI校对]", "语义是否相同：不同", "是否需要修改：是",
  "Gatekeeper初审：建议修改时间与动作的表述。",
  "初审改案：" + initialRevision,
  "Stylist复审[调整]：调整措辞并保留分段。",
  "复审改案：" + reviewedRevision,
  "分析：复审方案提交仲裁。",
  "修改结果：" + reviewedRevision,
].join("\n");
const arbitrated = [
  "[AI校对]", "语义是否相同：不同", "是否需要修改：是",
  "Gatekeeper初审：建议修改时间与动作的表述。",
  "初审改案：" + initialRevision,
  "Stylist复审[调整]：调整措辞并保留分段。",
  "复审改案：" + reviewedRevision,
  "Arbiter仲裁[结合方案]：结合两份方案，保留两段叙述。",
  "仲裁改案：" + finalRevision,
  "分析：三阶段审核完成。",
  "修改结果：" + finalRevision,
].join("\n");

function fixture(note = "", options = {}) {
  const records = note ? { 1: { note, aiDone: true, rowSig: "sig-1" } } : {};
  return createWorkbench(storageFixture({ [currentKey]: JSON.stringify(records) }), options);
}

test("多段审核备注：最新轮次保留字段内空行并排除人工前后缀，兼容 LF/CRLF", () => {
  for (const ending of ["\n", "\r\n"]) {
    const current = arbitrated.replace(/\n/g, ending);
    const fullNote = ["人工记录", initial, arbitrated, "人工补充"].join("\n\n").replace(/\n/g, ending);
    assert.equal(latestAiNotePart(fullNote), current);
    const state = stageNoteState(fullNote);
    assert.equal(state.reviewed, true);
    assert.equal(state.arbitrated, true);
    assert.equal(state.pendingReview, false);
    assert.equal(state.pendingArbitration, false);
    assert.equal(state.text.includes("人工补充"), false);
  }
});

test("多段三阶段结果：客户端解析与待复审统计保留完整改案", () => {
  const ui = fixture("人工记录\n\n" + arbitrated + "\n\n人工补充");
  const parsed = ui.run('parseAutomatedNote(notes["1"].note)');
  assert.equal(parsed.stage1Revision, initialRevision);
  assert.equal(parsed.stage2Revision, reviewedRevision);
  assert.equal(parsed.stage3Revision, finalRevision);
  assert.equal(parsed.revision, finalRevision);
  assert.equal(parsed.analysis.includes("人工补充"), false);
  const metrics = ui.run("computeStageMetricsFromNotes()");
  assert.equal(metrics.stage2Pending, 0);
  assert.equal(metrics.stage2Reviewed, 1);
  assert.equal(metrics.stage3Arbitrated, 1);
  assert.equal(Number(ui.element("metricStage2Pending").textContent), 0);
});

test("末尾修改结果缺少独立改案佐证时，未知续文与人工尾注不能进入写回", () => {
  const expectedRevision = "窗外的雨已经停了。";
  const safePart = [
    "[AI校对]", "语义是否相同：不同", "是否需要修改：是",
    "未知说明：这行只提供额外说明。",
    "分析：修改结果之后的空行续文没有独立阶段改案佐证。",
    "修改结果：" + expectedRevision,
  ].join("\n");
  for (const ending of ["\n", "\r\n"]) {
    const fullNote = [safePart, "没有证据支持并入修改结果的续文。", "人工补充"].join("\n\n").replace(/\n/g, ending);
    assert.equal(latestAiNotePart(fullNote), safePart.replace(/\n/g, ending));
    const ui = fixture();
    ui.run(`writeNote("1", ${JSON.stringify(fullNote)}, true)`);
    const parsed = ui.run('parseAutomatedNote(notes["1"].note)');
    assert.equal(parsed.modify, "是", "标量判定不能拼入下一行未知说明");
    assert.equal(parsed.revision, expectedRevision);
    assert.equal(ui.run('notes["1"].revisionText'), expectedRevision);
    assert.equal(ui.run('notes["1"].note'), fullNote, "无法归属的文字仍完整保存在备注中");
    assert.equal(stageNoteState(fullNote).pendingReview, true);
  }
});

test("多段修改结果：writeNote 和服务端状态增量完整写入备注与持久化改案", () => {
  const ui = fixture();
  ui.run(`writeNote("1", ${JSON.stringify(initial)}, true)`);
  assert.equal(ui.run('notes["1"].revisionText'), initialRevision);
  const runId = "multiline-run";
  for (const [revision, note, expected] of [[1, reviewed, reviewedRevision], [2, arbitrated, finalRevision]]) {
    ui.run(`renderAiStatus(${JSON.stringify({
      kind: "ai", runId, projectKey, rowsSignature: "rows", running: false,
      resultRevision: revision,
      results: [{ runId, index: 1, signature: "sig-1", resultRevision: revision, status: "suggested", done: true, note }],
    })})`);
    assert.equal(ui.run('notes["1"].revisionText'), expected);
    ui.run("flushNotes()");
    assert.equal(ui.run('JSON.parse(notesStorage.getItem(storageKey))["1"].revisionText'), expected);
  }
  assert.equal(ui.run("computeStageMetricsFromNotes().stage2Pending"), 0);
  assert.equal(ui.run("computeStageMetricsFromNotes().stage3Arbitrated"), 1);
});

test("多段旧备注恢复：修复解析故障留下的空改案，保留人工清空与手改", () => {
  const records = {
    1: { note: arbitrated, revisionText: "", revisionTarget: "", aiDone: true },
    2: { note: arbitrated, revisionText: "", revisionTarget: "cn", aiDone: true },
    3: { note: arbitrated, revisionText: "人工调整后的完整叙述。", revisionTarget: "cn", aiDone: true },
    4: { note: arbitrated, revisionText: "", revisionTarget: "", manualDone: true, aiDone: true },
  };
  const ui = createWorkbench(storageFixture({ [currentKey]: JSON.stringify(records) }), {
    rows: Object.keys(records).map((id) => ({ index: Number(id), jp: "原文测试", cn: "译文测试", signature: `sig-${id}` })),
  });
  assert.equal(ui.run('notes["1"].revisionText'), finalRevision);
  assert.equal(ui.run('revisionTargetFor(notes["1"])'), "cn");
  assert.equal(ui.run('notes["2"].revisionText'), "");
  assert.equal(ui.run('notes["3"].revisionText'), records[3].revisionText);
  assert.equal(ui.run('notes["4"].revisionText'), "");
});

test("多段阶段清空：删除整个下游字段，保留完整上游改案、历史与人工前后缀", () => {
  for (const stage of ["stage2", "stage3"]) {
    const prefix = "人工记录\n\n" + arbitrated + "\n\n";
    const suffix = "\n\n人工补充";
    const ui = fixture(prefix + arbitrated + suffix);
    assert.equal(ui.run(`clearUnconfirmedStageNotes(${JSON.stringify(stage)})`), 1);
    const fullNote = ui.run('notes["1"].note');
    assert.ok(fullNote.startsWith(prefix));
    assert.ok(fullNote.endsWith(suffix));
    const current = latestAiNotePart(fullNote);
    const parsed = ui.run('parseAutomatedNote(notes["1"].note)');
    assert.equal(parsed.stage1Revision, initialRevision);
    assert.equal(parsed.revision, stage === "stage2" ? initialRevision : reviewedRevision);
    assert.equal(ui.run('notes["1"].revisionText'), parsed.revision);
    assert.equal(current.includes(finalRevision.split("\n\n")[1]), false, "仲裁字段的后续段落不能残留");
    assert.equal(parsed.stage3, null);
    if (stage === "stage2") {
      assert.equal(parsed.stage2, null);
      assert.equal(current.includes(reviewedRevision.split("\n\n")[1]), false, "复审字段的后续段落不能残留");
      assert.equal(stageNoteState(fullNote).pendingReview, true);
    } else {
      assert.equal(parsed.stage2Revision, reviewedRevision);
      assert.equal(stageNoteState(fullNote).pendingArbitration, true);
    }
  }
});

test("多段混合备注全清空：所有 AI 轮次与续段一起删除，仅保留人工记录", () => {
  const ui = fixture("人工记录\n\n" + initial + "\n\n" + arbitrated + "\n\n人工补充");
  assert.equal(ui.run("clearUnconfirmedAiProofreadNotes()"), 1);
  const note = ui.run('notes["1"]');
  assert.equal(note.note, "人工记录\n\n人工补充");
  assert.equal(note.revisionText, "");
  assert.equal(note.aiDone, false);
  assert.equal(note.note.includes("沿着街道"), false);
});
