const test = require("node:test");
const assert = require("node:assert/strict");
const { latestAiNotePart, stageNoteState } = require("../src/workbenches/translation-compare/ai/stage-note-state");
const { createWorkbench, storageFixture, currentKey } = require("./workbench-fixture");

const initial = "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\n初审改案：本轮初审方案";
const unclear = "[AI校对]\n是否需要修改：待人工确认\nGatekeeper初审：初审存疑";
const reviewed = initial + "\nStylist复审[采纳]：同意\n复审改案：本轮初审方案";
const dispute = initial + "\nStylist复审[调整]：语序调整\n复审改案：本轮复审方案";
const arbitrated = dispute + "\nArbiter仲裁[复审方案]：采纳复审\n仲裁改案：本轮复审方案";
const acceptedPendingArbitration = "[AI校对]\n是否需要修改：待终审\nGatekeeper初审：指代不明，无法确认\nStylist复审[采纳]：认可初审判断，尚无可用改案";

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
  const connection = { protocol: "compatible", model: "test-model", baseUrl: "http://localhost:1234/v1" };
  return createWorkbench(storageFixture({
    [currentKey]: JSON.stringify(records),
    "translation-compare-ai-config-v2": JSON.stringify(connection),
    "translation-compare-ai-presets-v2": JSON.stringify([
      { ...connection, id: "stage2-preset", name: "复审", model: "test-stylist" },
      { ...connection, id: "stage3-preset", name: "仲裁", model: "test-arbiter" },
    ]),
  }), {
    rows: Object.keys(records).map((id) => ({ index: Number(id), jp: `原文${id}`, cn: `译文${id}`, signature: `sig-${id}` })),
    apiResponses: { "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "latest-round", results: [] } } },
  });
}

function addStagePreset(ui, stage) {
  ui.element(stage + "PresetSelect").value = stage + "-preset";
  ui.element(stage + "PresetAdd").click();
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
    if (cascade) addStagePreset(ui, "stage2");
    await ui.run(`startAiProofread({ continueOnly: true, stage: ${JSON.stringify(cascade ? "all" : "stage1")} })`);
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
  addStagePreset(ui, "stage2");
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
  addStagePreset(ui, "stage2");
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
  addStagePreset(ui, "stage3");
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

test("下游失败保留上游结论与待办，异常只属于最新轮次和对应阶段", () => {
  for (const lineEnding of ["\n", "\r\n"]) {
    const reviewFailure = initial + "\nStylist复审调用异常：请求超时，Arbiter endpoint 未响应";
    const arbiterFailure = dispute + "\nArbiter仲裁调用异常：网络连接失败";
    for (const [note, stage, pendingKey] of [
      [reviewFailure, "stage2", "pendingReview"],
      [arbiterFailure, "stage3", "pendingArbitration"],
    ]) {
      const state = stageNoteState((arbitrated + "\n\n" + note).replace(/\n/g, lineEnding));
      assert.equal(state.failed, false, "上游仍有可用结论");
      assert.equal(state[pendingKey], true);
      assert.deepEqual(Object.keys(state.errors), [stage]);
      assert.deepEqual(stageNoteState(note + "\n\n" + arbitrated).errors, {});
    }
  }
  assert.deepEqual(stageNoteState("人工备注\n调用失败：超时").errors, {});
  assert.deepEqual(stageNoteState(initial + "\n分析：原译出现『调用失败』一词").errors, {});
});

test("复审采纳但无可用改案：明确待终审仍属于仲裁待办", () => {
  for (const lineEnding of ["\n", "\r\n"]) {
    const state = stageNoteState(acceptedPendingArbitration.replace(/\n/g, lineEnding));
    assert.equal(state.reviewed, true);
    assert.equal(state.diverged, true);
    assert.equal(state.pendingArbitration, true);
    assert.equal(state.pendingReview, false);
    assert.equal(state.arbitrated, false);
    assert.deepEqual(state.errors, {});
  }
});

test("从备注恢复采纳但待终审的行：仲裁计数与筛选保留未人工确认的待办", async () => {
  const ui = fixture({
    1: { note: acceptedPendingArbitration },
    2: { note: acceptedPendingArbitration, manualDone: true },
  });
  assert.equal(ui.run("computeStageMetricsFromNotes().stage3Pending"), 1);
  assert.equal(Number(ui.element("metricStage3Pending").textContent), 1);
  assert.equal(Number(ui.element("metricStage2Pending").textContent), 0);
  await ui.element("stage3PendingItem").dispatch("click");
  assert.deepEqual(Array.from(ui.run("filteredRows.map(row => row.index)")), [1]);
  assert.equal(ui.run('notes["1"].note'), acceptedPendingArbitration);
});

test("清空复审或仲裁重跑时移除本轮异常，保留上游、历史与人工确认行", () => {
  for (const [stage, prior, marker] of [
    ["stage2", initial, "Stylist复审调用异常：请求超时"],
    ["stage3", dispute, "Arbiter仲裁调用异常：网络连接失败"],
    ["stage2", initial, "文学复审调用异常：请求超时"],
    ["stage3", dispute, "终审仲裁调用异常：网络连接失败"],
  ]) {
    const prefix = "人工备注\n\n" + arbitrated + "\n\n";
    const suffix = "\n\n人工补充";
    const note = prefix + prior + "\n" + marker + suffix;
    const ui = fixture({ 1: { note }, 2: { note, manualDone: true } });
    assert.equal(ui.run(`clearUnconfirmedStageNotes(${JSON.stringify(stage)})`), 1);
    const revision = stage === "stage2" ? "本轮初审方案" : "本轮复审方案";
    assert.equal(ui.run('notes["1"].note'), prefix + prior + "\n修改结果：" + revision + suffix);
    assert.equal(ui.run('notes["2"].note'), note);
    assert.deepEqual(Object.keys(ui.run('stageNoteState(notes["1"].note).errors')), []);
    assert.equal(ui.run(`computeStageMetricsFromNotes().${stage}Errors`), 1, "人工确认行按原记录保留");
  }
});

test("仲裁失败续跑：单阶段只判断自身完成，一键开始仍须补仲裁待办", async () => {
  const failure = dispute + "\nArbiter仲裁调用异常：请求超时";
  for (const stage of ["stage1", "stage2", "all"]) {
    const ui = fixture({ 1: { note: failure }, 2: { note: arbitrated }, 3: { note: failure, manualDone: true } });
    addStagePreset(ui, "stage2");
    addStagePreset(ui, "stage3");
    await ui.run(`startAiProofread({ continueOnly: true, stage: ${JSON.stringify(stage)} })`);
    const post = ui.posts.find((item) => item.url === "/api/ai-proofread/start");
    assert.ok(post.body.arbiterConfig);
    assert.deepEqual(post.body.completedIndexes.sort(), stage === "all" ? [2, 3] : [1, 2, 3]);
    assert.equal(post.body.rowNotes[1], failure);
  }
});

test("初审待终审且没有改案：复审异常仍是待办，继续时不得跳过", async () => {
  const note = "[AI校对]\n是否需要修改：待终审\nGatekeeper初审：指代不明，无法确认\nStylist复审调用异常：请求超时";
  const state = stageNoteState(note);
  assert.equal(state.pendingReview, true);
  assert.equal(state.failed, false);
  const ui = fixture({ 1: { note } });
  assert.equal(ui.element("metricStage2Pending").textContent, 1);
  assert.equal(ui.element("metricStage2Errors").textContent, 1);
  addStagePreset(ui, "stage2");
  await ui.run('startAiProofread({ continueOnly: true, stage: "stage2" })');
  const post = ui.posts.find((item) => item.url === "/api/ai-proofread/start");
  assert.deepEqual(post.body.completedIndexes, []);
});
