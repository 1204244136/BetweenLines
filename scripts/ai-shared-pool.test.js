const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-shared-pool-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;
const { clearProofreadCache, clientStatus, startProofread, stopProofread, updateStagePresets } = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const { createProjectStaging, publishProject, projectArtifacts } = require("../src/storage/project-store");

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function until(predicate, label = "等待任务结束") {
  const deadline = Date.now() + 12000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), `${label}: ${clientStatus().logs.join(" | ")}`);
}

async function fixture(t, { rowsCount = 3, respond, stages, mode = "normal", presets = ["model-a"], sourceText, targetText } = {}) {
  clearProofreadCache();
  const selection = { comparisonMode: "bilingual", inputMode: "txt", files: {
    jp: path.join(dataDir, `${t.name}-source.txt`), cn: path.join(dataDir, `${t.name}-target.txt`),
  } };
  const rows = Array.from({ length: rowsCount }, (_, offset) => ({
    index: offset + 1, jp: sourceText ?? `日本語の原文は別の意味を表す ${offset + 1}。`,
    cn: targetText ?? `等待审核的中文译文 ${offset + 1}。`, score: 0.2,
  }));
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({ project, rowsSignature: project.rowsSignature, rows }));
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "");
  }
  publishProject(staging.dir, { dataDir });
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      const input = JSON.parse(body);
      const user = input.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
      const stage = /请裁决第/.test(user) ? "stage3" : /请审阅第/.test(user) ? "stage2" : "stage1";
      const call = { stage, input, user };
      calls.push(call);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const custom = await respond?.(call, calls);
      await new Promise((resolve) => setTimeout(resolve, 8));
      const content = custom?.content || (stage === "stage3"
        ? { winner: "stylist", finalDecision: "replace", revisedText: "仲裁定案。", reason: "完成仲裁" }
        : stage === "stage2"
          ? { critique: { attitude: "escalate", rationale: "提交仲裁" }, revisedText: "复审改案。", summary: "复审分歧" }
          : { semanticSame: false, needsEdit: true, decision: "replace", revisedText: "初审改案。", summary: "修改措辞", score: 80 });
      inFlight -= 1;
      res.writeHead(custom?.status || 200, { "content-type": "application/json" });
      res.end(JSON.stringify(custom?.error ? { error: { message: custom.error } }
        : { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    stopProofread();
    await until(() => !clientStatus().running);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const presetPool = presets.map((model) => ({ presetId: model, name: model, model,
    protocol: "compatible", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, concurrency: 1,
    ...(stages ? { stages } : {}),
  }));
  const config = { ...presetPool[0], projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    stage: "all", continueOnly: true, poolEnabled: true, poolMode: mode, presetPool,
    lowScoreCheck: false, webLookup: false, punctNormalize: false, formatGuard: false,
  };
  return { config, calls, rows, peak: () => peak };
}

test("共享池：同一预设跨三阶段总并发只占一份，全部结果终审完成", async (t) => {
  const scenario = await fixture(t);
  assert.equal(clientStatus().poolSupported, true);
  await startProofread(scenario.config);
  await until(() => !clientStatus().running);
  const done = clientStatus();
  assert.equal(scenario.peak(), 1);
  assert.equal(scenario.calls.length, 9);
  assert.equal(done.poolState, "completed");
  assert.equal(done.poolPresets.length, 1);
  assert.equal(done.stageMetrics.stage3Settled, 3);
  assert.equal(done.results.length, 3);
});

test("循环池：初审临时失败后自动重试并继续复审仲裁", async (t) => {
  let failed = false;
  const scenario = await fixture(t, { rowsCount: 1, mode: "loop", respond: (call) => {
    if (call.stage === "stage1" && !failed) { failed = true; return { status: 500, error: "temporary upstream error" }; }
  } });
  await startProofread(scenario.config);
  await until(() => !clientStatus().running);
  const done = clientStatus();
  assert.deepEqual(scenario.calls.map((call) => call.stage), ["stage1", "stage1", "stage2", "stage3"]);
  assert.equal(done.poolRound, 2);
  assert.equal(done.poolState, "completed");
  assert.equal(done.stageMetrics.stage1Errors, 0);
  assert.equal(done.stageMetrics.stage3Settled, 1);
});

test("循环池：拒答行换预设，拒答预设不再收到同阶段同一行", async (t) => {
  const scenario = await fixture(t, { rowsCount: 1, mode: "loop", presets: ["refuser", "healthy"], respond: (call) => {
    if (call.input.model === "refuser") return { status: 400, error: "content_filter: sensitive content" };
  } });
  await startProofread(scenario.config);
  await until(() => !clientStatus().running);
  const done = clientStatus();
  const refusals = scenario.calls.filter((call) => call.input.model === "refuser");
  assert.equal(refusals.filter((call) => call.stage === "stage1").length, 1);
  assert.equal(new Set(refusals.map((call) => call.stage)).size, refusals.length);
  assert.equal(done.poolState, "completed");
  assert.equal(done.stageMetrics.stage3Settled, 1);
});

test("循环池：所有预设拒答后报告阻塞而不无限重跑", async (t) => {
  const scenario = await fixture(t, { rowsCount: 1, mode: "loop", respond: () => ({ status: 400, error: "content_filter: sensitive content" }) });
  await startProofread(scenario.config);
  await until(() => !clientStatus().running);
  assert.equal(scenario.calls.length, 1);
  assert.equal(clientStatus().poolState, "blocked");
  assert.match(clientStatus().poolBlockedReason, /拒答/);
});

test("常规池：失败不自动开新轮次，保留未完成状态", async (t) => {
  const scenario = await fixture(t, { rowsCount: 1, respond: () => ({ status: 500, error: "temporary upstream error" }) });
  await startProofread(scenario.config);
  await until(() => !clientStatus().running);
  assert.equal(scenario.calls.length, 1);
  assert.equal(clientStatus().poolRound, 1);
  assert.equal(clientStatus().poolState, "blocked");
});

test("共享池：未启用下游时保留待办，不宣称全审完成", async (t) => {
  const scenario = await fixture(t, { rowsCount: 1, stages: ["stage1"] });
  await startProofread(scenario.config);
  await until(() => !clientStatus().running);
  assert.equal(scenario.calls.length, 1);
  assert.equal(clientStatus().poolState, "blocked");
  assert.match(clientStatus().poolBlockedReason, /文学复审/);
});

test("共享池：已有初审而只启用阶段一时不重复初审，报告缺少复审覆盖", async (t) => {
  const scenario = await fixture(t, { rowsCount: 1, stages: ["stage1"] });
  await startProofread({ ...scenario.config, rowNotes: { 1: "[AI校对]\n语义是否相同：不同\n是否需要修改：是\nGatekeeper初审：修改措辞\n初审改案：初审改案。\n修改结果：初审改案。" } });
  await until(() => !clientStatus().running);
  assert.equal(scenario.calls.length, 0);
  assert.equal(clientStatus().poolState, "blocked");
  assert.match(clientStatus().poolBlockedReason, /文学复审/);
});

test("共享池：只有下游预设时接续已有初审，且复审成功继续仲裁", async (t) => {
  const scenario = await fixture(t, { rowsCount: 1, stages: ["stage2", "stage3"] });
  await startProofread({ ...scenario.config, rowNotes: { 1: "[AI校对]\n语义是否相同：不同\n是否需要修改：是\nGatekeeper初审：修改措辞\n初审改案：初审改案。\n修改结果：初审改案。" } });
  await until(() => !clientStatus().running);
  assert.deepEqual(scenario.calls.map((call) => call.stage), ["stage2", "stage3"]);
  assert.equal(clientStatus().poolState, "completed");
});

test("循环池：退避等下一轮时停止，不能再发模型请求", async (t) => {
  const scenario = await fixture(t, { rowsCount: 1, mode: "loop", respond: () => ({ status: 500, error: "temporary upstream error" }) });
  await startProofread(scenario.config);
  await until(() => clientStatus().poolRound === 2);
  stopProofread();
  await until(() => !clientStatus().running);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(scenario.calls.length, 1);
  assert.equal(clientStatus().poolState, "stopped");
});

test("共享池：人工前缀中的最新仲裁结论不误报缺少初审", async (t) => {
  const scenario = await fixture(t, { rowsCount: 1, stages: ["stage2", "stage3"] });
  const note = "人工说明保留。\n\n[AI校对]\n语义是否相同：相同\n是否需要修改：否\nGatekeeper初审：无需修改\nStylist复审[保留原译]：无需修改\nArbiter仲裁[保留原译]：无需修改";
  await startProofread({ ...scenario.config, rowNotes: { 1: note } });
  await until(() => !clientStatus().running);
  assert.equal(scenario.calls.length, 0);
  assert.equal(clientStatus().poolState, "completed");
});

test("共享池：当前备注已清空时，不能用上一轮内存结论掩盖缺少初审", async (t) => {
  const scenario = await fixture(t, { rowsCount: 1 });
  await startProofread(scenario.config);
  await until(() => !clientStatus().running);
  await startProofread({ ...scenario.config, presetPool: scenario.config.presetPool.map((preset) => ({ ...preset, stages: ["stage2", "stage3"] })), rowNotes: {} });
  await until(() => !clientStatus().running);
  assert.equal(scenario.calls.length, 3);
  assert.equal(clientStatus().poolState, "blocked");
  assert.match(clientStatus().poolBlockedReason, /初审/);
});

test("共享池：运行中开启仲裁会补入已有仲裁待办，不重跑上游", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scenario = await fixture(t, { rowsCount: 2, stages: ["stage1", "stage2"], respond: async (call) => {
    if (call.stage === "stage1") await gate;
  } });
  const note = "[AI校对]\n语义是否相同：不同\n是否需要修改：待终审\nGatekeeper初审：修改措辞\n初审改案：初审改案。\nStylist复审[提交仲裁]：存在分歧\n复审改案：复审改案。";
  await startProofread({ ...scenario.config, rowNotes: { 1: note } });
  await until(() => scenario.calls.length === 1);
  const before = clientStatus();
  assert.throws(() => updateStagePresets({ stage: "all", presets: scenario.config.presetPool,
    projectKey: "wrong-project", runId: before.runId }), { code: "RUN_SCOPE_MISMATCH" });
  updateStagePresets({ stage: "all", presets: scenario.config.presetPool.map((preset) => ({ ...preset, stages: ["stage1", "stage2", "stage3"] })),
    projectKey: before.projectKey, rowsSignature: before.rowsSignature, runId: before.runId });
  release();
  await until(() => !clientStatus().running);
  assert.equal(scenario.calls.filter((call) => call.stage === "stage1").length, 1);
  assert.equal(scenario.calls.filter((call) => call.stage === "stage2").length, 1);
  assert.equal(scenario.calls.filter((call) => call.stage === "stage3").length, 2);
  assert.equal(clientStatus().poolState, "completed");
  assert.equal(clientStatus().stageMetrics.stage3Settled, 2);
});

for (const failedStage of ["stage2", "stage3"]) {
  test(`循环池：${failedStage} 临时失败只重试本阶段并继续下游`, async (t) => {
    let failed = false;
    const scenario = await fixture(t, { rowsCount: 1, mode: "loop", respond: (call) => {
      if (call.stage === failedStage && !failed) { failed = true; return { status: 500, error: "temporary upstream error" }; }
    } });
    await startProofread(scenario.config);
    await until(() => !clientStatus().running);
    const stages = scenario.calls.map((call) => call.stage);
    assert.deepEqual(stages, failedStage === "stage2"
      ? ["stage1", "stage2", "stage2", "stage3"] : ["stage1", "stage2", "stage3", "stage3"]);
    const retried = scenario.calls.filter((call) => call.stage === failedStage);
    assert.deepEqual(retried[0].input.messages, retried[1].input.messages, "重试必须保留原上游完整方案");
    assert.equal(clientStatus().poolState, "completed");
    assert.equal(clientStatus().stageMetrics[`${failedStage}Errors`], 0);
    assert.equal(clientStatus().stageMetrics.stage3Settled, 1);
  });
}

for (const status of [401, 402]) {
  test(`循环池：HTTP ${status} 停用故障预设的所有阶段，健康预设接手并完成`, async (t) => {
    const scenario = await fixture(t, { rowsCount: 2, mode: "loop", presets: ["broken", "healthy"], respond: (call) => {
      if (call.input.model === "broken") return { status, error: status === 402 ? "insufficient_balance" : "invalid api key" };
    } });
    await startProofread(scenario.config);
    await until(() => !clientStatus().running);
    assert.equal(scenario.calls.filter((call) => call.input.model === "broken").length, 1);
    assert.equal(clientStatus().poolState, "completed");
    assert.equal(clientStatus().stageMetrics.stage3Settled, 2);
    assert.equal(clientStatus().poolPresets.find((preset) => preset.presetId === "broken").breakerTripped, true);
  });
}

test("循环池：等待下一轮期间热更新不重复派发异常行", async (t) => {
  let failed = false;
  const scenario = await fixture(t, { rowsCount: 1, mode: "loop", respond: (call) => {
    if (call.stage === "stage1" && !failed) { failed = true; return { status: 500, error: "temporary upstream error" }; }
  } });
  await startProofread(scenario.config);
  await until(() => clientStatus().poolRound === 2 && clientStatus().poolRuntime.retryAt > Date.now());
  updateStagePresets({ stage: "all", presets: scenario.config.presetPool });
  assert.ok(clientStatus().poolRuntime.retryAt > Date.now(), "热更新不能清掉下一轮等待时间");
  await until(() => !clientStatus().running);
  assert.deepEqual(scenario.calls.map((call) => call.stage), ["stage1", "stage1", "stage2", "stage3"]);
  assert.equal(clientStatus().poolState, "completed");
});

test("共享池：数值结构冲突保留确定性预筛结果，循环与续跑都不交给模型", async (t) => {
  const scenario = await fixture(t, { rowsCount: 1, mode: "loop", sourceText: "4", targetText: "3" });
  await startProofread(scenario.config);
  await until(() => !clientStatus().running);
  const note = clientStatus().results[0].note;
  assert.match(note, /^\[规则预筛\]/);
  assert.match(note, /待人工确认/);
  assert.equal(scenario.calls.length, 0);
  await startProofread({ ...scenario.config, rowNotes: { 1: note } });
  await until(() => !clientStatus().running);
  assert.equal(scenario.calls.length, 0);
});
