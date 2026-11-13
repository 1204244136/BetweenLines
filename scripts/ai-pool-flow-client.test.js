const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture } = require("./workbench-fixture");

const stages = ["stage1", "stage2", "stage3"];
const plain = (value) => JSON.parse(JSON.stringify(value));

function poolStatus(overrides = {}) {
  const preset = {
    presetId: "p1", name: "共享模型", stages: ["stage1", "stage2"],
    inFlight: 3, pending: 0, quota: 3, configuredConcurrency: 4,
    activeRows: [1, 2, 3], waitReason: "", retryAt: 0,
  };
  const stagePreset = (inFlight, activeRows) => ({ ...preset, inFlight, activeRows });
  return {
    kind: "proofread", projectKey: "project", rowsSignature: "rows", runId: "pool-flow",
    running: true, poolEnabled: true, poolSupported: true, stageMode: "all",
    poolRuntime: { mode: "normal", state: "running", round: 1, presets: [preset] },
    stageControls: Object.fromEntries(stages.map((stage) => [stage, { running: stage !== "stage3", stopRequested: false }])),
    stagePipelines: {
      stage1: { inFlight: 1, pending: 0, activeRows: [1], concurrency: 3, concurrencyMax: 4 },
      stage2: { inFlight: 2, pending: 0, activeRows: [2, 3], concurrency: 3, concurrencyMax: 4 },
      stage3: { inFlight: 0, pending: 0, activeRows: [], concurrency: 0, concurrencyMax: 0 },
    },
    presetPipelines: {
      stage1: [stagePreset(1, [1])], stage2: [stagePreset(2, [2, 3])], stage3: [],
    },
    total: 3, queued: 0, results: [],
    ...overrides,
  };
}

async function workbench() {
  const ui = createWorkbench(storageFixture({
    "translation-compare-ai-config-v2": JSON.stringify({
      poolSelections: [{ presetId: "p1", stages: ["stage1", "stage2"] }],
    }),
    "translation-compare-ai-presets-v2": JSON.stringify([
      { id: "p1", name: "共享模型", protocol: "compatible", baseUrl: "https://example.invalid/v1", model: "model", concurrency: 4 },
    ]),
  }), {
    strictIds: true,
    statusResponse: () => ({ ok: true, ai: poolStatus() }),
    apiResponses: { "/api/ai-proofread/presets": { ok: true } },
  });
  await ui.settle();
  return ui;
}

function connections(ui) {
  return plain(ui.run("poolFlowConnections()"));
}

function counts(ui) {
  return Object.fromEntries(connections(ui).map((connection) => [connection.stage, connection.inFlight]));
}

function runtimeText(ui) {
  const preset = ui.element("aiPoolPresets").children.find((node) => node.dataset.presetId === "p1");
  assert.ok(preset, "池中仍保留本地选择的预设");
  return preset._poolControls.runtime.textContent;
}

test("管道只显示该阶段的实际运行数，预设总量不复制给每条管道", async () => {
  const ui = await workbench();
  assert.deepEqual(counts(ui), { stage1: 1, stage2: 2 });
  assert.equal(connections(ui).length, 2);
  assert.ok(connections(ui).every((connection) => connection.presetId === "p1" && connection.state === "运行中"));
  assert.equal(runtimeText(ui), "总并发 3/4");
});

test("热取消阶段后收尾请求仍占总并发，不得挪给剩余管道", async () => {
  const ui = await workbench();
  ui.run('setPoolPresetStages("p1", ["stage2"])');
  await ui.settle();
  const status = poolStatus();
  status.poolRuntime.presets[0].stages = ["stage2"];
  status.presetPipelines.stage1 = [];
  ui.run(`renderAiStatus(${JSON.stringify(status)})`);
  assert.deepEqual(counts(ui), { stage2: 2 });
  assert.equal(runtimeText(ui), "总并发 3/4", "已发出的阶段一请求仍在收尾，阶段二只运行自己的两条请求");
});

test("其它项目使用同名预设时，不把其运行数画入本页管道", async () => {
  const ui = await workbench();
  ui.run(`renderAiStatus(${JSON.stringify(poolStatus({ projectKey: "other-project" }))})`);
  assert.deepEqual(counts(ui), { stage1: 0, stage2: 0 });
  assert.equal(runtimeText(ui), "总并发 0/4");
});

test("停止后忽略快照残留的运行数，保留预设配置上限", async () => {
  const ui = await workbench();
  ui.run(`renderAiStatus(${JSON.stringify(poolStatus({ running: false }))})`);
  assert.deepEqual(counts(ui), { stage1: 0, stage2: 0 });
  assert.equal(runtimeText(ui), "总并发 0/4");
});

test("阶段明细缺失时标记未知，不从总运行数或阶段汇总猜分流", async () => {
  const ui = await workbench();
  ui.run(`renderAiStatus(${JSON.stringify(poolStatus({ presetPipelines: {} }))})`);
  assert.deepEqual(counts(ui), { stage1: null, stage2: null });
  assert.ok(connections(ui).every((connection) => connection.state === "状态未获取"));
  assert.equal(runtimeText(ui), "总并发 3/4", "预设总运行数已知，不代表各阶段的分流数已知");
});
