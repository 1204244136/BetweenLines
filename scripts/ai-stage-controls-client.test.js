const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture, toastMessages } = require("./workbench-fixture");

const stages = ["stage1", "stage2", "stage3"];
const initial = "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\n初审改案：初审方案";
const dispute = initial + "\nStylist复审[调整]：复审有不同方案\n复审改案：复审方案";
const arbitrated = dispute + "\nArbiter仲裁[复审方案]：采纳复审\n仲裁改案：复审方案";

function stageControlWorkbench({ active = [], configured = ["stage2", "stage3"], startResponse, stopResponse, statusResponse, strictIds = true } = {}) {
  const activeStages = new Set(active);
  let stageMode = "stage1";
  const state = () => ({
    kind: "ai", projectKey: "project", rowsSignature: "rows", runId: "stage-controls",
    running: activeStages.size > 0, stageMode,
    stageCascade: { toStylist: stageMode === "all" && configured.includes("stage2"), toArbiter: stageMode === "all" && configured.includes("stage3") },
    stageControls: Object.fromEntries(stages.map((stage) => [stage, { running: activeStages.has(stage), stopRequested: false }])),
    // 活动阶段可以正在等待上游输入，空的工作队列不等于阶段已停止。
    stagePipelines: Object.fromEntries(stages.map((stage) => [stage, { inFlight: 0, pending: 0, activeRows: [] }])),
    total: 3, results: [],
  });
  const ui = createWorkbench(storageFixture({
    "translation-compare-ai-presets-v2": JSON.stringify([
      { id: "review", name: "复审", protocol: "compatible", baseUrl: "https://example.invalid/v1", model: "review-model" },
      { id: "arbiter", name: "仲裁", protocol: "compatible", baseUrl: "https://example.invalid/v1", model: "arbiter-model" },
    ]),
  }), {
    strictIds,
    statusResponse: () => statusResponse ? statusResponse(state()) : { ok: true, ai: state() },
    apiResponses: {
      "/api/ai-proofread/start": (request) => {
        const body = JSON.parse(request.body);
        stageMode = body.stage;
        for (const stage of body.stage === "all" ? ["stage1", ...configured] : [body.stage]) activeStages.add(stage);
        const result = { ok: true, ai: state() };
        return startResponse ? startResponse(result, body) : result;
      },
      "/api/ai-proofread/stop": (request) => {
        const body = JSON.parse(request.body);
        if (body.stage === "all") activeStages.clear();
        else activeStages.delete(body.stage);
        const result = { ok: true, ai: state() };
        return stopResponse ? stopResponse(result, body) : result;
      },
    },
  });
  ui.run("restoreAiConfig()");
  for (const stage of configured) {
    ui.element(`${stage}PresetSelect`).value = stage === "stage2" ? "review" : "arbiter";
    ui.element(`${stage}PresetAdd`).click();
  }
  return { ui, activeStages, state };
}

function seedNotes(ui, notes) {
  ui.run(`Object.assign(notes, ${JSON.stringify(Object.fromEntries(Object.entries(notes).map(([index, note]) => [index, { note, aiDone: true, manualDone: false }])))}); updateStageMetricsDashboard();`);
}

function assertButtons(ui, active) {
  for (const stage of stages) {
    assert.equal(ui.element(`${stage}Start`).disabled, active.includes(stage), `${stage} 开始仅由本阶段活动状态决定`);
    assert.equal(ui.element(`${stage}Stop`).disabled, !active.includes(stage), `${stage} 停止仅作用于本阶段`);
  }
  assert.equal(ui.element("aiStartAll").disabled, active.length > 0, "一键开始仅在所有阶段空闲时可用");
  assert.equal(ui.element("aiStopAll").disabled, active.length === 0, "任一阶段活动时即可一键停止");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const stage of stages) {
  test(`${stage} 独立开始：即使配置了下游，也只发送当前阶段且不禁用其它阶段`, async () => {
    const { ui } = stageControlWorkbench();
    await ui.settle();
    assertButtons(ui, []);
    if (stage === "stage2") seedNotes(ui, { 1: initial });
    if (stage === "stage3") seedNotes(ui, { 1: dispute });
    await ui.element(`${stage}Start`).dispatch("click");
    await ui.settle();
    const posts = ui.posts.filter((post) => post.url === "/api/ai-proofread/start");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.stage, stage);
    assertButtons(ui, [stage]);
    assert.doesNotMatch(toastMessages(ui).join("|"), /一路推进/);
  });

  test(`${stage} 独立停止：发送目标阶段，保留另外两个阶段的活动状态`, async () => {
    const { ui } = stageControlWorkbench({ active: stages });
    await ui.settle();
    await ui.element(`${stage}Stop`).dispatch("click");
    await ui.settle();
    const posts = ui.posts.filter((post) => post.url === "/api/ai-proofread/stop");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.stage, stage);
    assertButtons(ui, stages.filter((candidate) => candidate !== stage));
  });
}

test("阶段可并行启停：初审运行中直接消费已有候选，停止复审保留初审与仲裁", async () => {
  const { ui } = stageControlWorkbench();
  await ui.settle();
  await ui.element("stage1Start").dispatch("click");
  seedNotes(ui, { 1: initial, 2: dispute });
  await ui.element("stage2Start").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true, "已有复审记录时仍允许选择继续");
  await ui.element("aiConfirmKeep").dispatch("click");
  await ui.settle();
  assertButtons(ui, ["stage1", "stage2"]);
  await ui.element("stage3Start").dispatch("click");
  await ui.settle();
  assert.deepEqual(ui.posts.filter((post) => post.url === "/api/ai-proofread/start").map((post) => post.body.stage), stages);
  assertButtons(ui, stages);

  await ui.element("stage2Stop").dispatch("click");
  await ui.settle();
  assert.deepEqual(ui.posts.filter((post) => post.url === "/api/ai-proofread/stop").map((post) => post.body.stage), ["stage2"]);
  assertButtons(ui, ["stage1", "stage3"]);
  assert.equal(ui.run('notes["1"].note'), initial, "停止不得清空待复审内容");
  assert.equal(ui.run('notes["2"].note'), dispute, "其它阶段的已有结果保留");

  await ui.element("aiStopAll").dispatch("click");
  await ui.settle();
  assert.deepEqual(ui.posts.filter((post) => post.url === "/api/ai-proofread/stop").map((post) => post.body.stage), ["stage2", "all"]);
  assertButtons(ui, []);
});

test("一键开始与停止：用 all 请求组织已配置阶段，阶段停止仍只停止自己", async () => {
  const { ui } = stageControlWorkbench();
  await ui.settle();
  await ui.element("aiStartAll").dispatch("click");
  await ui.settle();
  assert.equal(ui.posts.find((post) => post.url === "/api/ai-proofread/start").body.stage, "all");
  assertButtons(ui, stages);
  // 此时复审/仲裁队列为 0，但它们仍是已启动的输入消费者，可以单独停止。
  await ui.element("stage3Stop").dispatch("click");
  await ui.settle();
  assert.equal(ui.posts.at(-1).body.stage, "stage3");
  assertButtons(ui, ["stage1", "stage2"]);
  await ui.element("aiStopAll").dispatch("click");
  await ui.settle();
  assert.equal(ui.posts.at(-1).body.stage, "all");
  assertButtons(ui, []);
});

test("一键开始：只配仲裁也保留独立仲裁配置，不要求配置复审模型", async () => {
  const { ui } = stageControlWorkbench({ configured: ["stage3"] });
  await ui.settle();
  const plan = ui.run('cascadeFromStage("all")');
  assert.equal(plan.toStylist, false);
  assert.equal(plan.toArbiter, true);
  await ui.element("aiStartAll").dispatch("click");
  await ui.settle();
  const post = ui.posts.find((item) => item.url === "/api/ai-proofread/start");
  assert.equal(post.body.stage, "all");
  assert.equal(post.body.stylistConfig, null);
  assert.equal(post.body.arbiterConfig.model, "arbiter-model");
  assertButtons(ui, ["stage1", "stage3"]);
});

test("刷新恢复：stageControls 让没有排队和处理中请求的活动阶段仍可停止", async () => {
  const { ui } = stageControlWorkbench({ active: ["stage1", "stage3"] });
  await ui.settle();
  assertButtons(ui, ["stage1", "stage3"]);
  await ui.refresh();
  assertButtons(ui, ["stage1", "stage3"]);
});

for (const stage of ["stage2", "stage3"]) {
  test(`${stage} 无候选时提示并保持空闲，上游结束也不自动接力`, async () => {
    const { ui, activeStages, state } = stageControlWorkbench({ active: ["stage1"] });
    await ui.settle();
    await ui.element(`${stage}Start`).dispatch("click");
    assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/start").length, 0);
    assert.equal(ui.element("aiConfirmDialog").open, false);
    assertButtons(ui, ["stage1"]);
    assert.match(toastMessages(ui).join("|"), /暂无|没有|尚无/);
    assert.doesNotMatch(toastMessages(ui).join("|"), /已排队|自动接力/);
    seedNotes(ui, { 1: stage === "stage2" ? initial : dispute });
    activeStages.clear();
    ui.run(`renderAiStatus(${JSON.stringify({ ...state(), finishedAt: "2026-01-01T00:00:00.000Z" })})`);
    await ui.settle();
    assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/start").length, 0, "上游收尾后仍需用户主动开始下游");
    assertButtons(ui, []);
    assert.doesNotMatch(toastMessages(ui).join("|"), /自动接力/);
  });
}

test("其它阶段活动时拒绝清空重跑：保留备注，仍可选择继续已有候选", async () => {
  const { ui } = stageControlWorkbench({ active: ["stage1"] });
  await ui.settle();
  seedNotes(ui, { 1: arbitrated, 2: initial });
  const before = ui.run('notes["1"].note');
  await ui.element("stage2Start").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true);
  await ui.element("aiConfirmClear").dispatch("click");
  await ui.settle();
  assert.equal(ui.run('notes["1"].note'), before);
  assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/start").length, 0);
  assert.match(toastMessages(ui).join("|"), /停止|运行/);
  assertButtons(ui, ["stage1"]);
  // 如果拒绝清空后弹窗保留，关闭再重新选择，避免依赖弹窗的关闭策略。
  if (ui.element("aiConfirmDialog").open) await ui.element("aiConfirmCancel").dispatch("click");
  await ui.element("stage2Start").dispatch("click");
  await ui.element("aiConfirmKeep").dispatch("click");
  await ui.settle();
  assert.equal(ui.posts.find((post) => post.url === "/api/ai-proofread/start").body.stage, "stage2");
  assert.equal(ui.run('notes["1"].note'), before);
  assertButtons(ui, ["stage1", "stage2"]);
});

test("迟到的停止前状态不能恢复已停阶段，结果游标留待新轮询正常接收", async () => {
  const oldPoll = deferred();
  let pollCount = 0;
  const result = { runId: "stage-controls", resultRevision: 1, index: 1, signature: "sig-1", status: "done", done: true, note: initial };
  const { ui, state } = stageControlWorkbench({
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
  await ui.element("stage1Stop").dispatch("click");
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

for (const active of [[], ["stage1"]]) {
  test(`启动请求尚未完成时禁用一键停止${active.length ? "，即使另一阶段已经运行" : ""}，避免新阶段未被停止`, async () => {
    const startReply = deferred();
    let responsePayload;
    const { ui } = stageControlWorkbench({
      active,
      startResponse(payload) { responsePayload = payload; return startReply.promise; },
    });
    await ui.settle();
    const stage = active.length ? "stage2" : "stage1";
    if (stage === "stage2") seedNotes(ui, { 1: initial });
    const pendingStart = ui.element(`${stage}Start`).dispatch("click");
    await ui.settle();
    assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/start").length, 1);
    assert.equal(ui.element("aiStopAll").disabled, true, "已有阶段运行也应等待另一个 start 请求落定");
    await ui.element("aiStopAll").dispatch("click");
    assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/stop").length, 0, "处理函数同样拒绝启动请求尚未完成时执行一键停止");
    startReply.resolve(responsePayload);
    await pendingStart;
    await ui.settle();
    assertButtons(ui, [...active, stage]);
  });
}

test("一键停止请求尚未完成时禁用全部开始入口，不能加入新的阶段", async () => {
  const stopReply = deferred();
  let responsePayload;
  const { ui } = stageControlWorkbench({
    active: ["stage1"],
    stopResponse(payload) { responsePayload = payload; return stopReply.promise; },
  });
  await ui.settle();
  seedNotes(ui, { 1: initial, 2: dispute });
  const pendingStop = ui.element("aiStopAll").dispatch("click");
  await ui.settle();
  for (const id of ["stage1Start", "stage2Start", "stage3Start", "aiStartAll"]) {
    assert.equal(ui.element(id).disabled, true, `${id} 在全停请求落定前禁用`);
    await ui.element(id).dispatch("click");
  }
  assert.equal(ui.posts.filter((post) => post.url === "/api/ai-proofread/start").length, 0, "handler 同样拦截新开始请求");
  stopReply.resolve(responsePayload);
  await pendingStop;
  await ui.settle();
  assertButtons(ui, []);
});

for (const stage of ["stage2", "stage3"]) {
  test(`旧快照兼容清除入口：${stage} 活动时保留备注及同轮结果接收状态`, async () => {
    // 当前页面已移除清除按钮；沿用接收回归的兼容 DOM，验证保留入口所绑定的真实 handler。
    const { ui, activeStages, state } = stageControlWorkbench({ active: [stage], strictIds: false });
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
