const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-smart-concurrency-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { BREAKER_POLICY } = require("../src/workbenches/translation-compare/ai/circuit-breaker");
const {
  clearProofreadCache,
  clientStatus,
  isConcurrencyOrRateLimitError,
  parseRateLimitReason,
  startProofread,
  stopProofread,
  cleanConfig,
  cleanSubStageConfig,
  stagePlan,
  shouldCascadeStages,
  reusePreviousResults,
} = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const {
  createProjectStaging,
  projectArtifacts,
  publishProject,
} = require("./project-store");
const { createPresetTools } = require("../src/workbenches/translation-compare/ai-presets");
const { makeHtml } = require("./build-compare");
const { createWorkbench } = require("./workbench-fixture");

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function setupMockProject(rowsCount = 10, prefix = "sc") {
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, `${prefix}-source.txt`),
      cn: path.join(dataDir, `${prefix}-translation.txt`),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const rows = Array.from({ length: rowsCount }, (_, offset) => ({
    index: offset + 1,
    jp: `原文测试段落 ${offset + 1}，具有独立语义内容`,
    cn: `不同译文测试段落 ${offset + 1}，需要通过模型进行细筛判定`,
    tw: "",
    twCn: "",
    score: 0.8,
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

test("智能并发：错误检测准确识别速率限制、过载与并发信号", () => {
  assert.equal(isConcurrencyOrRateLimitError(null), false);
  assert.equal(isConcurrencyOrRateLimitError({}), false);
  assert.equal(isConcurrencyOrRateLimitError(new Error("普通网络中断")), false);

  // HTTP status codes
  assert.equal(isConcurrencyOrRateLimitError({ httpStatus: 429 }), true);
  assert.equal(isConcurrencyOrRateLimitError({ httpStatus: 503 }), true);
  assert.equal(isConcurrencyOrRateLimitError({ httpStatus: 529 }), true);
  assert.equal(isConcurrencyOrRateLimitError({ status: 429 }), true);

  // Codes
  assert.equal(isConcurrencyOrRateLimitError({ code: "RATE_LIMIT" }), true);
  assert.equal(isConcurrencyOrRateLimitError({ code: "TOO_MANY_REQUESTS" }), true);
  assert.equal(isConcurrencyOrRateLimitError({ code: "RESOURCE_EXHAUSTED" }), true);
  assert.equal(isConcurrencyOrRateLimitError({ code: "CONCURRENCY_LIMIT" }), true);

  // Message patterns
  assert.equal(isConcurrencyOrRateLimitError(new Error("Rate limit reached for requests per minute")), true);
  assert.equal(isConcurrencyOrRateLimitError(new Error("Too Many Requests - TPM exceeded")), true);
  assert.equal(isConcurrencyOrRateLimitError(new Error("Exceeded your current quota, please check your plan")), true);
  assert.equal(isConcurrencyOrRateLimitError(new Error("Concurrency limit exceeded: max 3 concurrent requests")), true);
  assert.equal(isConcurrencyOrRateLimitError(new Error("The server is temporarily overloaded, please try again in 5s")), true);
  assert.equal(isConcurrencyOrRateLimitError({ responseBody: "resource_exhausted: slow down" }), true);

  // Exclude refusal / safety policy
  assert.equal(isConcurrencyOrRateLimitError({
    code: "MODEL_REFUSAL",
    message: "The model declined to answer due to content filter",
  }), false);

  // Exclude fatal authentication / not found errors
  assert.equal(isConcurrencyOrRateLimitError({ httpStatus: 401, message: "Unauthorized" }), false);
  assert.equal(isConcurrencyOrRateLimitError({ httpStatus: 404, message: "Not Found" }), false);

  // parseRateLimitReason formatting
  assert.equal(parseRateLimitReason({ httpStatus: 429 }), "HTTP 429 请求频次超限");
  assert.equal(parseRateLimitReason({ httpStatus: 529 }), "HTTP 529 服务过载");
  assert.equal(parseRateLimitReason({ message: "concurrency limit exceeded" }), "并发超限");
  assert.equal(parseRateLimitReason({ message: "exceeded tokens per minute" }), "Token 速率限制 (TPM)");
});

test("并发上限：预设只保存一个并发上限，旧预设的智能并发字段折算后丢弃", () => {
  const tools = createPresetTools();

  const cleanedDefault = tools.sanitizePreset({ name: "默认预设", protocol: "local" });
  assert.equal(cleanedDefault.concurrency, 3);
  assert.equal("smartConcurrency" in cleanedDefault, false);
  assert.equal("concurrencyMax" in cleanedDefault, false);

  // 旧预设：开启智能并发时有效上限是 max(concurrency, concurrencyMax)。
  const legacySmart = tools.sanitizePreset({ name: "自适应预设", protocol: "compatible", smartConcurrency: true, concurrency: 5, concurrencyMax: 15 });
  assert.equal(legacySmart.concurrency, 15);
  assert.equal("smartConcurrency" in legacySmart, false);
  assert.equal("concurrencyMax" in legacySmart, false);
  // 旧预设：关闭智能并发时 concurrencyMax 从不生效，上限就是 concurrency。
  assert.equal(tools.sanitizePreset({ name: "固定", smartConcurrency: false, concurrency: 5, concurrencyMax: 15 }).concurrency, 5);
  // 折算后仍受 1~32 边界约束。
  assert.equal(tools.sanitizePreset({ name: "超界", smartConcurrency: true, concurrency: 4, concurrencyMax: 99 }).concurrency, 32);
});

test("并发上限：预设与服务端一致放开到 32，20 不再被静默改写", () => {
  const tools = createPresetTools();

  // 用户这次的实际现象：预设里选 20，旧实现因 20 > 12 直接回落成 3。
  const preset = tools.sanitizePreset({ name: "20 并发预设", concurrency: 20 });
  assert.equal(preset.concurrency, 20);

  // 预设侧边界：下界仍保底 1，上界截断到 32。
  assert.equal(tools.sanitizePreset({ name: "下界", concurrency: 0 }).concurrency, 1);
  assert.equal(tools.sanitizePreset({ name: "上界", concurrency: 33 }).concurrency, 32);
  // 非整数仍回落到默认值，不参与截断。
  assert.equal(tools.sanitizePreset({ name: "非整数", concurrency: 2.5 }).concurrency, 3);

  // 服务端侧必须与预设侧同档，否则预设保存 20、运行又被压回 12。
  const mainConf = cleanConfig({ concurrency: 20 });
  assert.equal(mainConf.concurrency, 20);
  assert.equal("smartConcurrency" in mainConf, false, "服务端不再有智能并发开关");
  assert.equal("concurrencyMax" in mainConf, false);
  // 旧客户端仍会带 smartConcurrency + concurrencyMax：折算成同一个上限，不能被静默压回去。
  assert.equal(cleanConfig({ concurrency: 4, smartConcurrency: true, concurrencyMax: 20 }).concurrency, 20);
  assert.equal(cleanConfig({ concurrency: 4, smartConcurrency: false, concurrencyMax: 20 }).concurrency, 4);
  assert.equal(cleanConfig({ concurrency: 33 }).concurrency, 32);
  assert.equal(cleanConfig({ concurrency: 0 }).concurrency, 1);

  const subConf = cleanSubStageConfig({ model: "gpt-4o", concurrency: 20 });
  assert.equal(subConf.concurrency, 20);
  assert.equal("concurrencyMax" in subConf, false);
  assert.equal(cleanSubStageConfig({ model: "gpt-4o", concurrency: 33 }).concurrency, 32);

  // 生成页面也必须把放开后的上界写进控件，否则数字箭头上不去、提示文案还停在旧口径。
  const html = makeHtml(
    [{ index: 1, jp: "原文一", cn: "译文一", relation: "1:1", score: 0.9, signature: "sig-1" }],
    { comparisonMode: "bilingual", files: { jp: "A.txt", cn: "B.txt" }, labels: { jp: "原文", cn: "译文" } },
    { projectKey: "project", rowsSignature: "rows", notesStorage: { key: "rows" } },
  );
  assert.match(html, /id="aiConcurrency"[^>]*max="32"/);
  assert.equal(html.includes('id="aiConcurrencyMax"'), false, "页面不再有第二个并发输入框");
  assert.equal(html.includes('id="aiSmartConcurrency"'), false, "页面不再有智能并发开关");
});

test("并发上限界面：页面只有一个「并发上限」输入，没有智能并发开关与第二个输入框", async () => {
  const html = makeHtml(
    [{ index: 1, jp: "原文一", cn: "译文一", relation: "1:1", score: 0.9, signature: "sig-1" }],
    { comparisonMode: "bilingual", files: { jp: "A.txt", cn: "B.txt" }, labels: { jp: "原文", cn: "译文" } },
    { projectKey: "project", rowsSignature: "rows", notesStorage: { key: "rows" } },
  );
  assert.ok(html.includes('<label for="aiConcurrency" id="aiConcurrencyLabel">并发上限</label>'), "标签是「并发上限」");
  assert.match(html, /id="aiConcurrency"[^>]*title="并发上限[^"]*调度器/);
  for (const id of ["aiSmartConcurrency", "aiConcurrencyMax", "aiConcurrencyMaxWrap"]) {
    assert.equal(html.includes(`id="${id}"`), false, `${id} 已从页面移除`);
  }
  const markup = html.split("<script")[0];
  assert.equal(markup.includes("智能并发"), false, "页面可见文案里不再出现「智能并发」");

  // 交互侧：改并发上限只保存 concurrency，存档里不再写智能并发字段。
  const storage = {
    data: new Map(),
    getItem(k) { return this.data.get(k) ?? null; },
    setItem(k, v) { this.data.set(k, v); },
    removeItem(k) { this.data.delete(k); },
  };
  const ui = createWorkbench(storage);
  const input = ui.element("aiConcurrency");
  input.value = "12";
  await input.dispatch("change");
  const saved = JSON.parse(storage.getItem("translation-compare-ai-config-v2") || "{}");
  assert.equal(saved.concurrency, "12");
  assert.equal("smartConcurrency" in saved, false);
  assert.equal("concurrencyMax" in saved, false);
});

test("并发调度：并发上限 4 时以 3 起步，请求稳定后上探到上限", async () => {
  clearProofreadCache();
  const { project } = setupMockProject(30, "probe");

  let maxConcurrentSeen = 0;
  let currentInFlight = 0;

  const server = http.createServer((req, res) => {
    currentInFlight += 1;
    maxConcurrentSeen = Math.max(maxConcurrentSeen, currentInFlight);
    req.resume();
    setTimeout(() => {
      currentInFlight -= 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(passingBody());
    }, 20);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  // 缩短「两次上探之间的最短间隔」以便快速上探；不是运行时开关。
  const prevInterval = process.env.TRANSCOMPARATOR_CONCURRENCY_STEP_INTERVAL;
  process.env.TRANSCOMPARATOR_CONCURRENCY_STEP_INTERVAL = "10";

  try {
    const address = server.address();
    await startProofread({
      protocol: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 4, // 并发上限 4：起步 3，一整轮请求正常后上探到 4
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 5000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.errors, 0);
    assert.equal(finished.concurrency, 3, "起步并发 = min(上限, 3)");
    assert.equal(finished.concurrencyMax, 4, "状态里回报的是并发上限");
    assert.equal(finished.peakConcurrency, 4, "稳定后应上探到上限");
    assert.ok(finished.concurrencyUps >= 1);
    assert.ok(maxConcurrentSeen <= 4, `任何时刻都不得超过并发上限，实际同时在途 ${maxConcurrentSeen}`);
    assert.ok(finished.logs.some((log) => log.includes("[并发调度]") && log.includes("从 3")), "上探必须留下日志");
    assert.equal("smartConcurrency" in finished, false, "状态接口不再回报智能并发开关");
  } finally {
    if (prevInterval === undefined) delete process.env.TRANSCOMPARATOR_CONCURRENCY_STEP_INTERVAL;
    else process.env.TRANSCOMPARATOR_CONCURRENCY_STEP_INTERVAL = prevInterval;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("并发调度：遭遇 HTTP 429 频控时自动下调并发、退避并在重试中完成", async () => {
  clearProofreadCache();
  const { project } = setupMockProject(8, "ratelimit");

  let attemptCount = 0;
  const rateLimitAttempts = new Map();

  const server = http.createServer((req, res) => {
    attemptCount += 1;
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      // 对第 2 行和第 4 行在首次请求时返回 429 频控限制
      const match = body.match(/段落 (\d+)/);
      const rowNum = match ? Number(match[1]) : 0;
      const seen = rateLimitAttempts.get(rowNum) || 0;
      rateLimitAttempts.set(rowNum, seen + 1);

      if ((rowNum === 2 || rowNum === 4) && seen === 0) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0.1",
        });
        res.end(JSON.stringify({
          error: {
            message: "Rate limit reached for requests per minute. Please back off.",
            type: "rate_limit_exceeded",
          },
        }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              semanticSame: true,
              needsEdit: false,
              decision: "keep",
              summary: "校对无误",
            }),
          },
        }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      protocol: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 6, // 并发上限 6：起步 3，遇到频控自动下调
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 6000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    // 遇到限流下调
    assert.equal(finished.concurrencyLimits >= 1, true);
    assert.equal(finished.concurrencyDowns >= 1, true);
    // 重试后全部 8 行均正常完成，错误数为 0
    assert.equal(finished.errors, 0);
    assert.equal(finished.processed, 8);
    assert.ok(finished.logs.some((log) => log.includes("遭遇HTTP 429 请求频次超限")));
    assert.ok(finished.logs.some((log) => log.includes("并发调度统计：")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("并发上限很小（等于起步并发）时遭遇 429 同样退避重试，不再直接判失败", async () => {
  clearProofreadCache();
  const { project } = setupMockProject(4, "fixed429");

  const rateLimitAttempts = new Map();

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const match = body.match(/段落 (\d+)/);
      const rowNum = match ? Number(match[1]) : 0;
      const seen = rateLimitAttempts.get(rowNum) || 0;
      rateLimitAttempts.set(rowNum, seen + 1);

      if (seen === 0) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0.1",
        });
        res.end(JSON.stringify({
          error: { message: "Rate limit reached for requests per minute." },
        }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              semanticSame: true,
              needsEdit: false,
              decision: "keep",
              summary: "校对无误",
            }),
          },
        }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      protocol: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      // 关键：并发上限 2 < 起步值 3，调度器没有上探空间。频控退避与重试不该依赖能不能上探——
      // 否则这类用户遇到 429 会被当成普通失败，一次不重试地刷到队列尽头。
      concurrency: 2,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 8000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.concurrencyLimits >= 1, true, "429 必须被识别为频控");
    assert.ok(finished.logs.some((log) => log.includes("[频控退避]")), "退避重试必须留下日志");
    assert.equal(finished.errors, 0, "首轮 429 应被重试消化，不该记成失败");
    assert.equal(finished.processed, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("并发调度：超出重试上限的持续 429 记为单行失败且不崩溃队列", async () => {
  clearProofreadCache();
  const { project } = setupMockProject(4, "persistent429");

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const match = body.match(/段落 (\d+)/);
      const rowNum = match ? Number(match[1]) : 0;
      if (rowNum === 2) {
        // 第 2 行持续返回 429
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0.05",
        });
        res.end(JSON.stringify({ error: { message: "Quota exceeded permanently" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              semanticSame: true,
              needsEdit: false,
              decision: "keep",
              summary: "正常",
            }),
          },
        }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      protocol: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 5,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 6000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    // 第 2 行重试 3 次后记录为错误
    assert.equal(finished.errors, 1);
    const failedResult = finished.results.find((r) => r.index === 2);
    assert.ok(failedResult);
    assert.equal(failedResult.status, "error");
    assert.match(failedResult.note, /频控限制已达重试上限/);
    assert.ok(finished.logs.some((log) => log.includes("连续 3 次触发频控限制，已达到最大重试次数")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("并发上限：设置随项目独立持久化，跨项目切换互不污染", async () => {
  const storage = {
    data: new Map(),
    getItem(k) { return this.data.get(k) ?? null; },
    setItem(k, v) { this.data.set(k, v); },
    removeItem(k) { this.data.delete(k); },
  };

  // 1. 打开项目 A：并发上限设为 12
  const uiA = createWorkbench(storage, { projectKey: "proj-alpha" });
  const concA = uiA.element("aiConcurrency");
  concA.value = "12";
  await concA.dispatch("change");

  const globalA = JSON.parse(storage.getItem("translation-compare-ai-config-v2") || "{}");
  assert.equal(globalA.concurrency, "12");
  const projectAConfig = JSON.parse(storage.getItem("translation-compare-ai-project-config-v2:proj-alpha") || "{}");
  assert.equal(projectAConfig.concurrency, "12");

  // 2. 打开项目 B：新项目继承全局基线 12，用户改成 2
  const uiB = createWorkbench(storage, { projectKey: "proj-beta" });
  const concB = uiB.element("aiConcurrency");
  assert.equal(concB.value, "12");
  concB.value = "2";
  await concB.dispatch("change");
  const projectBConfig = JSON.parse(storage.getItem("translation-compare-ai-project-config-v2:proj-beta") || "{}");
  assert.equal(projectBConfig.concurrency, "2");

  // 3. 重新加载项目 A / B：各自保持自己的并发上限
  assert.equal(createWorkbench(storage, { projectKey: "proj-alpha" }).element("aiConcurrency").value, "12");
  assert.equal(createWorkbench(storage, { projectKey: "proj-beta" }).element("aiConcurrency").value, "2");
});

test("并发上限：读取旧存档时折算智能并发字段，且保存后不再回写旧字段", () => {
  const storage = {
    data: new Map([
      // 全局存档：开启过智能并发，初始 4、上限 15 → 有效上限 15。
      ["translation-compare-ai-config-v2", JSON.stringify({ concurrency: "4", smartConcurrency: true, concurrencyMax: 15 })],
      // 项目存档：关闭智能并发，concurrencyMax 是历史遗留、从不生效。
      ["translation-compare-ai-project-config-v2:proj-fixed", JSON.stringify({ concurrency: "6", smartConcurrency: false, concurrencyMax: 20 })],
      ["translation-compare-ai-project-config-v2:proj-smart", JSON.stringify({ concurrency: "4", smartConcurrency: true, concurrencyMax: 15 })],
    ]),
    getItem(k) { return this.data.get(k) ?? null; },
    setItem(k, v) { this.data.set(k, v); },
    removeItem(k) { this.data.delete(k); },
  };

  // 项目存档优先于全局：固定并发的项目按 6 运行，不能被全局的 15 或自己遗留的 20 覆盖。
  const fixed = createWorkbench(storage, { projectKey: "proj-fixed" });
  assert.equal(fixed.element("aiConcurrency").value, "6");
  // 开启过智能并发的项目折算成 15，旧天花板不丢。
  const smart = createWorkbench(storage, { projectKey: "proj-smart" });
  assert.equal(smart.element("aiConcurrency").value, "15");

  // 触发一次保存：旧字段不再回写。
  smart.run("saveAiConfig();");
  const after = JSON.parse(storage.getItem("translation-compare-ai-project-config-v2:proj-smart") || "{}");
  assert.equal(after.concurrency, "15");
  assert.equal("smartConcurrency" in after, false);
  assert.equal("concurrencyMax" in after, false);
});

test("多阶段独立并发：各子阶段预设的并发上限各自保留，旧字段折算", () => {
  const conf = cleanConfig({
    concurrency: 3,
    stylistConfig: { protocol: "compatible", model: "gemini-3.8-flash", concurrency: 4 },
    arbiterConfig: { protocol: "claude", model: "claude-opus-4.6-thinking", concurrency: 2 },
  });
  assert.equal(conf.concurrency, 3);
  assert.equal(conf.stylistConfig.concurrency, 4);
  assert.equal(conf.arbiterConfig.concurrency, 2);
  for (const sub of [conf.stylistConfig, conf.arbiterConfig]) {
    assert.equal("smartConcurrency" in sub, false);
    assert.equal("concurrencyMax" in sub, false);
  }

  // 旧预设（开启智能并发）折算为各自的上限。
  const legacy = cleanConfig({
    concurrency: 3,
    smartConcurrency: true,
    concurrencyMax: 10,
    stylistConfig: { protocol: "compatible", model: "gemini-3.8-flash", concurrency: 4, smartConcurrency: true, concurrencyMax: 8 },
    arbiterConfig: { protocol: "claude", model: "claude-opus-4.6-thinking", concurrency: 2, smartConcurrency: false, concurrencyMax: 3 },
  });
  assert.equal(legacy.concurrency, 10);
  assert.equal(legacy.stylistConfig.concurrency, 8);
  assert.equal(legacy.arbiterConfig.concurrency, 2, "关闭智能并发的旧预设，concurrencyMax 从不生效");
});

test("起点语义：三个「开始」只表示起点，往下走到哪一段由下游配没配模型决定", () => {
  // 客户端契约：前端只报起点，级联范围由服务端算。
  assert.equal(cleanConfig({ stage: "all" }).targetStage, "all", "旧客户端的 all 继续被接受");
  assert.equal(cleanConfig({ stage: "stage1" }).targetStage, "stage1");
  assert.equal(cleanConfig({ stage: "stage2" }).targetStage, "stage2");
  assert.equal(cleanConfig({ stage: "stage3" }).targetStage, "stage3");

  const stylist = { protocol: "compatible", model: "gemini-3.8-flash" };
  const arbiter = { protocol: "compatible", model: "kimi-k3" };

  // 从阶段一起步：配了复审才往下走，配了仲裁才走到仲裁（仲裁只能接在复审后面）。
  const soloStage1 = stagePlan(cleanConfig({ stage: "stage1" }));
  assert.equal(soloStage1.startsAt, "stage1");
  assert.equal(soloStage1.cascadeToStylist, false, "没配阶段二就是纯初审");
  assert.equal(soloStage1.cascadeToArbiter, false);

  const withStylist = stagePlan(cleanConfig({ stage: "stage1", stylistConfig: stylist }));
  assert.equal(withStylist.cascadeToStylist, true);
  assert.equal(withStylist.cascadeToArbiter, false, "没配仲裁就停在复审");

  const withBoth = stagePlan(cleanConfig({ stage: "stage1", stylistConfig: stylist, arbiterConfig: arbiter }));
  assert.equal(withBoth.cascadeToStylist, true);
  assert.equal(withBoth.cascadeToArbiter, true);

  // 从阶段二起步：不会再回到复审，但分歧照样往下走到仲裁。
  const fromStage2 = stagePlan(cleanConfig({ stage: "stage2", stylistConfig: stylist, arbiterConfig: arbiter }));
  assert.equal(fromStage2.startsAt, "stage2");
  assert.equal(fromStage2.cascadeToStylist, false);
  assert.equal(fromStage2.cascadeToArbiter, true, "独立阶段二复审出分歧必须能进仲裁");

  const stage2NoArbiter = stagePlan(cleanConfig({ stage: "stage2", stylistConfig: stylist }));
  assert.equal(stage2NoArbiter.cascadeToArbiter, false, "没配仲裁就停在复审");

  // 从阶段三起步：本次流水线本身就是仲裁，没有「下游」可言。
  // cascadeToArbiter 的语义是「本次覆盖到仲裁」，客户端据此决定阶段三卡片显示「处理中」还是「未接入」；
  // 这里报 false 会让卡片显示「未接入（本次不会执行仲裁）」，而仲裁其实正在一行行跑。
  const stage3 = stagePlan(cleanConfig({ stage: "stage3", arbiterConfig: arbiter }));
  assert.equal(stage3.cascadeToStylist, false);
  assert.equal(stage3.cascadeToArbiter, true, "从阶段三起步时本次跑的就是仲裁，不能报成「未接入」");

  const stage3NoArbiter = stagePlan(cleanConfig({ stage: "stage3" }));
  assert.equal(stage3NoArbiter.cascadeToArbiter, false, "没配仲裁预设时不算接入仲裁");

  const stage3ArbiterOff = stagePlan(cleanConfig({ stage: "stage3", arbiterConfig: arbiter, arbiterEnabled: false }));
  assert.equal(stage3ArbiterOff.cascadeToArbiter, false, "显式关闸时不算接入仲裁");

  // 旧客户端的 all 语义等同「从阶段一起步」。
  const legacyAll = stagePlan(cleanConfig({ stage: "all", stylistConfig: stylist, arbiterConfig: arbiter }));
  assert.equal(legacyAll.startsAt, "stage1");
  assert.equal(legacyAll.cascadeToStylist, true);
  assert.equal(legacyAll.cascadeToArbiter, true);

  // arbiterEnabled=false 是显式关闸：即使配了仲裁预设也不往下走。
  const arbiterOff = stagePlan(cleanConfig({ stage: "stage1", stylistConfig: stylist, arbiterConfig: arbiter, arbiterEnabled: false }));
  assert.equal(arbiterOff.cascadeToArbiter, false);

  // 兼容入口：shouldCascadeStages 现在就是「会不会走到复审」。
  assert.equal(shouldCascadeStages(cleanConfig({ stage: "stage1", stylistConfig: stylist })), true);
  assert.equal(shouldCascadeStages(cleanConfig({ stage: "stage1" })), false);
  assert.equal(shouldCascadeStages(cleanConfig({ stage: "stage2", stylistConfig: stylist })), false);
});

test("起点语义：状态接口如实回报起点与级联范围，供刷新后恢复按钮态", () => {
  // 空闲时默认按阶段一、无级联回报：客户端据此知道当前没有流水线在跑。
  const idle = clientStatus({ includeResults: false });
  assert.equal(idle.stageMode, "stage1");
  assert.deepEqual(idle.stageCascade, { toStylist: false, toArbiter: false });
});

test("起点语义：从阶段一起步且配了复审时，初审提改行立即移交复审，不等阶段一整体跑完", async () => {
  clearProofreadCache();
  const totalRows = 6;
  const { project } = setupMockProject(totalRows, "cascade");

  let stage1Completed = 0;
  let stylistRequests = 0;
  let stylistFirstSeenAtStage1Completed = null;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
      const userText = String((payload.messages || []).find((message) => message.role === "user")?.content || "");
      // 复审请求的 user 载荷里带 gatekeeperReview，初审请求没有：据此区分两个阶段。
      const isStylist = userText.includes("gatekeeperReview");
      const content = isStylist
        ? { critique: { attitude: "accept", rationale: "同意初审改案" }, revisedText: "复审定案", summary: "复审采纳" }
        : { semanticSame: true, needsEdit: true, decision: "replace", revisedText: "初审改案", summary: "初审建议修改", score: 80 };

      if (isStylist) {
        stylistRequests += 1;
        if (stylistFirstSeenAtStage1Completed === null) {
          stylistFirstSeenAtStage1Completed = stage1Completed;
        }
      } else {
        stage1Completed += 1;
      }

      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      }, isStylist ? 5 : 30);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await startProofread({
      protocol: "compatible",
      baseUrl,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 2,
      // 前端只报起点：配了 stylistConfig 就等于这条流水线有第二阶段，服务端据此级联。
      stage: "stage1",
      stylistConfig: { protocol: "compatible", baseUrl, model: "stylist-model" },
      arbiterEnabled: false,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    let peakLiveReviewed = 0;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      // 运行中要能读到复审的实时计数：否则阶段二卡片会一直停在很小数字上，
      // 而阶段三已经在仲裁，看起来就像「阶段二没干活、阶段三抢跑」。
      peakLiveReviewed = Math.max(peakLiveReviewed, clientStatus({ includeResults: false }).stagePipelines?.stage2?.reviewed || 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stageMode, "stage1", "状态接口应回报起点是阶段一");
    assert.deepEqual(finished.stageCascade, { toStylist: true, toArbiter: false }, "回报的级联范围应与配置一致");
    assert.equal(finished.errors, 0);
    assert.equal(peakLiveReviewed > 0, true, "运行中必须能看到复审的实时计数");
    assert.equal(stylistRequests, totalRows, "每一行初审提改都要进入复审");
    assert.ok(stylistFirstSeenAtStage1Completed !== null, "复审请求必须真的发生");
    assert.ok(
      stylistFirstSeenAtStage1Completed < totalRows,
      `复审必须在阶段一整体跑完之前就开始（实际在第 ${stylistFirstSeenAtStage1Completed} 行初审完成后）`,
    );
    assert.ok(
      finished.logs.some((log) => log.includes("级联流水线：从阶段一起步，初审完一行立即移交复审")),
      "日志应说明本次走的是级联流水线",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("起点语义：从阶段二起步且配了仲裁时，复审分歧真的进仲裁（不再被直接吞掉）", async () => {
  clearProofreadCache();
  const totalRows = 3;
  const { project } = setupMockProject(totalRows, "stage2cascade");

  let stylistRequests = 0;
  let arbiterRequests = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
      const userText = String((payload.messages || []).find((message) => message.role === "user")?.content || "");
      // 仲裁载荷同时含 gatekeeperReview 与 stylistReview；复审载荷只有前者。
      const isArbiter = userText.includes("stylistReview");
      const isStylist = !isArbiter && userText.includes("gatekeeperReview");

      let content;
      if (isArbiter) {
        arbiterRequests += 1;
        content = { winner: "stylist", reason: "复审方案更贴切", finalDecision: "replace", revisedText: "终审定案", riskFlags: [] };
      } else if (isStylist) {
        stylistRequests += 1;
        // 显式请求终审：这是最确定的仲裁触发条件，不依赖 Butler 漂移判据。
        content = { critique: { attitude: "escalate", rationale: "与初审方案分歧明显，请终审裁决" }, revisedText: "复审改案", summary: "提交仲裁" };
      } else {
        content = { semanticSame: true, needsEdit: true, decision: "replace", revisedText: "初审改案", summary: "初审建议修改", score: 80 };
      }

      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      }, 5);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const waitDone = async () => {
      const deadline = Date.now() + 10000;
      while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    // 第一轮：只跑初审，留下内存结论（独立阶段二会复用它们，不必从备注重建）。
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 2, stage: "stage1",
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });
    await waitDone();
    assert.equal(clientStatus({ includeResults: false }).stageMode, "stage1");

    const rowNotes = {};
    for (const result of clientStatus().results) {
      if (result?.note) rowNotes[result.index] = result.note;
    }

    // 第二轮：从阶段二起步 + 配了仲裁 → 分歧必须继续往下走到仲裁。
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 2, stage: "stage2",
      stylistConfig: { protocol: "compatible", baseUrl, model: "stylist-model" },
      arbiterConfig: { protocol: "compatible", baseUrl, model: "arbiter-model" },
      rowNotes,
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });

    const live = clientStatus({ includeResults: false });
    assert.equal(live.stageMode, "stage2", "状态接口应回报起点是阶段二");
    assert.deepEqual(live.stageCascade, { toStylist: false, toArbiter: true }, "从阶段二起步应能级联到仲裁");

    await waitDone();

    assert.equal(stylistRequests, totalRows, "每一行初审提改都要复审");
    assert.ok(arbiterRequests > 0, "复审明确请求仲裁时，分歧必须真的进仲裁，不能被直接采纳复审结论吞掉");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("独立阶段二复用内存结论：只在同一项目快照上复用，跨快照一律退回备注重建", async () => {
  clearProofreadCache();
  const { project } = setupMockProject(2, "reuse");

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ semanticSame: true, needsEdit: false, decision: "keep", summary: "翻译准确" }) } }],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      protocol: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      stage: "stage1",
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });
    const deadline = Date.now() + 5000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(clientStatus().results.length > 0, "第一轮应留下内存结论");

    const sameSnapshot = { targetStage: "stage2", projectKey: project.projectKey, rowsSignature: project.rowsSignature };
    assert.equal(reusePreviousResults(sameSnapshot), true, "同项目快照 + 从阶段二起步应复用内存结论");
    assert.equal(reusePreviousResults({ ...sameSnapshot, targetStage: "stage3" }), true, "阶段三同理");
    // 行集或项目一变，行号就对不上：绝不能复用，宁可退回有损重建。
    assert.equal(reusePreviousResults({ ...sameSnapshot, rowsSignature: "other-rows" }), false);
    assert.equal(reusePreviousResults({ ...sameSnapshot, projectKey: "other-project" }), false);
    // 从阶段一起步不涉及复用。
    assert.equal(reusePreviousResults({ ...sameSnapshot, targetStage: "stage1" }), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("级联续跑：已有初审结论、只差复审的行直接进复审队列，不再重跑初审", async () => {
  clearProofreadCache();
  const totalRows = 6;
  const { project } = setupMockProject(totalRows, "resume");

  let stage1Requests = 0;
  let stylistRequests = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
      const userText = String((payload.messages || []).find((message) => message.role === "user")?.content || "");
      const isStylist = userText.includes("gatekeeperReview");
      const content = isStylist
        ? { critique: { attitude: "accept", rationale: "同意初审改案" }, revisedText: "复审定案", summary: "复审采纳" }
        : { semanticSame: true, needsEdit: true, decision: "replace", revisedText: "初审改案", summary: "初审建议修改", score: 80 };
      if (isStylist) stylistRequests += 1;
      else stage1Requests += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      }, 10);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const waitDone = async () => {
      const deadline = Date.now() + 10000;
      while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };

    // 第一轮：只跑初审，每行都提改（没配复审，提改行直接定案并写进备注）。
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 3, stage: "stage1",
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });
    await waitDone();
    assert.equal(stage1Requests, totalRows, "第一轮每行都要初审");
    assert.equal(stylistRequests, 0, "没配复审就不该有复审请求");

    const rowNotes = {};
    for (const result of clientStatus().results) {
      if (result?.note) rowNotes[result.index] = result.note;
    }
    assert.equal(Object.keys(rowNotes).length, totalRows, "第一轮应给每行留下备注");

    const stage1Before = stage1Requests;

    // 第二轮：从阶段一起步 + 配了复审 + 「继续剩下的」→ 这 6 行应当直接进复审队列。
    // 修之前它们会先被重新初审一遍，复审只能等初审逐行产出，界面上就是「待复审 N 行但只有 1 处理中」。
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 3, stage: "stage1",
      stylistConfig: { protocol: "compatible", baseUrl, model: "stylist-model" },
      continueOnly: true,
      rowNotes,
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });

    const live = clientStatus({ includeResults: false });
    assert.equal(live.stageCascade.toStylist, true);

    await waitDone();

    assert.equal(stage1Requests, stage1Before, "已有初审结论的行不得重跑初审");
    assert.equal(stylistRequests, totalRows, "这 6 行应当全部直接进入复审队列");
    assert.ok(
      clientStatus().logs.some((log) => log.includes(`级联续跑：${totalRows} 行已有初审结论`)),
      "日志应说明续跑了多少行",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("跨轮次续跑：待复审 20 行从页面请求进入真实队列，旧复审记录和内存均不阻挡", async () => {
  clearProofreadCache();
  const { project, rows } = setupMockProject(22, "latest-round");
  const oldReview = "[AI校对]\n是否需要修改：是\n初审改案：旧初审方案\nStylist复审[调整]：旧复审\n复审改案：旧复审方案\nArbiter仲裁[复审方案]：旧仲裁";
  const currentReview = "[AI校对]\n是否需要修改：是\n初审改案：本轮初审方案\nStylist复审[采纳]：同意\n复审改案：本轮初审方案";
  const records = Object.fromEntries(rows.map((row) => [row.index, {
    note: row.index === 21 ? currentReview : oldReview + "\n\n[AI校对]\n是否需要修改：" +
      (row.index % 2 ? "是\nGatekeeper初审：建议修改\n初审改案：本轮初审方案" : "待人工确认\nGatekeeper初审：初审存疑"),
    manualDone: row.index === 22,
  }]));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        critique: { attitude: "accept", rationale: "同意初审" }, revisedText: "本轮复审定案", summary: "复审采纳",
      }) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    // 第二次独立复审故意保留上一轮内存结果，验证换备注后不能误用旧完成标记。
    for (const stage of ["stage2", "stage2", "stage1"]) {
      const ui = createWorkbench(undefined, {
        rows, projectKey: project.projectKey, rowsSignature: project.rowsSignature,
        apiResponses: { "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "round", results: [] } } },
      });
      ui.storage.setItem("translation-compare-ai-presets-v2", JSON.stringify([
        { id: "latest-s2", name: "复审", protocol: "compatible", baseUrl, model: "stylist-model" },
      ]));
      ui.run(`Object.assign(notes, ${JSON.stringify(records)}); restoreAiConfig();
        aiIds.stage2Preset.value = "latest-s2";
        aiIds.protocol.value = "compatible"; aiIds.baseUrl.value = ${JSON.stringify(baseUrl)};
        aiIds.model.value = "test-model"; saveNotes(); updateStageMetricsDashboard();`);
      assert.equal(Number(ui.element("metricStage2Pending").textContent), 20);
      await ui.element("stage2PendingItem").dispatch("click");
      assert.equal(ui.run("filteredRows.length"), 20);
      await ui.element(stage + "Start").dispatch("click");
      await ui.element("aiConfirmKeep").dispatch("click");
      const post = ui.posts.find((entry) => entry.url === "/api/ai-proofread/start");
      assert.ok(post);
      assert.deepEqual(post.body.completedIndexes.sort((a, b) => a - b), [21, 22]);
      const requestStart = requests.length;
      await startProofread(post.body);
      assert.equal(clientStatus({ includeResults: false }).queued, 20);
      const deadline = Date.now() + 10000;
      while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const status = clientStatus();
      assert.equal(status.running, false);
      assert.equal(status.stageMetrics.stage2Errors, 0);
      assert.equal(requests.length - requestStart, 20, "20 行必须全部实际发起复审调用");
      assert.equal(status.stageMetrics.stage2Reviewed, 20);
      for (const payload of requests.slice(requestStart)) {
        const userText = payload.messages.find((message) => message.role === "user").content;
        assert.match(userText, /gatekeeperReview/, "级联续跑也不得重新初审");
        assert.doesNotMatch(userText, /旧初审方案|旧复审方案|旧仲裁/);
      }
    }
    const beforeClear = requests.length;
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model", stage: "stage2",
      stylistConfig: { protocol: "compatible", baseUrl, model: "stylist-model" },
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
      rowNotes: {}, continueOnly: false,
    });
    assert.equal(clientStatus({ includeResults: false }).queued, 0, "空备注快照不能从旧内存复活待办");
    assert.equal(clientStatus({ includeResults: false }).running, false);
    assert.equal(requests.length, beforeClear);
  } finally {
    stopProofread();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("阶段三异常不再静默：仲裁调用失败要计入仲裁异常并回退复审方案", async () => {
  clearProofreadCache();
  const totalRows = 2;
  const { project } = setupMockProject(totalRows, "arbfail");

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
      const userText = String((payload.messages || []).find((message) => message.role === "user")?.content || "");
      const isArbiter = userText.includes("stylistReview");
      const isStylist = !isArbiter && userText.includes("gatekeeperReview");

      if (isArbiter) {
        // 仲裁接口持续报错。修之前这一行既不算定案也不算异常——在指标上凭空消失，
        // 用户看到的就是「阶段三处理了很多行，定案数却一直不动」。
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "arbiter down" } }));
        return;
      }
      const content = isStylist
        ? { critique: { attitude: "escalate", rationale: "请终审裁决" }, revisedText: "复审改案", summary: "提交仲裁" }
        : { semanticSame: true, needsEdit: true, decision: "replace", revisedText: "初审改案", summary: "初审建议修改", score: 80 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 2, stage: "stage1",
      stylistConfig: { protocol: "compatible", baseUrl, model: "stylist-model" },
      arbiterConfig: { protocol: "compatible", baseUrl, model: "arbiter-model" },
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stageMetrics.stage3Arbitrated, 0, "仲裁全失败，不该有任何定案");
    assert.equal(finished.stageMetrics.stage3Errors, totalRows, "仲裁失败的每一行都必须计入仲裁异常，不能凭空消失");
    // 「异常」指标悬停时要能回答「到底出了哪些问题」：服务端把每一行的失败原因分类后随状态回报。
    const stage3Errors = finished.stageErrors.stage3;
    assert.equal(stage3Errors.server_error.count, totalRows, "5xx 仲裁失败应归类为服务端错误");
    assert.deepEqual(stage3Errors.server_error.rows, [1, 2], "明细要带出具体出错的行号");
    assert.match(stage3Errors.server_error.sample, /HTTP 500/, "明细要带出该类问题的代表性错误消息");
    assert.deepEqual(Object.keys(finished.stageErrors.stage1), [], "未失败阶段的明细必须为空");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("阶段三异常参与熔断：仲裁持续 5xx 时不再一行行刷满整个队列", async () => {
  clearProofreadCache();
  const totalRows = 12;
  const { project } = setupMockProject(totalRows, "arbbreaker");

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
      const userText = String((payload.messages || []).find((message) => message.role === "user")?.content || "");
      const isArbiter = userText.includes("stylistReview");
      const isStylist = !isArbiter && userText.includes("gatekeeperReview");

      if (isArbiter) {
        // 仲裁接口持续 5xx：既不是频控、也不是配置类致命错误，只能靠错误率熔断拦住。
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "arbiter down" } }));
        return;
      }
      const content = isStylist
        ? { critique: { attitude: "escalate", rationale: "请终审裁决" }, revisedText: "复审改案", summary: "提交仲裁" }
        : { semanticSame: true, needsEdit: true, decision: "replace", revisedText: "初审改案", summary: "初审建议修改", score: 80 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 2, stage: "stage1",
      stylistConfig: { protocol: "compatible", baseUrl, model: "stylist-model" },
      arbiterConfig: { protocol: "compatible", baseUrl, model: "arbiter-model" },
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.match(finished.error, /错误率熔断/, "仲裁持续失败必须触发熔断，而不是一路刷到队列尽头");
    assert.ok(
      finished.stageMetrics.stage3Errors < totalRows,
      `熔断必须在刷满 ${totalRows} 行之前生效，实际异常 ${finished.stageMetrics.stage3Errors} 行`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("阶段三致命请求错误立刻终止任务，不再逐行把异常刷到队列尽头", async () => {
  clearProofreadCache();
  const totalRows = 12;
  const { project } = setupMockProject(totalRows, "arbfatal");

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
      const userText = String((payload.messages || []).find((message) => message.role === "user")?.content || "");
      const isArbiter = userText.includes("stylistReview");
      const isStylist = !isArbiter && userText.includes("gatekeeperReview");

      if (isArbiter) {
        // 400 属于配置类致命错误（模型名/参数不被接口接受），必须当场终止整条流水线。
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid model" } }));
        return;
      }
      const content = isStylist
        ? { critique: { attitude: "escalate", rationale: "请终审裁决" }, revisedText: "复审改案", summary: "提交仲裁" }
        : { semanticSame: true, needsEdit: true, decision: "replace", revisedText: "初审改案", summary: "初审建议修改", score: 80 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 2, stage: "stage1",
      stylistConfig: { protocol: "compatible", baseUrl, model: "stylist-model" },
      arbiterConfig: { protocol: "compatible", baseUrl, model: "arbiter-model" },
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.match(finished.error, /AI 接口配置或响应异常/, "400 是配置类致命错误，必须终止任务");
    assert.ok(
      finished.stageMetrics.stage3Errors < totalRows,
      `致命错误必须在刷满 ${totalRows} 行之前终止，实际异常 ${finished.stageMetrics.stage3Errors} 行`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("复审分歧计数：复审出分歧但没有下游仲裁时，「分歧」不能是 0", async () => {
  clearProofreadCache();
  const totalRows = 2;
  const { project } = setupMockProject(totalRows, "diverged");

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
      const userText = String((payload.messages || []).find((message) => message.role === "user")?.content || "");
      const isStylist = userText.includes("gatekeeperReview");
      const content = isStylist
        ? { critique: { attitude: "modify", rationale: "调整语序更自然" }, revisedText: "复审改案", summary: "调整" }
        : { semanticSame: true, needsEdit: true, decision: "replace", revisedText: "初审改案", summary: "初审建议修改", score: 80 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 2, stage: "stage1",
      // 只配复审、不配仲裁：复审出的分歧没有下游可去，分歧数依然必须如实统计，
      // 否则「分歧」会退化成「已仲裁数」= 0，与弹窗按备注数出的待仲裁行数打架。
      stylistConfig: { protocol: "compatible", baseUrl, model: "stylist-model" },
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stageMetrics.stage2Reviewed, totalRows, "两行都复审过");
    assert.equal(finished.stageMetrics.stage2Diverged, totalRows, "复审出分歧的行必须计入分歧，不能只在仲裁完成后才 +1");
    assert.equal(finished.stageMetrics.stage3Arbitrated, 0, "没配仲裁就不该有仲裁");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("多阶段看板与预设联动：阶段卡片活跃信息展示各阶段独立并发指标", () => {
  const tools = createPresetTools();
  const storage = {
    data: new Map([
      [
        "translation-compare-ai-presets-v2",
        JSON.stringify([
          { id: "p1", name: "Gemini初审", protocol: "compatible", model: "gemini-flash", concurrency: 8 },
          { id: "p2", name: "Claude仲裁", protocol: "claude", model: "claude-opus", concurrency: 3 },
        ]),
      ],
    ]),
    getItem(k) { return this.data.get(k) ?? null; },
    setItem(k, v) { this.data.set(k, v); },
    removeItem(k) { this.data.delete(k); },
  };

  const ui = createWorkbench(storage);

  // 验证预设选项生成时携带了并发提示
  const s2Preset = ui.element("stage2PresetSelect");
  const options = (s2Preset.children || []).flatMap((node) => node.tagName === "OPTGROUP" ? node.children : [node]);
  const geminiOpt = options.find((o) => o.value === "p1");
  assert.ok(geminiOpt);
  assert.match(geminiOpt.title, /并发上限 8/);

  // 模拟带有各阶段独立并发的多阶段运行状态
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: true,
      total: 100,
      queued: 100,
      modelProcessed: 20,
      suggested: 5,
      errors: 0,
      currentConcurrency: 3,
      concurrencyMax: 10,
      stagePipelines: {
        stage1: { inFlight: 3, pending: 50, concurrency: 3, concurrencyMax: 10, activeRows: [1, 2, 3] },
        stage2: { inFlight: 4, pending: 10, concurrency: 4, concurrencyMax: 8, activeRows: [4, 5, 6, 7] },
        stage3: { inFlight: 2, pending: 2, concurrency: 2, concurrencyMax: 3, activeRows: [8, 9] },
      },
      results: [],
    });
  `);

  const activeText1 = ui.element("stage1ActiveRowsText").textContent;
  const activeText2 = ui.element("stage2ActiveRowsText").textContent;
  const activeText3 = ui.element("stage3ActiveRowsText").textContent;

  // 并发后缀默认只给「实际在飞 / 预设上限」：这里三段的队列都够，实际在飞正好等于许可值。
  // 「队列不足、实际在飞小于许可值」的场景由 ai-stage-metrics.test.js 覆盖。
  assert.match(activeText1, /1, 2, 3/);
  assert.match(activeText1, /并发 3\/10/);

  assert.match(activeText2, /4, 5, 6\.\.\./);
  assert.match(activeText2, /并发 4\/8/);

  assert.match(activeText3, /8, 9/);
  assert.match(activeText3, /并发 2\/3/);

  // 只有实际在飞真的顶到预设上限时才额外标「触顶」：许可值触顶、实际在飞没跟上（队列不足）
  // 不算触顶，否则又会出现「1 处理中 · 并发 32/32 · 触顶」这种自相矛盾的画面。
  ui.run(`
    renderAiStatus({
      kind: "ai",
      running: true,
      total: 100,
      queued: 100,
      modelProcessed: 20,
      suggested: 5,
      errors: 0,
      currentConcurrency: 10,
      concurrencyMax: 10,
      stagePipelines: {
        stage1: { inFlight: 10, pending: 5, concurrency: 10, concurrencyMax: 10, activeRows: [1, 2, 3] },
        stage2: { inFlight: 0, pending: 0, concurrency: 0, concurrencyMax: 8, activeRows: [] },
        stage3: { inFlight: 0, pending: 0, concurrency: 0, concurrencyMax: 3, activeRows: [] },
      },
      results: [],
    });
  `);
  assert.match(ui.element("stage1ActiveRowsText").textContent, /并发 10\/10 · 触顶/);
  assert.match(ui.element("stage1ActiveInfo").title, /实际在飞已达预设并发上限（触顶）/);
});

function passingBody() {
  return JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({ semanticSame: true, needsEdit: false, decision: "keep", summary: "正常" }),
      },
    }],
  });
}

// 首档冷却按缩放后的毫秒数：测试里用它判断「断路器打开后多久才放行」。
const firstCooldownMs = (scale) => Math.round(BREAKER_POLICY.limit.cooldownsMs[0] * scale);

async function withBreakerTimeScale(scale, run) {
  const previous = process.env.TRANSCOMPARATOR_BREAKER_TIME_SCALE;
  process.env.TRANSCOMPARATOR_BREAKER_TIME_SCALE = String(scale);
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.TRANSCOMPARATOR_BREAKER_TIME_SCALE;
    else process.env.TRANSCOMPARATOR_BREAKER_TIME_SCALE = previous;
  }
}

test("限流熔断：上游持续 429 时按冷却阶梯探测，阶梯用尽后终止且不刷满队列", async () => {
  clearProofreadCache();
  const totalRows = 12;
  const { project } = setupMockProject(totalRows, "limitsaturation");
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0.01" });
      res.end(JSON.stringify({ error: { message: "all channels in 429 cooldown" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await withBreakerTimeScale(0.001, async () => {
      await startProofread({
        protocol: "compatible",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: "test-model",
        proofreadMode: "bilingual",
        concurrency: 1,
        projectKey: project.projectKey,
        rowsSignature: project.rowsSignature,
      });
      const deadline = Date.now() + 15000;
      while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, true);
    assert.match(finished.error, new RegExp(`AI 上游持续限流熔断（初审）：已按 ${BREAKER_POLICY.limit.cooldownsMs.length} 档冷却重试`));
    const logs = finished.logs.join("\n");
    assert.match(logs, /\[熔断\] 初审：连续多行限流重试用尽，暂停派发/);
    assert.match(logs, /\[熔断\] 初审：探测仍被限流，继续冷却/);
    // 前两行按原逻辑记失败，第三行起进入冷却而不是继续记失败，最后一次探测触发终止。
    assert.ok(finished.errors <= 3, `冷却期间的行不该记成失败，实际异常 ${finished.errors} 行`);
    assert.ok(finished.processed < totalRows, "熔断后剩余行不应被处理");
    // 3 行 × 4 次 + 3 次单发探测；绝不该刷满 12 行 × 4 次。
    assert.ok(requestCount <= 20, `限流下必须停手，实际发出 ${requestCount} 次请求`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("限流熔断：冷却后探测成功即恢复，被暂缓的行不记失败并跑完全程", async () => {
  clearProofreadCache();
  const totalRows = 8;
  const { project } = setupMockProject(totalRows, "limitrecover");
  let requestCount = 0;
  // 前 14 个请求全部 429：前三行各用尽 4 次（12 次）后断路器打开，
  // 第 13、14 次是两次失败的探测，第 15 次起放行。
  const limitedRequests = 14;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    const limited = requestCount <= limitedRequests;
    req.resume();
    req.on("end", () => {
      if (limited) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0.01" });
        res.end(JSON.stringify({ error: { message: "all channels in 429 cooldown" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(passingBody());
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await withBreakerTimeScale(0.001, async () => {
      await startProofread({
        protocol: "compatible",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: "test-model",
        proofreadMode: "bilingual",
        concurrency: 1,
        projectKey: project.projectKey,
        rowsSignature: project.rowsSignature,
      });
      const deadline = Date.now() + 15000;
      while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, false);
    assert.equal(finished.error, "");
    assert.equal(finished.processed, totalRows);
    // 只有冷却打开之前用尽重试的前两行记为失败；第三行被暂缓后探测成功，正常完成。
    assert.equal(finished.errors, 2);
    const third = finished.results.find((r) => r.index === 3);
    assert.ok(third && third.status !== "error", "被暂缓的行不能记成失败");
    const logs = finished.logs.join("\n");
    assert.match(logs, /\[熔断\] 初审：连续多行限流重试用尽，暂停派发/);
    assert.match(logs, /限流冷却解除，恢复正常派发/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("限流熔断：冷却结束后只放行一个探测请求，探测通过才恢复到设定并发", async () => {
  clearProofreadCache();
  const totalRows = 8;
  const { project } = setupMockProject(totalRows, "halfopen");
  const okRequests = [];
  // 首档冷却按 0.03 缩放。服务端轮询日志，看到断路器真正打开后再计时，
  // 冷却期内一律 429（含迟到的在途请求），冷却结束后放行并稍作延迟，
  // 让「探测尚未返回时是否又冲出别的请求」可被观察到。
  const cooldownMs = firstCooldownMs(0.03);
  let openedAt = 0;
  const watcher = setInterval(() => {
    if (!openedAt && clientStatus({ includeResults: false }).logs.some((log) => log.includes("暂停派发"))) {
      openedAt = Date.now();
    }
  }, 5);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (!openedAt || Date.now() < openedAt + cooldownMs + 30) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0.01" });
        res.end(JSON.stringify({ error: { message: "all channels in 429 cooldown" } }));
        return;
      }
      const record = { start: Date.now(), end: 0 };
      okRequests.push(record);
      setTimeout(() => {
        record.end = Date.now();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(passingBody());
      }, 80);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await withBreakerTimeScale(0.03, async () => {
      await startProofread({
        protocol: "compatible",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: "test-model",
        proofreadMode: "bilingual",
        concurrency: 32,
        projectKey: project.projectKey,
        rowsSignature: project.rowsSignature,
      });
      const deadline = Date.now() + 15000;
      while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, false);
    assert.match(finished.logs.join("\n"), /限流冷却解除/);
    assert.ok(okRequests.length >= 2, "探测通过后剩余行应继续处理");
    assert.ok(
      okRequests[1].start >= okRequests[0].end,
      "半开阶段探测未返回前不得再放行第二个请求（并发 32 时不应一拥而上）",
    );
  } finally {
    clearInterval(watcher);
    await new Promise((resolve) => server.close(resolve));
  }
});

test("阶段三模型拒答不计入熔断：仲裁全部拒答时任务跑完，回退复审方案", async () => {
  clearProofreadCache();
  const totalRows = 12;
  const { project } = setupMockProject(totalRows, "arbrefusal");

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
      const userText = String((payload.messages || []).find((message) => message.role === "user")?.content || "");
      const isArbiter = userText.includes("stylistReview");
      const isStylist = !isArbiter && userText.includes("gatekeeperReview");

      if (isArbiter) {
        // 拒答是上游的正常应答（内容安全审查），不是接口故障，不能被熔断当成失败样本。
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "The model declined to answer" } }));
        return;
      }
      const content = isStylist
        ? { critique: { attitude: "escalate", rationale: "请终审裁决" }, revisedText: "复审改案", summary: "提交仲裁" }
        : { semanticSame: true, needsEdit: true, decision: "replace", revisedText: "初审改案", summary: "初审建议修改", score: 80 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 2, stage: "stage1",
      stylistConfig: { protocol: "compatible", baseUrl, model: "stylist-model" },
      arbiterConfig: { protocol: "compatible", baseUrl, model: "arbiter-model" },
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, false, "拒答不该触发熔断");
    assert.equal(finished.error, "");
    assert.equal(finished.processed, totalRows, "每一行都要走完并回退到复审方案");
    assert.equal(finished.stageMetrics.stage3Errors, totalRows, "拒答行仍如实计入仲裁异常，指标口径不变");
    assert.match(finished.logs.join("\n"), /终审仲裁被模型拒答（内容安全审查），回退至复审方案/);
    // 拒答不是接口故障：明细里要单列为「模型拒答」，而不是被归成 4xx 的配置错误。
    const refusals = finished.stageErrors.stage3.refusal;
    assert.equal(refusals.count, totalRows, "拒答的每一行都要登记为 refusal 类");
    assert.deepEqual(Object.keys(finished.stageErrors.stage3), ["refusal"], "拒答行不能同时落进别的类别");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("异常明细不跨任务残留：上一次运行的失败行，在新任务启动后不再挂在悬停明细里", async () => {
  clearProofreadCache();
  const totalRows = 2;
  const { project } = setupMockProject(totalRows, "errscope");
  let arbiterHealthy = false;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
      const userText = String((payload.messages || []).find((message) => message.role === "user")?.content || "");
      const isArbiter = userText.includes("stylistReview");
      const isStylist = !isArbiter && userText.includes("gatekeeperReview");

      if (isArbiter && !arbiterHealthy) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "arbiter down" } }));
        return;
      }
      const content = isArbiter
        ? { verdict: "keep_stylist", revisedText: "仲裁定案", summary: "仲裁通过" }
        : isStylist
          ? { critique: { attitude: "escalate", rationale: "请终审裁决" }, revisedText: "复审改案", summary: "提交仲裁" }
          : { semanticSame: true, needsEdit: true, decision: "replace", revisedText: "初审改案", summary: "初审建议修改", score: 80 };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const runToEnd = async (baseUrl) => {
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 2, stage: "stage1",
      stylistConfig: { protocol: "compatible", baseUrl, model: "stylist-model" },
      arbiterConfig: { protocol: "compatible", baseUrl, model: "arbiter-model" },
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });
    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return clientStatus();
  };

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const first = await runToEnd(baseUrl);
    assert.equal(first.stageErrors.stage3.server_error.count, totalRows, "前提：第一次运行确实记下了仲裁失败");

    arbiterHealthy = true;
    const second = await runToEnd(baseUrl);
    assert.equal(second.running, false);
    assert.equal(second.stageMetrics.stage3Errors, 0, "第二次运行仲裁全部成功");
    assert.deepEqual(second.stageErrors.stage3, {}, "上一次运行的失败明细不能残留到新任务里");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("异常明细：用户停止任务时，被打断的行归为「任务已终止」而不是网络故障", async () => {
  clearProofreadCache();
  const totalRows = 3;
  const { project } = setupMockProject(totalRows, "errstop");
  let received = 0;

  // 服务端收到请求后既不应答也不断开：让这一行稳稳停在「调用中」，再由用户按下停止。
  const server = http.createServer(() => { received += 1; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    await startProofread({
      protocol: "compatible", baseUrl, model: "test-model",
      proofreadMode: "bilingual", concurrency: 1, stage: "stage1",
      projectKey: project.projectKey, rowsSignature: project.rowsSignature,
    });
    const awaitDeadline = Date.now() + 5000;
    while (received === 0 && Date.now() < awaitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(received > 0, "前提：至少有一行已经发出请求");

    stopProofread();
    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // 被打断那一行的 catch 在 running 翻成 false 之后才跑到：等明细落下再断言，别读到中间态。
    const settleDeadline = Date.now() + 2000;
    while (!clientStatus({ includeResults: false }).stageErrors.stage1.stopped && Date.now() < settleDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const finished = clientStatus();
    assert.equal(finished.running, false);
    const stage1 = finished.stageErrors.stage1;
    assert.ok(stage1.stopped?.count >= 1, "被打断的行要登记为「任务已终止」");
    assert.equal(stage1.network, undefined, "中断异常不能被记成网络故障");
    assert.equal(stage1.unknown, undefined, "中断异常不能落进「其他错误」");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("并发调度与熔断联动：断路器打开时并发塌到 1，恢复后从低位重新爬升，不一步跳回冷却前水位", async () => {
  clearProofreadCache();
  const totalRows = 40;
  const { project } = setupMockProject(totalRows, "breakerlink");
  const inFlightAtSend = [];
  let inFlight = 0;
  let requestCount = 0;
  let openedAt = 0;
  // 首档冷却按 0.03 缩放。看到断路器真正打开后再计时：冷却期内一律 429，
  // 冷却结束后放行。放行后记录每个请求发出时刻的在途数，用来检验恢复期的并发爬升曲线。
  const cooldownMs = firstCooldownMs(0.03);
  const watcher = setInterval(() => {
    if (!openedAt && clientStatus({ includeResults: false }).logs.some((log) => log.includes("暂停派发"))) {
      openedAt = Date.now();
    }
  }, 5);
  const server = http.createServer((req, res) => {
    requestCount += 1;
    inFlight += 1;
    const limited = requestCount <= 3 * 4 /* 前三行各用尽 4 次重试，凑满 3 行触发断路器 */
      || (openedAt && Date.now() < openedAt + cooldownMs + 30)
      || !openedAt;
    if (!limited) inFlightAtSend.push(inFlight);
    req.resume();
    req.on("end", () => {
      setTimeout(() => {
        inFlight -= 1;
        if (limited) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "0.01" });
          res.end(JSON.stringify({ error: { message: "all channels in 429 cooldown" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(passingBody());
      }, 30);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const prevInterval = process.env.TRANSCOMPARATOR_CONCURRENCY_STEP_INTERVAL;
  process.env.TRANSCOMPARATOR_CONCURRENCY_STEP_INTERVAL = "10";
  try {
    await withBreakerTimeScale(0.03, async () => {
      await startProofread({
        protocol: "compatible",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: "test-model",
        proofreadMode: "bilingual",
        concurrency: 32,
        projectKey: project.projectKey,
        rowsSignature: project.rowsSignature,
      });
      const deadline = Date.now() + 20000;
      while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stopRequested, false, "探测成功后应恢复并跑完，不该被终止");
    const logs = finished.logs.join("\n");
    assert.match(logs, /\[熔断\] 初审：连续多行限流重试用尽，暂停派发/);
    assert.match(logs, /\[并发调度\] 初审：熔断冷却，并发降到 1（冷却前 \d+）；恢复后从 1 起步慢启动，先爬到 \d+/, "断路器打开必须把并发塌到 1 并留下日志");
    // 慢启动阈值应取出事水位的一半（>= 2），而不是拿已被压到 1 的当前并发去算。
    const threshold = Number(logs.match(/先爬到 (\d+)/)[1]);
    assert.ok(threshold >= 2 && threshold <= 16, `慢启动阈值应在 2~16 之间，实际 ${threshold}`);
    assert.match(logs, /并发从 1 翻倍至 2/, "恢复后应走慢启动（一整轮正常即翻倍），而不是 15 次才 +1");
    assert.match(logs, /限流冷却解除/);
    // 恢复后的第一批请求不得一拥而上：半开探测只放行 1 个，探测通过后也是从低位慢启动，
    // 而不是一步回到 3 或更高（旧行为：直接回到冷却前的水位）。
    assert.ok(inFlightAtSend.length >= 2, "冷却解除后应继续处理剩余行");
    assert.equal(inFlightAtSend[0], 1, "半开探测只放行一个请求");
    assert.ok(inFlightAtSend.slice(0, 2).every((n) => n <= 2), `恢复初期并发必须处于低位，实际前两个请求发出时在途数 ${inFlightAtSend.slice(0, 2)}`);
  } finally {
    clearInterval(watcher);
    if (prevInterval === undefined) delete process.env.TRANSCOMPARATOR_CONCURRENCY_STEP_INTERVAL;
    else process.env.TRANSCOMPARATOR_CONCURRENCY_STEP_INTERVAL = prevInterval;
    await new Promise((resolve) => server.close(resolve));
  }
});
