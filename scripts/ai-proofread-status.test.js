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
  findInferredSubjectContext,
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

async function publishModelRows(label, rowCount, rowsFor) {
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
    // 需要特定目标列文本的用例（例如「成对标记内侧的句末点号」回归）走这里覆盖。
    ...(rowsFor ? rowsFor(offset + 1) : null),
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

async function runProofreadAgainst({ label, rowCount, breaker, respond, rowsFor }) {
  clearProofreadCache();
  const { project, rows } = await publishModelRows(label, rowCount, rowsFor);
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

test("原文短式先现在下一行同头重写时，基础轮主动带上下一行", async () => {
  const payloads = [];
  const { finished } = await runProofreadAgainst({
    label: "continued-opening",
    rowCount: 2,
    rowsFor: (index) => index === 1
      ? { jp: "それは。", cn: "虽然。" }
      : {
        jp: "それはとても<ruby>些細<rt>ささい</rt></ruby>な事ではあるけれど、どうしようもなく……",
        cn: "虽然那只是一件微不足道的小事，但它却又如此甜美，让人欲罢不能……",
      },
    respond: (_count, response) => {
      let body = "";
      const request = response.req;
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        payloads.push(JSON.parse(JSON.parse(body).messages[1].content));
        response.end(passingDecisionBody);
      });
    },
  });

  const firstRow = payloads.find((payload) => payload.row.index === 1);
  assert.ok(firstRow, "第一行没有发出基础轮请求");
  assert.equal(firstRow.nearbyRows.length, 1);
  assert.equal(firstRow.nearbyRows[0].index, 2);
  assert.equal(firstRow.nearbyRows[0].relation, "next-row-same-opening");
  assert.match(firstRow.nearbyRows[0].source, /^それはとても/);
  assert.match(firstRow.contextPolicy, /同头承接/);
  assert.match(firstRow.contextPolicy, /不能把本行当独立句改译/);
  assert.equal(firstRow.continuation.relation, "next-row-same-opening");
  assert.equal(firstRow.continuation.targetEcho, true);
  assert.equal(finished.errors, 0);
});

test("findInferredSubjectContext 准确识别代词与排除非代词，并按章节边界收窄", () => {
  const rows = [
    { index: 1, chapter: "第一章", jp: "おじさんはあちこちに視線を投げ、唇を嚙んで、俯いた。", cn: "大叔四处张望，咬着嘴唇，低下了头。" },
    { index: 2, chapter: "第一章", jp: "それから白井黒子の体をそっと寝かせると、弾かれたように走り出す。", cn: "然后他轻轻放下了白井黑子的身体，像弹簧一样猛地跑了出去。" },
    { index: 3, chapter: "第一章", jp: "彼は走り出した。", cn: "他跑了出去。" }, // 原文已有彼
    { index: 4, chapter: "第一章", jp: "他の人達は皆帰ってしまった。", cn: "其他的人都离开了。" }, // 其他
    { index: 5, chapter: "第一章", jp: "ギターを弾く少年がいる。", cn: "有一个弹吉他的少年。" }, // 吉他
    { index: 6, chapter: "第二章", jp: "彼女の容態を確認する。", cn: "她摇了摇头。" }, // 跨章节
  ];

  // 行 2：中文补他、日文无代词、同章上一行在大叔 → 命中
  const res2 = findInferredSubjectContext(2, rows, "cn");
  assert.ok(res2);
  assert.equal(res2.pronoun, "他");
  assert.equal(res2.relation, "prev-row-inferred-subject");
  assert.equal(res2.candidates.length, 1);
  assert.equal(res2.candidates[0].row.index, 1);
  assert.equal(res2.candidates[0].relative, -1);

  // 行 3：原文已有「彼」→ 不判定为推断代词
  assert.equal(findInferredSubjectContext(3, rows, "cn"), null);

  // 行 4、5：「其他」「吉他」非代词 → 不触发
  assert.equal(findInferredSubjectContext(4, rows, "cn"), null);
  assert.equal(findInferredSubjectContext(5, rows, "cn"), null);

  // 行 6：上一行在第一章，本行在第二章 → 跨章不带入
  assert.equal(findInferredSubjectContext(6, rows, "cn"), null);
});

test("译文引入原文未直接给出的第三人称代词时，基础轮主动带上前序上下文作指代依据", async () => {
  const payloads = [];
  const { finished } = await runProofreadAgainst({
    label: "inferred-subject",
    rowCount: 2,
    rowsFor: (index) => index === 1
      ? {
        chapter: "第一章",
        jp: "おじさんはあちこちに視線を投げ、唇を嚙んで、俯いた。",
        cn: "大叔四处张望，咬着嘴唇，低下了头。",
      }
      : {
        chapter: "第一章",
        jp: "それから白井黒子の体をそっと寝かせると、弾かれたように走り出す。",
        cn: "然后他轻轻放下了白井黑子的身体，像弹簧一样猛地跑了出去。",
      },
    respond: (_count, response) => {
      let body = "";
      const request = response.req;
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        payloads.push(JSON.parse(JSON.parse(body).messages[1].content));
        response.end(passingDecisionBody);
      });
    },
  });

  const secondRow = payloads.find((payload) => payload.row.index === 2);
  assert.ok(secondRow, "第二行没有发出基础轮请求");
  assert.equal(secondRow.nearbyRows.length, 1);
  assert.equal(secondRow.nearbyRows[0].index, 1);
  assert.equal(secondRow.nearbyRows[0].relative, -1);
  assert.equal(secondRow.nearbyRows[0].relation, "prev-row-inferred-subject");
  assert.match(secondRow.nearbyRows[0].source, /^おじさんは/);
  assert.match(secondRow.nearbyRows[0].target, /^大叔四处张望/);
  assert.match(secondRow.contextPolicy, /目标列使用了原文未直接给出的代词「他」/);
  assert.match(secondRow.contextPolicy, /请结合前文判断代词所指的行为主体是否成立/);
  assert.equal(secondRow.inferredSubject.relation, "prev-row-inferred-subject");
  assert.equal(secondRow.inferredSubject.pronoun, "他");
  assert.equal(finished.errors, 0);
});

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

test("修订结果的弯引号转成直角引号；无法配对的弯引号作废转人工", async () => {
  const decide = (revisedText) => JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    decision: "replace",
    score: 70,
    penalty: 30,
    grade: "good",
    severity: "minor",
    summary: "需要修改：拟声词引号体例不符合成品规范。",
    revisedText,
  });
  const { finished, rows } = await runProofreadAgainst({
    label: "punct-quotes",
    rowCount: 2,
    respond: (_count, response) => {
      let raw = "";
      const request = response.req;
      request.setEncoding("utf8");
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const user = JSON.parse(JSON.parse(raw).messages[1].content);
        const index = Number(user.row.index);
        const revised = index === 1
          ? "传来了“咔哒”一声。"
          : "传来了“咔哒一声。";
        response.end(JSON.stringify({ choices: [{ message: { content: decide(revised) } }] }));
      });
    },
  });

  assert.equal(finished.running, false);
  assert.equal(finished.errors, 0);
  assert.equal(finished.punctFixes, 1, "只有可确定转换的第 1 行计入标点修正");
  assert.equal(finished.punctQuotes, 1);
  assert.equal(finished.punctQuoteVoids, 1, "未配对的弯引号不能进入写回候选");
  assert.match(finished.logs.join("\n"), /第 1 行：修改结果的标点已按成品写法统一（双引号→直角引号 1 处）/);
  assert.match(finished.logs.join("\n"), /标点规范化：把 1 处中文语境的双引号统一成直角引号「」。/);
  assert.match(finished.logs.join("\n"), /标点规范化：1 行的修改结果含无法确定性配对的弯引号，已作废并转人工确认。/);

  const results = clientStatus().results.filter((item) => item.status !== "error");
  assert.equal(results.length, rows.length);
  const converted = results.find((item) => item.index === 1);
  assert.match(converted.note, /修改结果：传来了「咔哒」一声。/);
  assert.match(converted.note, /标点自动规范化：弯引号\/直双引号→直角引号 1 处/);

  const voided = results.find((item) => item.index === 2);
  assert.equal(voided.status, "suggestion");
  assert.equal(voided.done, false);
  assert.equal(voided.note.includes("修改结果："), false, "作废的弯引号文本不能留给写回");
  assert.match(voided.note, /无法确定性转换为「」的弯引号/);
});

test("模型删掉成对标记内侧的句末点号时按目标列规范补回，并在备注与统计里留痕", async () => {
  // 真实回归（第 1087 行）：目标列整行括注，点号落在括号内，模型判「括号内句末添加了多余的句号」
  // 并在改写里删掉了它。句末点号的位置是目标列语言的规范问题，原文省略不等于译文该省。
  const decide = (revisedText) => JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    decision: "replace",
    score: 70,
    penalty: 30,
    grade: "good",
    severity: "minor",
    summary: "需要修改：译文遗漏了开头的省略号。",
    revisedText,
  });
  const { finished, rows } = await runProofreadAgainst({
    label: "punct-restore",
    rowCount: 2,
    rowsFor: (index) => (index === 1
      ? { jp: "（……現実にはそうなっていない）", cn: "（……现实中并没有变成那样。）" }
      : { jp: "彼は来なかった。", cn: "他没有来。" }),
    respond: (count, response) => {
      let raw = "";
      const request = response.req;
      request.setEncoding("utf8");
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        const user = JSON.parse(JSON.parse(raw).messages[1].content);
        const index = Number(user.row.index);
        // 第 1 行：模型既补了遗漏的省略号、又删掉了括号内的句号（要补回那一个点号）；
        // 第 2 行：删的是行尾句号，不在这一层的处理范围（只按位置判断，不做语义判断）。
        const revised = index === 1 ? "（……现实中并没有变成那样）" : "他没有来";
        response.end(JSON.stringify({ choices: [{ message: { content: decide(revised) } }] }));
      });
    },
  });

  assert.equal(finished.running, false);
  assert.equal(finished.errors, 0);
  assert.equal(finished.punctRestored, 1, "只有括号内那一个点号被补回");
  assert.match(finished.logs.join("\n"), /第 1 行：修改结果的标点已按成品写法统一（补回引号\/括号内的句末点号 1 处）/);
  assert.match(finished.logs.join("\n"), /标点规范化：补回 1 处被删掉的句末点号/);

  const results = clientStatus().results.filter((item) => item.status !== "error");
  assert.equal(results.length, rows.length);
  const bracket = results.find((item) => item.index === 1);
  assert.match(bracket.note, /修改结果：（……现实中并没有变成那样。）/);
  const fixLine = bracket.note.split("\n").find((line) => line.startsWith("标点自动规范化："));
  assert.equal(fixLine, "标点自动规范化：补回引号/括号内的句末点号 1 处");
  assert.equal(bracket.note.split("\n").indexOf(fixLine) > bracket.note.split("\n").findIndex((line) => line.startsWith("分析：")), true);

  const plain = results.find((item) => item.index === 2);
  assert.match(plain.note, /修改结果：他没有来$/m);
  assert.equal(/标点自动规范化/.test(plain.note), false, "行尾句号被删不在标点这一层的处理范围，不留痕");
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
