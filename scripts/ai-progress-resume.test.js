const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture, currentKey } = require("./workbench-fixture");

const passed = "[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改";
const suggested = "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\n初审改案：修改后的译文";
const failed = "[AI校对]\n调用失败：请求超时";
const rows = Array.from({ length: 5 }, (_, index) => ({
  index: index + 1,
  jp: `原文${index + 1}`,
  cn: `译文${index + 1}`,
  relation: "1:1",
  score: 0.9,
  signature: `sig-${index + 1}`,
}));

function initialNotes() {
  return {
    1: { note: passed, aiDone: true, rowSig: "sig-1" },
    2: { note: suggested, aiDone: true, rowSig: "sig-2" },
    3: { note: failed, aiDone: false, rowSig: "sig-3" },
  };
}

function status(running, overrides = {}) {
  const stage = overrides.stageMode || "stage1";
  return {
    kind: "proofread",
    projectKey: "project",
    rowsSignature: "rows",
    runId: "resume-run",
    stageMode: "stage1",
    stageCascade: { toStylist: false, toArbiter: false },
    stageControls: Object.fromEntries(["stage1", "stage2", "stage3"].map((key) => [key, { running: running && key === stage, stopRequested: false }])),
    running,
    total: 5,
    queued: 3,
    skippedDone: 2,
    results: [],
    stagePipelines: {
      stage1: { pending: running ? 2 : 0, inFlight: running ? 1 : 0, activeRows: running ? [3] : [] },
      stage2: { pending: 0, inFlight: 0, activeRows: [] },
      stage3: { pending: 0, inFlight: 0, activeRows: [] },
    },
    ...overrides,
  };
}

function fixture({ storage = storageFixture({ [currentKey]: JSON.stringify(initialNotes()) }), pageRows = rows, stage = "stage1" } = {}) {
  const running = status(true, { stageMode: stage });
  return createWorkbench(storage, {
    rows: pageRows,
    statusQueue: [{ ok: true, ai: status(false) }, { ok: true, ai: running }],
    apiResponses: { "/api/ai-proofread/start": { ok: true, ai: running } },
  });
}

function assertProgress(ui, done, percent) {
  assert.equal(ui.element("stage1ProgressWrap").hidden, false);
  assert.equal(ui.element("stage1Progress").style.width, `${percent}%`);
  assert.match(ui.element("stage1ProgressWrap").title, new RegExp(`已完成 ${done} / 共 5 行`));
  assert.equal(ui.element("metricStage1Total").textContent, done);
}

function assertUnreviewedAndFailed(ui) {
  const pill = ui.element("stage1StatusPill");
  assert.equal(pill.textContent, "待处理");
  assert.equal(ui.element("stage1RuntimeInfo").textContent, "未审 2 行");
  assert.equal(Number(ui.element("metricStage1Errors").textContent), 1);
  assert.match(pill.title, /继续剩下的/);
}

test("初审继续剩下的：点击开始、停止和刷新均保持全页完成进度", async () => {
  const ui = fixture();
  await ui.settle();
  assertProgress(ui, 2, 40);
  assertUnreviewedAndFailed(ui);
  const storedBeforeStart = ui.storage.getItem(currentKey);

  await ui.element("stage1Start").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true);
  await ui.element("aiConfirmKeep").dispatch("click");
  await ui.settle();
  const post = ui.posts.find((item) => item.url === "/api/ai-proofread/start");
  assert.ok(post);
  assert.equal(post.body.continueOnly, true);
  assert.deepEqual(post.body.completedIndexes.sort(), [1, 2]);
  assert.equal(post.body.rowNotes[3], failed);
  assert.equal(post.body.rowsSignature, "rows");
  assertProgress(ui, 2, 40);
  assert.equal(ui.element("stage1StatusPill").textContent, "处理中");
  assert.equal(ui.element("metricStage1Errors").textContent, 1);
  assert.equal(ui.storage.getItem(currentKey), storedBeforeStart);
  for (const [id, item] of Object.entries(initialNotes())) {
    assert.equal(ui.run(`notes[${JSON.stringify(id)}].note`), item.note);
    assert.equal(ui.run(`notes[${JSON.stringify(id)}].rowSig`), item.rowSig);
  }

  ui.run(`renderAiStatus(${JSON.stringify(status(false, { stopRequested: true, finishedAt: "2026-01-01T00:00:00.000Z" }))})`);
  assertProgress(ui, 2, 40);
  assertUnreviewedAndFailed(ui);
  const reloaded = fixture({ storage: ui.storage });
  await reloaded.settle();
  assertProgress(reloaded, 2, 40);
  assertUnreviewedAndFailed(reloaded);
});

test("初审失败重试：在飞仍未完成，取得可用结论才增加全页进度", async () => {
  const ui = fixture();
  await ui.settle();
  await ui.run('startAiProofread({ continueOnly: true, stage: "stage1" })');
  await ui.settle();
  assertProgress(ui, 2, 40);
  assert.equal(ui.element("metricStage1Errors").textContent, 1);

  const result = { runId: "resume-run", resultRevision: 1, index: 3, signature: "sig-3", status: "done", note: passed, done: true };
  ui.run(`renderAiStatus(${JSON.stringify(status(true, {
    results: [result], resultRevision: 1,
    stagePipelines: { stage1: { pending: 1, inFlight: 1, activeRows: [4] } },
  }))})`);
  ui.run("saveNotes({ immediate: true }); updateStageMetricsDashboard()");
  assertProgress(ui, 3, 60);
  assert.equal(ui.element("metricStage1Errors").textContent, 0);
  assert.equal(ui.run('latestAiNotePart(notes["3"].note)'), passed);
  assert.equal(ui.run('notes["3"].rowSig'), "sig-3");
  assert.equal(ui.run('notes["1"].note'), passed);
  assert.equal(ui.run('notes["2"].note'), suggested);

  const reloaded = fixture({ storage: ui.storage });
  await reloaded.settle();
  assertProgress(reloaded, 3, 60);
  assert.equal(reloaded.element("metricStage1Errors").textContent, 0);
});

test("全页初审范围与服务端一致：空原文和双列空行也保持稳定分母", async () => {
  const pageRows = rows.map((row) => ({ ...row }));
  pageRows[3].jp = "";
  pageRows[4].jp = "";
  pageRows[4].cn = "";
  const ui = fixture({ pageRows });
  await ui.settle();
  assertProgress(ui, 2, 40);
  await ui.run('startAiProofread({ continueOnly: true, stage: "stage1" })');
  await ui.settle();
  assertProgress(ui, 2, 40);
  const post = ui.posts.find((item) => item.url === "/api/ai-proofread/start");
  assert.deepEqual(post.body.completedIndexes.sort(), [1, 2]);
});

for (const stage of ["stage2", "stage3"]) {
  test(`${stage} 单独启动：初审未审行仍然存在，不显示初审完毕`, async () => {
    const ui = fixture({ stage });
    await ui.settle();
    assertProgress(ui, 2, 40);
    await ui.run(`startAiProofread({ continueOnly: true, stage: ${JSON.stringify(stage)} })`);
    await ui.settle();
    ui.run(`renderAiStatus(${JSON.stringify(status(true, {
      stageMode: stage,
      stagePipelines: { stage1: { pending: 0, inFlight: 0, activeRows: [] }, [stage]: { pending: 0, inFlight: 1, activeRows: [2] } },
    }))})`);
    assertProgress(ui, 2, 40);
    assertUnreviewedAndFailed(ui);
    assert.doesNotMatch(ui.element("stage1StatusPill").textContent, /初审完毕/);
  });
}
