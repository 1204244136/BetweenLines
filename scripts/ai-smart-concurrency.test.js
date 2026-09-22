const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-smart-concurrency-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const {
  clearProofreadCache,
  clientStatus,
  isConcurrencyOrRateLimitError,
  parseRateLimitReason,
  startProofread,
  stopProofread,
} = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const {
  createProjectStaging,
  projectArtifacts,
  publishProject,
} = require("./project-store");
const { createPresetTools } = require("../src/workbenches/translation-compare/ai-presets");
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

test("smart-concurrency: error detection accurately identifies rate limits, overload and concurrency signals", () => {
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

test("smart-concurrency: presetTools cleans and preserves smartConcurrency and concurrencyMax", () => {
  const tools = createPresetTools();

  const cleanedDefault = tools.sanitizePreset({
    name: "默认预设",
    provider: "local",
  });
  assert.equal(cleanedDefault.smartConcurrency, false);
  assert.equal(cleanedDefault.concurrency, 3);
  assert.equal(cleanedDefault.concurrencyMax, 10);

  const cleanedCustom = tools.sanitizePreset({
    name: "自适应预设",
    provider: "compatible",
    smartConcurrency: true,
    concurrency: 5,
    concurrencyMax: 15,
  });
  assert.equal(cleanedCustom.smartConcurrency, true);
  assert.equal(cleanedCustom.concurrency, 5);
  assert.equal(cleanedCustom.concurrencyMax, 15);

  // concurrencyMax 边界裁剪
  const cleanedClamped = tools.sanitizePreset({
    name: "超界预设",
    smartConcurrency: true,
    concurrency: 4,
    concurrencyMax: 99, // 超出 1~20 回退为 10
  });
  assert.equal(cleanedClamped.concurrencyMax, 10);
});

test("smart-concurrency UI: renders smart concurrency controls, labels and toggles visibility", async () => {
  const tools = createPresetTools();
  const storage = {
    data: new Map(),
    getItem(k) { return this.data.get(k) ?? null; },
    setItem(k, v) { this.data.set(k, v); },
    removeItem(k) { this.data.delete(k); },
  };

  const ui = createWorkbench(storage);
  const smartCheckbox = ui.element("aiSmartConcurrency");
  const concurrencyInput = ui.element("aiConcurrency");
  const concurrencyLabel = ui.element("aiConcurrencyLabel");
  const maxWrap = ui.element("aiConcurrencyMaxWrap");
  const maxInput = ui.element("aiConcurrencyMax");

  assert.ok(smartCheckbox, "aiSmartConcurrency checkbox exists");
  assert.ok(maxWrap, "aiConcurrencyMaxWrap exists");
  assert.ok(maxInput, "aiConcurrencyMax exists");

  // 初始状态：未开启智能并发
  assert.equal(smartCheckbox.checked, false);
  assert.equal(concurrencyLabel.textContent, "并发");
  assert.equal(maxWrap.hidden, true);

  // 设置并发数值并开启智能并发
  concurrencyInput.value = "3";
  maxInput.value = "10";
  smartCheckbox.checked = true;
  await smartCheckbox.dispatch("change");

  assert.equal(concurrencyLabel.textContent, "初始并发");
  assert.equal(maxWrap.hidden, false);

  // 检查保存到 storage
  const savedConfig = JSON.parse(storage.getItem("translation-compare-ai-config-v1") || "{}");
  assert.equal(savedConfig.smartConcurrency, true);
  assert.equal(savedConfig.concurrency, "3");
  assert.equal(savedConfig.concurrencyMax, "10");

  // 关闭智能并发
  smartCheckbox.checked = false;
  await smartCheckbox.dispatch("change");
  assert.equal(concurrencyLabel.textContent, "并发");
  assert.equal(maxWrap.hidden, true);
});

test("smart-concurrency: dynamic upward probing on consecutive successes", async () => {
  clearProofreadCache();
  const { project } = setupMockProject(15, "probe");

  let requestsHandled = 0;
  let maxConcurrentSeen = 0;
  let currentInFlight = 0;

  const server = http.createServer((req, res) => {
    currentInFlight += 1;
    maxConcurrentSeen = Math.max(maxConcurrentSeen, currentInFlight);
    requestsHandled += 1;

    setTimeout(() => {
      currentInFlight -= 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              semanticSame: true,
              needsEdit: false,
              decision: "keep",
              summary: "翻译准确",
            }),
          },
        }],
      }));
    }, 20);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const prevInterval = process.env.TRANSCOMPARATOR_SMART_PROBE_INTERVAL;
  process.env.TRANSCOMPARATOR_SMART_PROBE_INTERVAL = "10"; // 缩短探测冷却时间以便快速上探

  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      smartConcurrency: true,
      concurrency: 2, // 初始并发 2
      concurrencyMax: 4, // 上限 4
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
    assert.equal(finished.smartConcurrency, true);
    assert.equal(finished.peakConcurrency >= 3, true);
    assert.equal(finished.concurrencyUps >= 1, true);
    assert.ok(finished.logs.some((log) => log.includes("[智能并发] 连续 5 次请求正常，并发从 2 上探至 3")));
  } finally {
    if (prevInterval === undefined) delete process.env.TRANSCOMPARATOR_SMART_PROBE_INTERVAL;
    else process.env.TRANSCOMPARATOR_SMART_PROBE_INTERVAL = prevInterval;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("smart-concurrency: encounters HTTP 429 rate limit, scales down, backs off and retries to completion", async () => {
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
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      smartConcurrency: true,
      concurrency: 4, // 初始并发 4
      concurrencyMax: 6,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 6000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.smartConcurrency, true);
    // 遇到限流下调
    assert.equal(finished.concurrencyLimits >= 1, true);
    assert.equal(finished.concurrencyDowns >= 1, true);
    // 重试后全部 8 行均正常完成，错误数为 0
    assert.equal(finished.errors, 0);
    assert.equal(finished.processed, 8);
    assert.ok(finished.logs.some((log) => log.includes("遭遇HTTP 429 请求频次超限")));
    assert.ok(finished.logs.some((log) => log.includes("智能并发统计：")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("smart-concurrency: persistent 429 beyond max retries records failure without crashing the queue", async () => {
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
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      smartConcurrency: true,
      concurrency: 3,
      concurrencyMax: 5,
      circuitBreakerEnabled: false, // 关闭熔断以便观察重试上限
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
