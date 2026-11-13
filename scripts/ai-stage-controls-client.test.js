const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture, toastMessages } = require("./workbench-fixture");
const stages = ["stage1", "stage2", "stage3"];
const initial = "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\n初审改案：初审方案";
const dispute = initial + "\nStylist复审[调整]：复审有不同方案\n复审改案：复审方案";
const arbitrated = dispute + "\nArbiter仲裁[复审方案]：采纳复审\n仲裁改案：复审方案";

function poolControlWorkbench({ active = [], startResponse, stopResponse, statusResponse, strictIds = true } = {}) {
  const activeStages = new Set(active);
  const state = () => ({
    kind: "ai", projectKey: "project", rowsSignature: "rows", runId: "stage-controls",
    poolSupported: true, poolEnabled: true, running: activeStages.size > 0, stageMode: "all",
    stageCascade: { toStylist: true, toArbiter: true },
    stageControls: Object.fromEntries(stages.map((stage) => [stage, { running: activeStages.has(stage), stopRequested: false }])),
    stagePipelines: Object.fromEntries(stages.map((stage) => [stage, { inFlight: 0, pending: 0, activeRows: [] }])),
    total: 3, results: [],
  });
  const ui = createWorkbench(storageFixture({
    "translation-compare-ai-config-v2": JSON.stringify({ poolSelections: [{ presetId: "p1" }] }),
    "translation-compare-ai-presets-v2": JSON.stringify([
      { id: "p1", name: "共享模型", protocol: "compatible", baseUrl: "https://example.invalid/v1", model: "model" },
    ]),
  }), {
    strictIds,
    statusResponse: () => statusResponse ? statusResponse(state()) : { ok: true, ai: state() },
    apiResponses: {
      "/api/ai-proofread/start": (request) => {
        const body = JSON.parse(request.body);
        for (const stage of stages) activeStages.add(stage);
        const result = { ok: true, ai: state() };
        return startResponse ? startResponse(result, body) : result;
      },
      "/api/ai-proofread/stop": (request) => {
        const body = JSON.parse(request.body);
        activeStages.clear();
        const result = { ok: true, ai: state() };
        return stopResponse ? stopResponse(result, body) : result;
      },
    },
  });
  return { ui, activeStages, state };
}
function seedNotes(ui, notes) {
  ui.run(`Object.assign(notes, ${JSON.stringify(Object.fromEntries(Object.entries(notes).map(([index, note]) => [index, { note, aiDone: true, manualDone: false }])))}); updateStageMetricsDashboard();`);
}
function assertButtons(ui, active) {
  assert.equal(ui.element("aiPoolStart").disabled, active.length > 0);
  assert.equal(ui.element("aiPoolStop").disabled, active.length === 0);
  assert.equal(ui.element("aiPoolMode").disabled, active.length > 0);
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("启动池发送统一配置并自动衔接三阶段，停止始终作用于全池", async () => {
  const { ui } = poolControlWorkbench();
  await ui.settle();
  assertButtons(ui, []);
  seedNotes(ui, { 1: initial });
  ui.element("aiPoolMode").value = "loop";
  await ui.element("aiPoolStart").dispatch("click");
  await ui.settle();
  const start = ui.posts.find((item) => item.url === "/api/ai-proofread/start").body;
  assert.equal(start.stage, "all");
  assert.equal(start.poolEnabled, true);
  assert.equal(start.poolMode, "loop");
  assert.equal(start.continueOnly, true);
  assert.equal(start.rowNotes[1], initial);
  assertButtons(ui, stages);
  await ui.element("aiPoolStop").dispatch("click");
  await ui.settle();
  assert.equal(ui.posts.at(-1).body.stage, "all");
  assert.equal(ui.run('notes["1"].note'), initial);
  assertButtons(ui, []);
});

test("刷新恢复：阶段等待上游、队列为空也仍可停止整个池", async () => {
  const { ui } = poolControlWorkbench({ active: ["stage2", "stage3"] });
  await ui.settle();
  assertButtons(ui, stages);
  await ui.refresh();
  assertButtons(ui, stages);
});

test("启动请求未落定时不能重复启动或停止，落定后恢复停止入口", async () => {
  const reply = deferred();
  let payload;
  const { ui } = poolControlWorkbench({ startResponse(value) { payload = value; return reply.promise; } });
  await ui.settle();
  const pending = ui.element("aiPoolStart").dispatch("click");
  await ui.settle();
  assert.equal(ui.element("aiPoolStop").disabled, true);
  await ui.element("aiPoolStart").dispatch("click");
  await ui.element("aiPoolStop").dispatch("click");
  assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/start").length, 1);
  assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/stop").length, 0);
  reply.resolve(payload);
  await pending;
  await ui.settle();
  assertButtons(ui, stages);
});

test("停止请求未落定时不能重新启动池", async () => {
  const reply = deferred();
  let payload;
  const { ui } = poolControlWorkbench({ active: stages, stopResponse(value) { payload = value; return reply.promise; } });
  await ui.settle();
  const pending = ui.element("aiPoolStop").dispatch("click");
  await ui.settle();
  assert.equal(ui.element("aiPoolStart").disabled, true);
  await ui.element("aiPoolStart").dispatch("click");
  assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/start").length, 0);
  reply.resolve(payload);
  await pending;
  await ui.settle();
  assertButtons(ui, []);
});

test("迟到的停止前状态不能恢复已停阶段，结果游标留待新轮询正常接收", async () => {
  const oldPoll = deferred();
  let pollCount = 0;
  const result = { runId: "stage-controls", resultRevision: 1, index: 1, signature: "sig-1", status: "done", done: true, note: initial };
  const { ui, state } = poolControlWorkbench({
    active: ["stage1"],
    statusResponse(current) {
      pollCount += 1;
      if (pollCount === 2) return oldPoll.promise;
      return { ok: true, ai: pollCount > 2 ? { ...current, results: [result], resultRevision: 1 } : current };
    },
  });
  await ui.settle();
  ui.run("let raceResultWrites = 0; const originalRaceWriteNote = writeNote; writeNote = (...args) => { raceResultWrites += 1; return originalRaceWriteNote(...args); };");
  const beforeStop = state();
  await ui.refresh();
  assert.equal(pollCount, 2, "旧轮询尚未完成");
  await ui.element("aiPoolStop").dispatch("click");
  await ui.settle();
  assertButtons(ui, []);
  const timerStart = ui.timeouts.length;
  oldPoll.resolve({ ok: true, ai: { ...beforeStop, results: [result], resultRevision: 1 } });
  await ui.settle();
  assertButtons(ui, []);
  assert.equal(ui.run("currentAiRunning"), false, "停止前的 running=true 不得回滚控制状态");
  assert.equal(ui.run("aiResultReception.snapshot().resultRevision"), 0, "丢弃旧状态不能消费其中结果的游标");
  assert.equal(ui.run("raceResultWrites"), 0);
  const freshPollTimer = ui.timeouts.slice(timerStart).find((timer) => timer.delay === 16 && !timer.cleared);
  assert.ok(freshPollTimer, "失效轮询安排一次补取");
  freshPollTimer.cleared = true;
  await freshPollTimer.callback();
  await ui.settle();
  assert.ok(pollCount >= 3, "尚未完成的旧轮询失效后自动补发新轮询");
  assert.equal(ui.run('latestAiNotePart(notes["1"].note)'), initial, "被丢弃回包的结果仍由新轮询完整重取");
  assert.equal(ui.run("raceResultWrites"), 1);
  assert.equal(ui.run("aiResultReception.snapshot().resultRevision"), 1);
  await ui.refresh();
  assert.equal(ui.run("raceResultWrites"), 1, "重取到同一结果也不重复写备注");
});

for (const stage of ["stage2", "stage3"]) {
  test(`旧快照兼容清除入口：${stage} 活动时保留备注及同轮结果接收状态`, async () => {
    // 当前页面已移除清除按钮；沿用接收回归的兼容 DOM，验证保留入口所绑定的真实 handler。
    const { ui, activeStages, state } = poolControlWorkbench({ active: [stage], strictIds: false });
    await ui.settle();
    const originalNote = stage === "stage2" ? initial : dispute;
    const completedNote = stage === "stage2" ? initial + "\nStylist复审[采纳]：复审保留初审方案" : arbitrated;
    seedNotes(ui, { 1: originalNote });
    ui.run(`renderAiStatus(${JSON.stringify({ ...state(), resultRevision: 3 })})`);
    const receptionBefore = JSON.stringify(ui.run("aiResultReception.snapshot()"));
    assert.equal(ui.element("clearAiLog").listenerCount("click"), 1, "运行真实清除入口 handler");
    await ui.element("clearAiLog").dispatch("click");
    await ui.settle();
    assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/cache/clear").length, 0, "活动阶段必须在本地拦截清除请求");
    assert.equal(JSON.stringify(ui.run("aiResultReception.snapshot()")), receptionBefore, "不能重置已接收运行号或游标");
    assert.equal(ui.run('notes["1"].note'), originalNote);
    assertButtons(ui, [stage]);
    assert.match(toastMessages(ui).join("|"), /仍在运行.*先停止/);

    activeStages.clear();
    const result = { runId: "stage-controls", resultRevision: 4, index: 1, signature: "sig-1", status: "done", done: true, note: completedNote };
    ui.run(`renderAiStatus(${JSON.stringify({ ...state(), finishedAt: "2026-01-01T00:00:00.000Z", results: [result], resultRevision: 4 })})`);
    assert.equal(ui.run('latestAiNotePart(notes["1"].note)'), completedNote, "清除被拒绝后，同一运行结束时的结果仍正常交付，不能被 ignoreRun 丢弃");
    assert.equal(ui.run("aiResultReception.snapshot().resultRevision"), 4);
    assertButtons(ui, []);
  });
}

for (const allowed of [["stage1"], ["stage3"]]) {
  test(`只配置 ${allowed.join(",")} 不得把缺阶段覆盖的待办标为完成`, async () => {
    const { ui } = poolControlWorkbench();
    await ui.settle();
    ui.run(`setPoolPresetStages("p1", ${JSON.stringify(allowed)})`);
    seedNotes(ui, { 1: initial, 2: dispute, 3: arbitrated });
    await ui.element("aiPoolStart").dispatch("click");
    const body = ui.posts.find((post) => post.url === "/api/ai-proofread/start").body;
    assert.deepEqual(body.completedIndexes, [3]);
    assert.equal(body.rowNotes[1], initial);
    assert.equal(body.rowNotes[2], dispute);
  });
}
