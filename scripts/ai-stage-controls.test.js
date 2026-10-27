const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-stage-controls-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;
const { clearProofreadCache, clientStatus, startProofread, stopProofread } = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const { createProjectStaging, projectArtifacts, publishProject } = require("./project-store");
const { handleAiRoutes } = require("../src/runtime/routes/ai");
const { stageNoteState } = require("../src/workbenches/translation-compare/ai/stage-note-state");
const { createWorkbench, storageFixture } = require("./workbench-fixture");

const initial = "[AI校对]\n语义是否相同：不同\n是否需要修改：是\nGatekeeper初审：修改措辞\n初审改案：初审改案。\n修改结果：初审改案。";
const reviewed = initial + "\nStylist复审[调整]：两份方案存在分歧\n复审改案：复审改案。\n修改结果：复审改案。";

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function until(predicate, message = "等待阶段状态") {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), message);
}

async function fixture(t, count = 4, options = {}) {
  clearProofreadCache();
  const selection = {
    comparisonMode: "bilingual", inputMode: "txt",
    files: { jp: path.join(dataDir, "source.txt"), cn: path.join(dataDir, "translation.txt") },
    labels: { jp: "原文 A", cn: "译文 B" },
  };
  const rows = Array.from({ length: count }, (_, offset) => ({
    index: offset + 1, jp: `日本語の原文には異なる意味がある ${offset + 1}。`,
    cn: options.targetText ?? `需要模型判断的译文段落 ${offset + 1}。`, score: 0.2,
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
  const callWaiters = [];
  const consumedCalls = new Set();
  const nextCall = (stage) => {
    const call = calls.find((item) => item.stage === stage && !consumedCalls.has(item));
    if (call) {
      consumedCalls.add(call);
      return Promise.resolve(call);
    }
    return new Promise((resolve) => callWaiters.push({ stage, resolve }));
  };
  const model = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const call = { stage: req.url.split("/")[1], body: JSON.parse(body), res, closed: false };
      calls.push(call);
      res.on("close", () => { call.closed = true; });
      const waiterIndex = callWaiters.findIndex((waiter) => waiter.stage === call.stage);
      if (waiterIndex >= 0) {
        consumedCalls.add(call);
        callWaiters.splice(waiterIndex, 1)[0].resolve(call);
      }
    });
  });
  const api = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    handleAiRoutes(req, res, url.pathname, url.searchParams).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    stopProofread();
    await until(() => !clientStatus({ includeResults: false }).running, "所有请求应在清理前收尾");
    for (const server of [api, model]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  const baseUrl = `http://127.0.0.1:${model.address().port}`;
  const config = {
    protocol: "compatible", baseUrl: `${baseUrl}/stage1/v1`, model: "gatekeeper-model", concurrency: 1,
    projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    stylistConfig: { protocol: "compatible", baseUrl: `${baseUrl}/stage2/v1`, model: "stylist-model", concurrency: 1 },
    arbiterConfig: { protocol: "compatible", baseUrl: `${baseUrl}/stage3/v1`, model: "arbiter-model", concurrency: 1 },
    lowScoreCheck: false, webLookup: false,
  };
  async function post(action, body) {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/ai-proofread/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() };
  }
  function respond(call, override) {
    const content = override || (call.stage === "stage3"
      ? { winner: "stylist", finalDecision: "replace", revisedText: "仲裁定案。", reason: "仲裁通过" }
      : call.stage === "stage2"
        ? { critique: { attitude: "escalate", rationale: "提交仲裁" }, revisedText: "复审改案。", summary: "复审分歧" }
        : { semanticSame: false, needsEdit: true, decision: "replace", revisedText: "初审改案。", summary: "修改措辞", score: 80 });
    call.res.writeHead(200, { "content-type": "application/json" });
    call.res.end(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }));
  }
  return { config, calls, post, respond, nextCall, project, rows };
}

for (const model of ["", "   ", null, undefined, "custom"]) {
  for (const stage of ["stage1", "stage2", "stage3", "all"]) {
    test(`启动校验：${stage} 的适用预设模型 ${JSON.stringify(model)} 在入队前拒绝`, async (t) => {
      const { config, calls, post } = await fixture(t, 1);
      const targetStage = stage === "all" ? "stage2" : stage;
      const connection = targetStage === "stage1" ? config
        : (targetStage === "stage2" ? config.stylistConfig : config.arbiterConfig);
      const poolKey = targetStage === "stage1" ? "presetPool"
        : (targetStage === "stage2" ? "stylistPresets" : "arbiterPresets");
      const before = clientStatus();
      const result = await post("start", {
        ...config, stage,
        [poolKey]: [
          { ...connection, presetId: "valid" },
          { ...connection, presetId: "empty-model", model },
        ],
        rowNotes: { 1: stage === "stage3" ? reviewed : initial },
      });
      assert.equal(result.status, 400);
      assert.match(result.error, /阶段[一二三].*模型/);
      const after = clientStatus();
      assert.equal(after.running, false);
      assert.equal(after.runId, before.runId);
      assert.deepEqual(after.results, before.results);
      assert.deepEqual(after.stageErrors, before.stageErrors);
      assert.equal(calls.length, 0, "不应把配置错误转成逐行模型请求");
    });
  }
}

for (const protocol of ["local", "claude"]) {
  test(`启动校验：${protocol} 子预设缺少模型时不能套用协议默认模型`, async (t) => {
    const { config, calls, post } = await fixture(t, 1);
    const result = await post("start", {
      ...config, stage: "all", stylistConfig: { protocol },
    });
    assert.equal(result.status, 400);
    assert.match(result.error, /阶段二.*模型/);
    assert.equal(clientStatus().running, false);
    assert.equal(calls.length, 0);
  });
}

test("启动校验：显式清空主模型不能被协议默认模型替代", async (t) => {
  const { config, calls, post } = await fixture(t, 1);
  for (const protocol of ["local", "claude", "compatible"]) {
    const before = clientStatus().runId;
    const result = await post("start", { ...config, stage: "stage1", protocol, model: "" });
    assert.equal(result.status, 400);
    assert.match(result.error, /阶段一.*模型/);
    assert.equal(clientStatus().runId, before);
    assert.equal(clientStatus().running, false);
  }
  assert.equal(calls.length, 0);
});

for (const stage of ["stage1", "stage2", "stage3"]) {
  test(`热更新校验：${stage} 空模型预设原子拒绝并保留正在运行的通道`, async (t) => {
    const { config, post, nextCall } = await fixture(t, 2);
    assert.equal((await post("start", {
      ...config, stage, rowNotes: { 1: stage === "stage3" ? reviewed : initial },
    })).status, 202);
    await nextCall(stage);
    const before = clientStatus();
    for (const preset of [
      { ...config, presetId: "invalid", model: "" },
      { protocol: "local", presetId: "missing-model" },
      { protocol: "claude", presetId: "missing-model" },
      { presetId: "missing-preset" },
    ]) {
      const updated = await post("presets", { stage, presets: [preset] });
      assert.equal(updated.status, 400);
      assert.match(updated.error, /阶段[一二三].*模型/);
    }
    const after = clientStatus();
    assert.equal(after.running, true);
    assert.equal(after.runId, before.runId);
    assert.deepEqual(after.presetPipelines, before.presetPipelines);
    assert.deepEqual(after.stageErrors, before.stageErrors);
  });
}

test("热更新校验：移除全部适用预设前检查回退的主模型", async (t) => {
  const { config, post, nextCall } = await fixture(t, 2);
  assert.equal((await post("start", {
    ...config, stage: "stage1", model: "",
    presetPool: [{ ...config, presetId: "valid" }],
  })).status, 202);
  await nextCall("stage1");
  const before = clientStatus();
  assert.equal((await post("presets", { stage: "stage1", presets: [] })).status, 400);
  assert.equal(clientStatus().running, true);
  assert.deepEqual(clientStatus().presetPipelines, before.presetPipelines);
});

test("启动校验：其它阶段运行时拒绝空模型，不改变已运行阶段", async (t) => {
  const { config, post, nextCall } = await fixture(t, 2);
  assert.equal((await post("start", { ...config, stage: "stage1" })).status, 202);
  await nextCall("stage1");
  const before = clientStatus();
  const invalid = await post("start", {
    ...config, stage: "stage2", stylistConfig: { ...config.stylistConfig, model: "" },
    forgetResultIndexes: [1], rowNotes: { 1: initial },
  });
  assert.equal(invalid.status, 400);
  const after = clientStatus();
  assert.equal(after.running, true);
  assert.equal(after.runId, before.runId);
  assert.deepEqual(after.stageControls, before.stageControls);
  assert.deepEqual(after.presetPipelines, before.presetPipelines);
  assert.deepEqual(after.results, before.results);
});

for (const stage of ["stage2", "stage3"]) {
  test(`启动校验：独立 ${stage} 不依赖未参与阶段的模型`, async (t) => {
    const { config, calls, post, nextCall, respond } = await fixture(t, 1);
    const inactiveKey = stage === "stage2" ? "arbiterConfig" : "stylistConfig";
    assert.equal((await post("start", {
      ...config, stage, model: "",
      [inactiveKey]: { ...config[inactiveKey], model: "" },
      rowNotes: { 1: stage === "stage3" ? reviewed : initial },
    })).status, 202);
    respond(await nextCall(stage));
    await until(() => !clientStatus().running);
    assert.deepEqual(calls.map((call) => call.stage), [stage]);
    assert.equal(clientStatus().errors, 0);
  });
}

async function runFinalDecisionPipeline(t, options = {}) {
  const scenario = await fixture(t, 1, options);
  const { config, calls, post, respond, nextCall } = scenario;
  const started = await post("start", { ...config, stage: "all", formatGuard: true, punctNormalize: true });
  assert.equal(started.status, 202);
  respond(await nextCall("stage1"), options.gatekeeper);
  await until(() => calls.some((call) => call.stage === "stage2") || !clientStatus().running);
  const reviewCall = calls.find((call) => call.stage === "stage2");
  assert.ok(reviewCall, "存疑或提改行必须进入复审");
  respond(reviewCall, options.stylist);
  await until(() => calls.some((call) => call.stage === "stage3") || !clientStatus().running);
  const arbitrationCall = calls.find((call) => call.stage === "stage3");
  assert.ok(arbitrationCall, `复审存疑或成品门禁作废后必须移交终审：${clientStatus().logs.join(" | ")}`);
  respond(arbitrationCall, options.arbiter);
  await until(() => !clientStatus().running);
  return { ...scenario, finished: clientStatus() };
}

function assertFinalUnchanged(scenario) {
  const { finished, project, rows } = scenario;
  assert.deepEqual(scenario.calls.map((call) => call.stage), ["stage1", "stage2", "stage3"]);
  assert.equal(finished.results.length, 1);
  const result = finished.results[0];
  assert.equal(result.done, true);
  assert.match(result.note, /是否需要修改：否/);
  assert.doesNotMatch(result.note, /是否需要修改：(?:待人工确认|待终审)/);
  assert.doesNotMatch(result.note, /^修改结果：/m, "保守不改不能附默认成品修改结果");
  assert.equal(result.stageResult.needsContext, false);
  assert.equal(result.stageResult.needsEdit, false);
  assert.equal(result.stageResult.revisedText, "");
  assert.equal(result.fastPass, false, "终审保守不改属于仲裁完成，不是初审快速直通");
  assert.equal(result.arbitration.finalDecision, "keep");
  assert.equal(stageNoteState(result.note).arbitrated, true);
  assert.equal(finished.stageMetrics.stage3Settled, 1);
  assert.equal(finished.stageMetrics.finalUnchanged, 1);
  assert.equal(finished.stageMetrics.finalNeedsEdit, 0);
  assert.equal(finished.stageMetrics.finalNeedsCheck, 0);
  assert.equal(finished.stageMetrics.finalPendingArbiter, 0);
  assert.equal(finished.stageMetrics.stage3Errors, 0);
  assert.equal(finished.stageMetrics.fastPassHits, 0);
  const key = project.notesStorage.key;
  const ui = createWorkbench(storageFixture({ [key]: JSON.stringify({ 1: { note: result.note, aiDone: true } }) }), {
    rows, projectKey: project.projectKey, rowsSignature: project.rowsSignature, currentKey: key,
  });
  assert.equal(ui.run("parseAutomatedNote(notes[1].note).revision"), "");
  assert.equal(ui.run("revisionTextFor(notes[1])"), "", "阶段过程稿不得成为保守不改行的默认写回内容");
}

for (const initialDecision of ["unclear", "replace"]) {
  test(`终审二元定案：初审 ${initialDecision} 经复审升级，终审证据不足保守不改`, async (t) => {
    const scenario = await runFinalDecisionPipeline(t, {
      gatekeeper: {
        semanticSame: false, needsEdit: initialDecision === "replace", needsContext: initialDecision === "unclear",
        decision: initialDecision, revisedText: initialDecision === "replace" ? "初审改案。" : "",
        summary: initialDecision === "replace" ? "存在明确漏译" : "指代依据不足，无法确定", score: 80,
      },
      arbiter: { winner: "unclear", finalDecision: "unclear", reason: "上下文证据不足，不能证明原译有错", revisedText: "不应采用的未定稿。" },
    });
    assertFinalUnchanged(scenario);
    assert.match(scenario.finished.results[0].note, /证据不足/);
  });
}

const invalidFinalRevisions = [
  { label: "日文假名泄漏", targetText: "当前译文。", revisedText: "修订译文あ。", reason: /混入了原文（日文）文字/ },
  { label: "译注标记丢失", targetText: '当前译文<a epub:type="noteref" href="#note1"><sup>㊟</sup></a>。', revisedText: "修订译文。", reason: /noteref 注释标记/ },
  { label: "多段结构变化", targetText: "当前第一段。\n\n当前第二段。", revisedText: "合并后的修订译文。", reason: /段落结构与目标列不一致/ },
  { label: "未配对弯引号", targetText: "当前译文。", revisedText: "“无法配对的修订译文。", reason: /弯引号/ },
];

for (const invalid of invalidFinalRevisions) {
  test(`终审二元定案：${invalid.label}作废后保守不改`, async (t) => {
    const scenario = await runFinalDecisionPipeline(t, {
      targetText: invalid.targetText,
      arbiter: { winner: "stylist", finalDecision: "replace", reason: "采纳修改方案", revisedText: invalid.revisedText },
    });
    assertFinalUnchanged(scenario);
    assert.match(scenario.finished.results[0].note, invalid.reason, "门禁作废原因必须保留在分析轨迹");
    assert.doesNotMatch(scenario.finished.results[0].note, /等待终审裁决/, "终审门禁作废后不能仍提示等待终审");
  });
}

for (const invalid of invalidFinalRevisions.slice(0, 2)) {
  test(`全流水线：复审采纳后${invalid.label}才触发门禁，自动追加终审`, async (t) => {
    const scenario = await runFinalDecisionPipeline(t, {
      targetText: invalid.targetText,
      gatekeeper: { semanticSame: false, needsEdit: true, decision: "replace", revisedText: invalid.revisedText, summary: "存在明确漏译", score: 80 },
      stylist: { critique: { attitude: "accept", rationale: "认可初审修订" }, revisedText: invalid.revisedText, summary: "采纳初审改案" },
      arbiter: { winner: "original", finalDecision: "keep", reason: "修订方案不可安全采用，保留原译", revisedText: "" },
    });
    assertFinalUnchanged(scenario);
  });
}

for (const invalid of [
  { label: "坏 JSON", content: "{broken-json" },
  { label: "未知 finalDecision", content: { winner: "stylist", finalDecision: "defer", reason: "无效决议", revisedText: "不能采用的改案。" } },
]) {
  test(`终审二元定案：${invalid.label}保留仲裁异常及待办`, async (t) => {
    const scenario = await runFinalDecisionPipeline(t, { arbiter: invalid.content });
    const { finished } = scenario;
    assert.equal(finished.results.length, 1);
    const result = finished.results[0];
    const state = stageNoteState(result.note);
    assert.equal(Boolean(state.errors.stage3), true);
    assert.equal(state.arbitrated, false, "解析失败不能冒充终审完成");
    assert.equal(state.pendingArbitration, true, "失败行必须保留在终审待办");
    assert.equal(finished.stageMetrics.stage3Errors, 1);
    assert.equal(finished.stageMetrics.stage3Arbitrated, 0);
    assert.equal(finished.stageMetrics.stage3Settled, 0);
    assert.equal(finished.stageMetrics.finalUnchanged, 0);
    assert.match(result.note, /Arbiter仲裁调用异常/);
  });
}

for (const outcome of ["success", "failure"]) {
  test(`复审重试转仲裁：立即交付已复审备注，仲裁 ${outcome} 只结算一次`, { timeout: 10000 }, async (t) => {
    const { config, calls, post, respond, nextCall, project, rows } = await fixture(t, 1);
    const failure = initial + "\nStylist复审调用异常：请求超时";
    const key = project.notesStorage.key;
    const ui = createWorkbench(storageFixture({ [key]: JSON.stringify({ 1: { note: failure, aiDone: true } }) }), {
      rows, projectKey: project.projectKey, rowsSignature: project.rowsSignature, currentKey: key,
    });
    assert.equal(ui.element("metricStage2Pending").textContent, 1);
    assert.equal(ui.element("metricStage2Errors").textContent, 1);

    const started = await post("start", { ...config, stage: "all", continueOnly: true, rowNotes: { 1: failure } });
    assert.equal(started.status, 202);
    const reviewCall = await nextCall("stage2");
    respond(reviewCall);
    // 请求到达本地模型就是确定性的交接 gate；仲裁响应由测试显式释放。
    const arbitrationCall = await nextCall("stage3");
    const live = clientStatus({ runId: started.ai.runId, afterRevision: started.ai.resultRevision });
    assert.equal(live.results.length, 1, "复审完成不能等仲裁结束才发布最新行备注");
    assert.equal(live.stageMetrics.stage2Reviewed, 1);
    assert.equal(live.stagePipelines.stage3.inFlight, 1);
    const intermediate = live.results[0];
    const state = stageNoteState(intermediate.note);
    assert.equal(state.reviewed, true);
    assert.equal(state.errors.stage2, undefined);
    assert.equal(state.pendingArbitration, true);
    assert.equal(intermediate.done, false);
    assert.match(intermediate.note, /是否需要修改：待终审/);
    assert.doesNotMatch(intermediate.note, /^修改结果：/m, "仲裁完成前不发布可写回的最终修改结果");
    for (const field of ["processed", "handled", "modelProcessed", "modelHandled", "suggested", "errors"]) {
      assert.equal(live[field], 0, `${field} 不应把中间交接当作最终行结果计数`);
    }

    ui.run(`renderAiStatus(${JSON.stringify(live)})`);
    const afterDelivery = clientStatus({ runId: live.runId, afterRevision: live.resultRevision });
    ui.run(`renderAiStatus(${JSON.stringify(afterDelivery)})`);
    assert.equal(ui.element("metricStage2Pending").textContent, 0);
    assert.equal(ui.element("metricStage2Errors").textContent, 0);
    assert.equal(ui.element("metricStage3Pending").textContent, 1);
    assert.equal(ui.element("stage3StatusPill").textContent, "处理中");
    assert.equal(ui.run('parseAutomatedNote(notes[1].note).revision'), "");
    assert.equal(ui.run('notes[1].revisionText'), "");
    assert.equal(ui.run('revisionTextFor(notes[1])'), "", "待终审的过程稿不能自动成为可写回的成品修改结果");

    if (outcome === "failure") {
      arbitrationCall.res.writeHead(401, { "content-type": "application/json" });
      arbitrationCall.res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    } else {
      respond(arbitrationCall);
    }
    await until(() => !clientStatus().running);
    const settled = clientStatus({ runId: live.runId, afterRevision: live.resultRevision });
    assert.equal(settled.results.length, 1, "最终结果沿同一游标覆盖中间行备注");
    assert.ok(settled.resultRevision > live.resultRevision);
    assert.equal(settled.processed, 1);
    assert.equal(settled.modelProcessed, 1);
    assert.equal(settled.handled, 0);
    assert.equal(settled.modelHandled, 0);
    assert.equal(settled.suggested, 1);
    assert.equal(settled.errors, 0);
    const finalState = stageNoteState(settled.results[0].note);
    assert.equal(finalState.reviewed, true);
    assert.equal(finalState.errors.stage2, undefined);
    assert.equal(Boolean(finalState.errors.stage3), outcome === "failure");
    assert.equal(finalState.arbitrated, outcome === "success");
    assert.equal(settled.stageMetrics.stage2Reviewed, 1);
    assert.equal(settled.stageMetrics.stage3Arbitrated, outcome === "success" ? 1 : 0);
    assert.equal(settled.stageMetrics.stage3Errors, outcome === "failure" ? 1 : 0);
    ui.run(`renderAiStatus(${JSON.stringify(settled)})`);
    ui.run(`renderAiStatus(${JSON.stringify(clientStatus({ runId: live.runId, afterRevision: settled.resultRevision }))})`);
    assert.equal(ui.element("metricStage2Pending").textContent, 0);
    assert.equal(ui.element("metricStage2Errors").textContent, 0);
    assert.equal(ui.element("metricStage3Errors").textContent, outcome === "failure" ? 1 : 0);
    assert.deepEqual(calls.map((call) => call.stage), ["stage2", "stage3"]);
  });
}

test("真实路由：三个独立阶段可同时运行，定向停止真正中止自身请求并保留其他阶段", async (t) => {
  const { config, calls, post, respond } = await fixture(t);
  assert.equal((await post("start", { ...config, stage: "stage1", completedIndexes: [2, 3] })).status, 202);
  await until(() => calls.length === 1);
  respond(calls[0]);
  await until(() => calls.length === 2 && clientStatus().results.some((result) => result.index === 1));
  const firstResult = clientStatus().results.find((result) => result.index === 1);
  const runId = clientStatus().runId;
  assert.equal((await post("start", {
    ...config, stage: "stage2", completedIndexes: [2, 3, 4], rowNotes: { 1: firstResult.note },
  })).status, 202);
  assert.equal((await post("start", {
    ...config, stage: "stage3", completedIndexes: [1, 2, 4], rowNotes: { 3: reviewed },
  })).status, 202);
  await until(() => calls.length === 4);
  let live = clientStatus();
  assert.equal(live.runId, runId, "加入阶段不能清空共享任务或结果游标");
  assert.deepEqual(Object.values(live.stageControls).map((control) => control.running), [true, true, true]);
  const s1 = calls[1];
  const s2 = calls.find((call) => call.stage === "stage2");
  const s3 = calls.find((call) => call.stage === "stage3");
  await post("stop", { stage: "stage1" });
  await until(() => s1.closed && !clientStatus().stageControls.stage1.running);
  assert.equal(s2.closed, false, "停止初审不得中断复审连接");
  assert.equal(s3.closed, false, "停止初审不得中断仲裁连接");
  await post("stop", { stage: "stage2" });
  await until(() => s2.closed && !clientStatus().stageControls.stage2.running);
  assert.equal(s3.closed, false, "停止复审不得中断独立仲裁连接");
  assert.equal(clientStatus().stageControls.stage3.running, true);
  respond(s3);
  await until(() => !clientStatus().running);
  live = clientStatus();
  assert.equal(live.stopRequested, false, "定向终止不冒充整体终止");
  assert.equal(live.stageErrors.stage1.stopped.count, 1);
  assert.equal(live.stageErrors.stage2.stopped.count, 1);
  assert.match(live.results.find((result) => result.index === 1).note, /初审改案。/);
  assert.match(live.results.find((result) => result.index === 3).note, /仲裁定案。/);
});

test("真实路由：行冲突与重复启动返回 409，一键停止等待正在处理的请求结束后允许干净重启", async (t) => {
  const { config, calls, post, respond } = await fixture(t, 2);
  await post("start", { ...config, stage: "stage1" });
  await until(() => calls.length === 1);
  assert.equal((await post("start", { ...config, stage: "stage1" })).status, 409);
  const overlap = await post("start", { ...config, stage: "stage2", rowNotes: { 1: initial }, completedIndexes: [2] });
  assert.equal(overlap.status, 409);
  assert.match(overlap.error, /正在其他阶段处理/);
  assert.equal((await post("start", { ...config, stage: "all" })).status, 409);
  for (const payload of [{ stage: "stage4" }, { stage: null }, null, []]) {
    assert.throws(() => stopProofread(payload), { code: "INVALID_STAGE" });
    assert.equal((await post("stop", payload)).status, 400);
  }
  assert.equal(clientStatus().stageControls.stage1.running, true, "未知阶段不能退化成一键停止");
  const stopping = await post("stop", { stage: "all" });
  assert.equal(stopping.ai.stopRequested, true);
  if (clientStatus().running) await assert.rejects(startProofread({ ...config, stage: "stage1" }), { code: "RUNNING" });
  await until(() => !clientStatus().running && calls[0].closed);
  const next = await post("start", { ...config, stage: "stage2", rowNotes: { 1: initial }, completedIndexes: [2] });
  assert.equal(next.status, 202);
  assert.deepEqual(next.ai.stageCascade, { toStylist: false, toArbiter: false });
  await until(() => calls.length === 2);
  assert.equal(calls[1].stage, "stage2");
  respond(calls[1]);
  await until(() => !clientStatus().running);
  assert.deepEqual(calls.map((call) => call.stage), ["stage1", "stage2"], "重启复审不会恢复已断开的仲裁链路");
});

test("独立下游仅校验自身连接：主配置为空也能启动复审与仲裁", async (t) => {
  const { config, calls, post, respond } = await fixture(t, 2);
  const emptyMain = { ...config, protocol: "compatible", baseUrl: "", model: "" };
  for (const [stage, note] of [["stage2", initial], ["stage3", reviewed]]) {
    const before = calls.length;
    const response = await post("start", { ...emptyMain, stage, rowNotes: { 1: note }, completedIndexes: [2] });
    assert.equal(response.status, 202, "独立下游的有效预设不能被空的初审连接阻挡");
    await until(() => calls.length > before);
    assert.equal(calls[before].stage, stage);
    respond(calls[before]);
    await until(() => !clientStatus().running);
  }
});

test("同一任务内重启已停复审只恢复自身，保留独立仲裁及结果游标", async (t) => {
  const { config, calls, post, respond } = await fixture(t, 3);
  await post("start", { ...config, stage: "stage3", rowNotes: { 3: reviewed }, completedIndexes: [1, 2] });
  await until(() => calls.length === 1);
  const arbiter = calls[0];
  const runId = clientStatus().runId;
  const reviewInput = { ...config, stage: "stage2", rowNotes: { 1: initial }, completedIndexes: [2, 3] };
  await post("start", reviewInput);
  await until(() => calls.length === 2);
  await post("stop", { stage: "stage2" });
  await until(() => calls[1].closed && !clientStatus().stageControls.stage2.running);
  const stopped = clientStatus().results.find((result) => result.index === 1);
  assert.ok(stopped);
  assert.equal(clientStatus().stageMetrics.stage2Errors, 1);
  const next = await post("start", {
    ...reviewInput, continueOnly: true, rowNotes: { 1: stopped.note },
    stylistConfig: { ...config.stylistConfig, model: "new-stylist-model" },
  });
  assert.equal(next.status, 202);
  assert.equal(next.ai.runId, runId);
  assert.equal(arbiter.closed, false);
  await until(() => calls.length === 3);
  assert.equal(calls[2].stage, "stage2");
  assert.equal(calls[2].body.model, "new-stylist-model", "重启读取本阶段的新配置");
  respond(calls[2]);
  await until(() => !clientStatus().stageControls.stage2.running);
  assert.equal(clientStatus().stageControls.stage3.running, true);
  assert.deepEqual(clientStatus().stageErrors.stage2, {}, "成功重跑清除旧的阶段异常");
  assert.equal(clientStatus().stageMetrics.stage2Errors, 0, "同一任务复审重试成功也清除旧的异常计数");
  respond(arbiter);
  await until(() => !clientStatus().running);
  assert.deepEqual(calls.map((call) => call.stage), ["stage3", "stage2", "stage2"]);
});

test("独立阶段的致命请求失败只终止自身，健康仲裁连接继续完成", async (t) => {
  const { config, calls, post, respond } = await fixture(t, 2);
  await post("start", { ...config, stage: "stage3", rowNotes: { 2: reviewed }, completedIndexes: [1] });
  await until(() => calls.length === 1);
  await post("start", { ...config, stage: "stage2", rowNotes: { 1: initial }, completedIndexes: [2] });
  await until(() => calls.length === 2);
  calls[1].res.writeHead(401, { "content-type": "application/json" });
  calls[1].res.end(JSON.stringify({ error: { message: "invalid api key" } }));
  await until(() => !clientStatus().stageControls.stage2.running);
  assert.equal(clientStatus().stageControls.stage2.stopRequested, true);
  assert.equal(clientStatus().stageControls.stage3.running, true);
  assert.equal(calls[0].closed, false);
  respond(calls[0]);
  await until(() => !clientStatus().running);
  assert.match(clientStatus().results.find((result) => result.index === 2).note, /仲裁定案。/);
});

for (const stage of ["stage1", "stage2", "stage3"]) {
  test(`账号风控：${stage} 收到网关 429 后停止自身且不重试，健康阶段继续完成`, async (t) => {
    const { config, calls, post, respond, nextCall } = await fixture(t, 4);
    const healthyStage = stage === "stage3" ? "stage2" : "stage3";
    await post("start", {
      ...config, stage: healthyStage, rowNotes: { 4: healthyStage === "stage2" ? initial : reviewed }, completedIndexes: [1, 2, 3],
    });
    const healthyCall = await nextCall(healthyStage);
    const rowNotes = stage === "stage1" ? {} : Object.fromEntries([1, 2, 3].map((index) => [index, stage === "stage2" ? initial : reviewed]));
    assert.equal((await post("start", { ...config, stage, rowNotes, completedIndexes: [4] })).status, 202);
    const rejectedCall = await nextCall(stage);
    rejectedCall.res.writeHead(429, { "content-type": "application/json", "retry-after": "15" });
    rejectedCall.res.end(JSON.stringify({ error: { message: "上游风控已限制本区域账号（403 / code 11140，账号存在异常行为）。网关暂时无法处理请求。" } }));
    await until(() => !clientStatus().stageControls[stage].running, "账号限制必须当场停止所属阶段，不进入退避");
    const failed = clientStatus();
    assert.equal(failed.stageControls[stage].stopRequested, true);
    assert.equal(failed.stageControls[healthyStage].running, true);
    assert.equal(healthyCall.closed, false);
    assert.equal(failed.stageErrors[stage].auth.count, 1);
    assert.equal(failed.concurrencyLimits, 0, "账号限制不计入频控采样");
    assert.match(failed.error, /账号访问受限/);
    assert.doesNotMatch(failed.logs.join("\n"), /\[频控退避\]/);
    respond(healthyCall);
    await until(() => !clientStatus().running);
    assert.equal(calls.filter((call) => call.stage === stage).length, 1, "不重试失败行，也不向同阶段后续行继续发请求");
    assert.deepEqual(clientStatus().stageErrors[healthyStage], {});
    assert.match(clientStatus().results.find((result) => result.index === 4).note, healthyStage === "stage3" ? /仲裁定案。/ : /Stylist复审/);
  });
}

test("一键开始：没有复审预设也会消费已有仲裁待办，初审不会跳过复审直达仲裁", async (t) => {
  const { config, calls, post, respond } = await fixture(t, 2);
  const { stylistConfig, ...withoutStylist } = config;
  const started = await post("start", { ...withoutStylist, stage: "all", rowNotes: { 2: reviewed } });
  assert.equal(started.status, 202);
  assert.deepEqual(started.ai.stageCascade, { toStylist: false, toArbiter: true });
  await until(() => calls.length === 2);
  assert.deepEqual(calls.map((call) => call.stage).sort(), ["stage1", "stage3"]);
  for (const call of calls) respond(call);
  await until(() => !clientStatus().running);
  assert.equal(calls.length, 2, "初审提改不会在缺少复审时直接派发给仲裁");
  assert.equal(clientStatus().stageMetrics.stage3Arbitrated, 1);
});

test("一键流水线：停止复审切断新移交，已进入仲裁的请求继续完成", async (t) => {
  const { config, calls, post, respond } = await fixture(t, 3);
  await post("start", { ...config, stage: "all" });
  await until(() => calls.length === 1);
  respond(calls[0]);
  await until(() => calls.some((call) => call.stage === "stage2"));
  respond(calls.find((call) => call.stage === "stage2"));
  await until(() => calls.some((call) => call.stage === "stage3"));
  const arbiter = calls.find((call) => call.stage === "stage3");
  await post("stop", { stage: "stage2" });
  assert.equal(arbiter.closed, false);
  for (let index = 1; index < 3; index += 1) {
    await until(() => calls.filter((call) => call.stage === "stage1").length > index);
    respond(calls.filter((call) => call.stage === "stage1")[index]);
  }
  respond(arbiter);
  await until(() => !clientStatus().running);
  assert.equal(calls.filter((call) => call.stage === "stage2").length, 1, "被停阶段不会被后续初审重新唤醒");
  assert.equal(calls.filter((call) => call.stage === "stage3").length, 1);
  assert.equal(clientStatus().results.length, 3);
});
