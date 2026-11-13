const assert = require("node:assert/strict");
const test = require("node:test");
const { storageFixture, createWorkbench, toastMessages, addPoolPreset } = require("./workbench-fixture");

const initial = "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\n初审改案：已有改案";
const reviewed = initial + "\nStylist复审[采纳]：认可初审方案\n复审改案：已有改案";
const dispute = initial + "\nStylist复审[调整]：提出复审方案\n复审改案：复审方案";
const arbitrated = dispute + "\nArbiter仲裁[复审方案]：采纳复审\n仲裁改案：复审方案";
const failed = "[AI校对]\n调用失败：请求超时";

function createReadyWorkbench({ configured = [], startResponse } = {}) {
  const ui = createWorkbench(storageFixture({
    "translation-compare-ai-config-v2": JSON.stringify({ model: "proofread-model", protocol: "compatible" }),
    "translation-compare-ai-presets-v2": JSON.stringify([
      { id: "stage1-preset", name: "初审", protocol: "compatible", model: "proofread-model" },
      { id: "stage2-preset", name: "复审", protocol: "compatible", model: "review-model" },
      { id: "stage3-preset", name: "仲裁", protocol: "compatible", model: "arbiter-model" },
    ]),
  }), {
    strictIds: true,
    confirm() { assert.fail("点击 AI 开始不应调用原生确认框"); },
    apiResponses: {
      "/api/ai-proofread/start": startResponse || { ok: true, ai: { running: true, runId: "resume-run", results: [] } },
    },
  });
  for (const stage of ["stage1", ...configured]) addPoolPreset(ui, stage + "-preset", [stage]);
  return ui;
}

function seedNotes(ui, records) {
  ui.run(`Object.assign(notes, ${JSON.stringify(records)}); updateStageMetricsDashboard();`);
}

function assertNoStartChoice(ui) {
  assert.doesNotMatch(ui.html, /id="aiConfirm(?:Dialog|Keep|Clear|Cancel)"/);
  assert.equal(ui.run('document.getElementById("aiConfirmDialog")'), null);
  assert.equal(ui.posts.some((post) => /\/(?:results|cache)\/clear$/.test(post.url)), false);
}

for (const stage of ["stage1", "stage2", "stage3", "all"]) {
  test(`${stage} 开始始终直接继续，保留已有方案、失败记录和人工确认`, async () => {
    const ui = createReadyWorkbench({ configured: ["stage2", "stage3"] });
    const note = stage === "stage2" ? reviewed : stage === "stage3" ? arbitrated : initial;
    const pending = stage === "stage2" ? initial : stage === "stage3" ? dispute : failed;
    const records = {
      1: { note: "人工备注\n\n" + note, revisionText: "保留的修改结果", revisionTarget: "cn", aiDone: true, manualDone: false },
      2: { note: pending, aiDone: pending !== failed, manualDone: false },
      3: { note: arbitrated, revisionText: "人工定案", revisionTarget: "cn", aiDone: true, manualDone: true, done: true },
    };
    seedNotes(ui, records);
    const before = ui.run("JSON.stringify(notes)");

    await ui.settle();
    await ui.run(`startAiProofread({ stage: ${JSON.stringify(stage)} })`);
    await ui.settle();

    const posts = ui.posts.filter((post) => post.url === "/api/ai-proofread/start");
    assert.equal(posts.length, 1, "一次点击直接发起一次启动请求");
    assert.equal(posts[0].body.stage, stage);
    assert.equal(posts[0].body.continueOnly, true);
    assert.deepEqual(posts[0].body.completedIndexes.sort(), ["stage2", "stage3"].includes(stage) ? [1, 3] : [3]);
    assert.deepEqual(posts[0].body.forgetResultIndexes, []);
    assert.equal(posts[0].body.rowNotes[1], records[1].note);
    assert.equal(posts[0].body.rowNotes[2], pending);
    assert.equal(ui.run("JSON.stringify(notes)"), before);
    assertNoStartChoice(ui);
    assert.doesNotMatch(toastMessages(ui).join("|"), /请选择|已清空|从未人工确认处开始/);
  });
}

for (const stage of ["stage1", "all"]) {
  test(`${stage} 首次开始也使用继续模式，并保留规则预筛和人工备注`, async () => {
    const ui = createReadyWorkbench();
    const prefilter = "[规则预筛]\n语义是否相同：相同\n是否需要修改：否\n分析：预筛通过。";
    seedNotes(ui, { 1: { note: prefilter }, 2: { note: "用户自己写的备注" } });
    const before = ui.run("JSON.stringify(notes)");
    await ui.settle();
    await ui.element("aiPoolStart").dispatch("click");
    const post = ui.posts.find((item) => item.url === "/api/ai-proofread/start");
    assert.ok(post);
    assert.equal(post.body.continueOnly, true);
    assert.equal(ui.run("JSON.stringify(notes)"), before);
    assertNoStartChoice(ui);
  });
}

test("共享池续跑不得将只差复审的行标记为已完成", async () => {
  for (const stage of ["stage1", "all"]) {
    const ui = createReadyWorkbench({ configured: ["stage2"] });
    seedNotes(ui, { 1: { note: initial, aiDone: true } });
    await ui.settle();
    await ui.run(`startAiProofread({ stage: ${JSON.stringify(stage)} })`);
    const post = ui.posts.find((item) => item.url === "/api/ai-proofread/start");
    assert.equal(post.body.stage, stage);
    assert.equal(post.body.continueOnly, true);
    assert.ok(post.body.stylistConfig);
    assert.deepEqual(post.body.completedIndexes, []);
    assertNoStartChoice(ui);
  }
});

test("一键开始遇到失效复审预设时阻止启动并保留已有备注", async () => {
  const ui = createReadyWorkbench();
  seedNotes(ui, { 1: { note: initial, aiDone: true } });
  await ui.settle();
  ui.run('sharedPoolSelections.push({ presetId: "preset_gone", stages: ["stage2"], stagePriorities: {} }); updateStagePresetDependencies();');
  assert.equal(ui.element("aiPoolStart").disabled, true);
  await ui.element("aiPoolStart").dispatch("click");
  assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/start").length, 0);
  assert.equal(ui.run('notes["1"].note'), initial);
  assert.match(ui.element("aiPoolStart").title, /预设.*失效/);
  assertNoStartChoice(ui);
});

test("仲裁全部完成后启动仍携带完成排除且完整保留各阶段方案", async () => {
  const ui = createReadyWorkbench({ configured: ["stage3"] });
  seedNotes(ui, {
    1: { note: arbitrated, revisionText: "复审方案", aiDone: true },
    2: { note: arbitrated, revisionText: "人工定案", aiDone: true, manualDone: true, done: true },
  });
  const before = ui.run("JSON.stringify(notes)");
  await ui.settle();
  await ui.run('startAiProofread({ stage: "stage3" })');
  assert.deepEqual(ui.posts.find((post) => post.url === "/api/ai-proofread/start").body.completedIndexes.sort(), [1, 2]);
  assert.equal(ui.run("JSON.stringify(notes)"), before);
  assertNoStartChoice(ui);
});

test("启动失败时仍保留已有结果与修改内容，不产生清除请求", async () => {
  const ui = createReadyWorkbench({ startResponse: { ok: false, error: "模型暂不可用" } });
  seedNotes(ui, { 1: { note: initial, revisionText: "已有改案", aiDone: true } });
  const before = ui.run("JSON.stringify(notes)");
  await ui.settle();
  await ui.element("aiPoolStart").dispatch("click");
  await ui.settle();
  assert.equal(ui.posts.find((post) => post.url === "/api/ai-proofread/start").body.continueOnly, true);
  assert.equal(ui.run("JSON.stringify(notes)"), before);
  assert.match(toastMessages(ui).join("|"), /模型暂不可用/);
  assertNoStartChoice(ui);
});
