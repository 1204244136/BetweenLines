const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-ai-status-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const {
  clearProofreadCache,
  clientStatus,
  guardTargetScript,
  hasTargetScriptLeak,
  startProofread,
} = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const {
  createProjectStaging,
  projectArtifacts,
  publishProject,
} = require("./project-store");

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("AI results are consumed through a bounded revision cursor without gaps", async () => {
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, "source.txt"),
      cn: path.join(dataDir, "translation.txt"),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: 150 }, (_, offset) => {
    const text = "相同的规则预筛文本 " + (offset + 1);
    return { index: offset + 1, jp: text, cn: text, tw: "", twCn: "", score: 1 };
  });
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });

  const started = await startProofread({
    provider: "compatible",
    baseUrl: "http://127.0.0.1:1",
    model: "unused",
    proofreadMode: "bilingual",
    projectKey: project.projectKey,
    rowsSignature: project.rowsSignature,
  });
  assert.deepEqual(started.results, []);
  assert.equal(started.resultRevision, 0);
  assert.equal(started.latestResultRevision, 150);
  assert.equal(started.hasMoreResults, true);

  const pages = [];
  let cursor = 0;
  do {
    const page = clientStatus({
      runId: started.runId,
      afterRevision: cursor,
      resultLimit: 64,
      includeLogs: false,
    });
    pages.push(page);
    cursor = page.resultRevision;
  } while (pages.at(-1).hasMoreResults);

  assert.deepEqual(pages.map((page) => page.results.length), [64, 64, 22]);
  assert.equal(cursor, 150);
  assert.deepEqual(
    pages.flatMap((page) => page.results.map((result) => result.resultRevision)),
    Array.from({ length: 150 }, (_, offset) => offset + 1),
  );
  const full = clientStatus();
  assert.equal(full.results.length, 150);
  assert.equal(full.resultRevision, 150);
  assert.equal(full.hasMoreResults, false);
});

test("AI queue stops after a fatal authentication response", async () => {
  clearProofreadCache();
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, "fatal-source.txt"),
      cn: path.join(dataDir, "fatal-translation.txt"),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: 20 }, (_, offset) => ({
    index: offset + 1,
    jp: `source paragraph ${offset + 1} with unique content`,
    cn: `完全不同的译文段落 ${offset + 1}，需要模型判断`,
    tw: "",
    twCn: "",
    score: 0,
  }));
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });

  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "USER_INACTIVE", message: "User account is not active" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 4,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 3000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, true);
    assert.equal(finished.errors, 1);
    assert.match(finished.error, /HTTP 401.*USER_INACTIVE/);
    assert.equal(requestCount <= 4, true);
    assert.equal(finished.processed <= 4, true);
    assert.match(finished.results.find((result) => result.status === "error").note, /User account is not active/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

test("AI queue stops after the endpoint returns an HTML page instead of JSON", async () => {
  clearProofreadCache();
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, "html-source.txt"),
      cn: path.join(dataDir, "html-translation.txt"),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: 20 }, (_, offset) => ({
    index: offset + 1,
    jp: `source paragraph ${offset + 1} with unique content`,
    cn: `需要模型判断的译文段落 ${offset + 1}`,
    tw: "",
    twCn: "",
    score: 0,
  }));
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });

  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>API home</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 4,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 3000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, true);
    assert.equal(finished.errors, 1);
    assert.match(finished.error, /配置或响应异常.*非 JSON 响应.*text\/html/);
    assert.equal(requestCount <= 4, true);
    assert.equal(finished.processed <= 4, true);
    assert.match(finished.results.find((result) => result.status === "error").note, /\/v1\/chat\/completions.*非 JSON 响应/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

test("AI queue trips when the recent error rate reaches the circuit-breaker threshold", async () => {
  clearProofreadCache();
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, "circuit-source.txt"),
      cn: path.join(dataDir, "circuit-translation.txt"),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: 60 }, (_, offset) => ({
    index: offset + 1,
    jp: `source paragraph ${offset + 1} with unique content`,
    cn: `需要模型判断的不同译文段落 ${offset + 1}`,
    tw: "",
    twCn: "",
    score: 0,
  }));
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });

  let requestCount = 0;
  const successfulDecision = JSON.stringify({
    semanticSame: true,
    needsEdit: false,
    needsContext: false,
    better: "target",
    summary: "译文准确。",
  });
  const server = http.createServer((request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    if (requestCount % 2 === 1) {
      response.statusCode = 500;
      response.end(JSON.stringify({ message: "temporary upstream failure" }));
      return;
    }
    response.end(JSON.stringify({ choices: [{ message: { content: successfulDecision } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 2,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 3000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, true);
    assert.equal(finished.errors, 5);
    assert.match(finished.error, /错误率熔断：最近 10 次处理中有 5 次失败（50%，阈值 50%）/);
    assert.equal(requestCount <= 12, true);
    assert.equal(finished.processed < rows.length, true);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

async function publishModelRows(label, rowCount) {
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, `${label}-source.txt`),
      cn: path.join(dataDir, `${label}-translation.txt`),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: rowCount }, (_, offset) => ({
    index: offset + 1,
    jp: `${label} source paragraph ${offset + 1} with unique content`,
    cn: `${label} 需要模型判断的不同译文段落 ${offset + 1}`,
    tw: "",
    twCn: "",
    score: 0,
  }));
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });
  return { project, rows };
}

const passingDecisionBody = JSON.stringify({
  choices: [{ message: { content: JSON.stringify({
    semanticSame: true,
    needsEdit: false,
    needsContext: false,
    better: "target",
    summary: "译文准确。",
  }) } }],
});

async function runProofreadAgainst({ label, rowCount, breaker, respond }) {
  clearProofreadCache();
  const { project, rows } = await publishModelRows(label, rowCount);
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    respond(requestCount, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 2,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
      ...breaker,
    });
    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { finished: clientStatus({ includeResults: false }), requestCount, rows };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

test("raised circuit-breaker threshold lets a 50% failure rate run to completion", async () => {
  const { finished, rows } = await runProofreadAgainst({
    label: "raised-threshold",
    rowCount: 24,
    breaker: { circuitBreakerErrorRate: 0.9 },
    respond: (count, response) => {
      if (count % 2 === 1) {
        response.statusCode = 500;
        response.end(JSON.stringify({ message: "temporary upstream failure" }));
        return;
      }
      response.end(passingDecisionBody);
    },
  });
  assert.equal(finished.running, false);
  assert.equal(finished.stopRequested, false);
  assert.equal(finished.error, "");
  assert.equal(finished.processed, rows.length);
  assert.match(finished.logs.join("\n"), /错误率熔断：最近 20 次调用中失败占比达到 90% 时自动终止/);
});

test("disabling the circuit breaker keeps an all-failing run going row by row", async () => {
  const { finished, requestCount, rows } = await runProofreadAgainst({
    label: "breaker-disabled",
    rowCount: 12,
    breaker: { circuitBreakerErrorRate: 0.1, circuitBreakerEnabled: false },
    respond: (count, response) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ message: "permanent upstream failure" }));
    },
  });
  assert.equal(finished.running, false);
  assert.equal(finished.stopRequested, false);
  assert.equal(requestCount, rows.length);
  assert.equal(finished.errors, rows.length);
  assert.equal(finished.processed, rows.length);
  assert.match(finished.logs.join("\n"), /错误率熔断：已关闭/);
});

test("对齐片段行在模型索要上下文后直接终局，不再扩展相邻行", async () => {
  clearProofreadCache();
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, "fragment-source.txt"),
      cn: path.join(dataDir, "fragment-translation.txt"),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = [
    { index: 1, jp: "しかし、", cn: "可是。", tw: "", twCn: "", score: 0 },
    { index: 2, jp: "彼は黙っていた。", cn: "他保持着沉默。", tw: "", twCn: "", score: 0 },
  ];
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });

  const callsPerRow = new Map();
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      const user = JSON.parse(payload.messages[1].content);
      const index = Number(user.row.index);
      callsPerRow.set(index, (callsPerRow.get(index) || 0) + 1);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          semanticSame: true,
          needsEdit: false,
          needsContext: true,
          decision: "keep",
          summary: "需要补充上下文才能判断。",
          revisedText: "",
        }) } }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 1,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finished = clientStatus();
    assert.equal(finished.running, false);
    // 片段行（しかし、/可是。）只问一次：判定为对齐片段后直接转人工确认，不再补上下文。
    assert.equal(callsPerRow.get(1), 1);
    // 完整行仍会补充相邻行（本样例只有一行邻居可用，所以总计两次调用）。
    assert.equal(callsPerRow.get(2), 2);
    assert.match(finished.logs.join("\n"), /第 1 行：判定为对齐片段行，不再扩展上下文，直接转人工确认。/);
    const fragmentResult = finished.results.find((result) => result.index === 1);
    assert.equal(fragmentResult.done, false);
    assert.match(fragmentResult.note, /是否需要修改：待人工确认/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

test("修订结果混入原文（日文）文字时作废并转人工，不允许写回成品", async () => {
  const leakedDecision = JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    decision: "replace",
    score: 70,
    penalty: 30,
    grade: "good",
    severity: "minor",
    summary: "需要修改：原文的注音没有译出。",
    revisedText: "「手部跟<ruby>防烫隔热手套<rt>なべつか</rt></ruby>一样啊！！」",
  });
  const body = JSON.stringify({ choices: [{ message: { content: leakedDecision } }] });
  const { finished, rows } = await runProofreadAgainst({
    label: "script-leak",
    rowCount: 2,
    respond: (count, response) => response.end(body),
  });
  assert.equal(finished.running, false);
  assert.equal(finished.errors, 0);
  assert.equal(finished.scriptLeaks, rows.length, "每一行的越界输出都要计数");
  assert.match(finished.logs.join("\n"), /输出语言护栏：2 行的修改结果混入了原文（日文）文字/);

  const results = clientStatus().results.filter((item) => item.status !== "error");
  assert.equal(results.length, rows.length);
  for (const result of results) {
    assert.equal(result.status, "suggestion");
    assert.equal(result.done, false);
    assert.match(result.note, /是否需要修改：待人工确认/);
    assert.equal(
      result.note.includes("修改结果："),
      false,
      "被作废的修订结果不得留在备注里——备注里的修改结果会被人工直接写回成品",
    );
    assert.match(result.note, /混入了原文（日文）文字/);
  }
});

test("修订结果的标点按语境自动规范化：中文全角、英文半角，并在备注与统计里留痕", async () => {
  const decide = (revisedText) => JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    decision: "replace",
    score: 70,
    penalty: 30,
    grade: "good",
    severity: "minor",
    summary: "需要修改：标点不符合成品规范。",
    revisedText,
  });
  // 行号决定模型给出哪一段：奇数行是中文句子（半角 → 全角），偶数行是英文句子（半角必须原样保留）。
  const { finished, rows } = await runProofreadAgainst({
    label: "punct-normalize",
    rowCount: 2,
    respond: (count, response) => {
      let raw = "";
      const request = response.req;
      request.setEncoding("utf8");
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const user = JSON.parse(JSON.parse(raw).messages[1].content);
        const index = Number(user.row.index);
        const revised = index % 2 === 1
          ? "他来了,真的!!声音到底是......"
          : "Wait, this is a test. Really? Yes, it is.";
        response.end(JSON.stringify({ choices: [{ message: { content: decide(revised) } }] }));
      });
    },
  });

  assert.equal(finished.running, false);
  assert.equal(finished.errors, 0);
  assert.equal(finished.punctEnabled, true);
  assert.equal(finished.punctFixes, 1, "只有中文句子那一行被改过");
  assert.equal(finished.punctToFull, 3);
  assert.equal(finished.punctToHalf, 0);
  assert.match(finished.logs.join("\n"), /第 1 行：修改结果的标点已按成品写法统一（半角→全角 3 处，全角→半角 0 处）/);
  assert.match(finished.logs.join("\n"), /标点规范化：1 行的修改结果统一了标点宽度/);

  const results = clientStatus().results.filter((item) => item.status !== "error");
  assert.equal(results.length, rows.length);
  const chinese = results.find((item) => item.index === 1);
  assert.match(chinese.note, /修改结果：他来了，真的！！声音到底是……/);
  // 说明行写在分析栏里（分析之后、「修改结果：」之前）——备注按行取值，跟在修改结果后面会被并进去。
  const noteLines = chinese.note.split("\n");
  assert.equal(noteLines.at(-1), "修改结果：他来了，真的！！声音到底是……");
  const fixLine = noteLines.find((line) => line.startsWith("标点自动规范化："));
  assert.equal(fixLine, "标点自动规范化：半角→全角 3 处（中文标点全角、英文句子半角）");
  assert.equal(
    noteLines.indexOf(fixLine) > noteLines.findIndex((line) => line.startsWith("分析：")),
    true,
    "说明行写在分析栏里（分析之后、「修改结果：」之前）",
  );

  const english = results.find((item) => item.index === 2);
  assert.match(english.note, /修改结果：Wait, this is a test\. Really\? Yes, it is\./, "英文句子保持半角");
  assert.equal(/标点自动规范化/.test(english.note), false, "没改动就不留痕");
});

test("目标列本来就有刻意的假名写法时不拦；纯目标列语言的修订结果照常通过", () => {
  const leaked = { needsEdit: true, revisedText: "「なべつか」", summary: "需要修改。" };
  assert.equal(hasTargetScriptLeak("「手部跟なべつか一样」", "手部跟隔热手套一样。"), true);
  assert.equal(hasTargetScriptLeak("「手部跟隔热手套一样」", "手部跟隔热手套一样。"), false);
  assert.equal(hasTargetScriptLeak("", "手部跟隔热手套一样。"), false);
  // 目标列自己就带假名（作品允许的刻意写法）时，不因为“出现假名”就作废模型给的最小改动。
  assert.equal(guardTargetScript(leaked, "「ビリビリ来たわね」").revisedText, "「なべつか」");
  // 作废时连标点规范化的痕迹一起抹掉：修订结果都不存在了，备注里不该再留「标点自动规范化」。
  assert.equal(guardTargetScript({ ...leaked, punctFix: { toFull: 2, toHalf: 0 } }, "手部跟隔热手套一样。").punctFix, null);
  const guarded = guardTargetScript(leaked, "手部跟隔热手套一样。");
  assert.equal(guarded.revisedText, "");
  assert.equal(guarded.needsContext, true);
  assert.equal(guarded.better, "unclear");
  assert.match(guarded.summary, /混入了原文（日文）文字/);
});
