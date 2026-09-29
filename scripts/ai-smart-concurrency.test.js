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
  cleanConfig,
  cleanSubStageConfig,
  shouldCascadeStages,
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

test("智能并发：预设工具正确清洗并持久化 smartConcurrency 与 concurrencyMax", () => {
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

  // concurrencyMax 边界裁剪：越界截断到上限
  const cleanedClamped = tools.sanitizePreset({
    name: "超界预设",
    smartConcurrency: true,
    concurrency: 4,
    concurrencyMax: 99,
  });
  assert.equal(cleanedClamped.concurrencyMax, 32);
});

test("并发上限：预设与服务端一致放开到 32，20 不再被静默改写", () => {
  const tools = createPresetTools();

  // 用户这次的实际现象：预设里选 20，旧实现因 20 > 12 直接回落成 3。
  const preset = tools.sanitizePreset({ name: "20 并发预设", concurrency: 20, concurrencyMax: 20 });
  assert.equal(preset.concurrency, 20);
  assert.equal(preset.concurrencyMax, 20);

  // 预设侧边界：下界仍保底 1，上界截断到 32。
  assert.equal(tools.sanitizePreset({ name: "下界", concurrency: 0 }).concurrency, 1);
  assert.equal(tools.sanitizePreset({ name: "上界", concurrency: 33 }).concurrency, 32);
  assert.equal(tools.sanitizePreset({ name: "上限越界", concurrencyMax: 33 }).concurrencyMax, 32);
  // 非整数仍回落到默认值，不参与截断。
  assert.equal(tools.sanitizePreset({ name: "非整数", concurrency: 2.5 }).concurrency, 3);

  // 服务端侧必须与预设侧同档，否则预设保存 20、运行又被压回 12。
  const mainConf = cleanConfig({ concurrency: 20, concurrencyMax: 20 });
  assert.equal(mainConf.concurrency, 20);
  assert.equal(mainConf.concurrencyMax, 20);
  assert.equal(cleanConfig({ concurrency: 33 }).concurrency, 32);
  assert.equal(cleanConfig({ concurrency: 0 }).concurrency, 1);

  const subConf = cleanSubStageConfig({ model: "gpt-4o", concurrency: 20, concurrencyMax: 20 });
  assert.equal(subConf.concurrency, 20);
  assert.equal(subConf.concurrencyMax, 20);
  assert.equal(cleanSubStageConfig({ model: "gpt-4o", concurrency: 33 }).concurrency, 32);

  // 生成页面也必须把放开后的上界写进控件，否则数字箭头上不去、提示文案还停在旧口径。
  const html = makeHtml(
    [{ index: 1, jp: "原文一", cn: "译文一", relation: "1:1", score: 0.9, signature: "sig-1" }],
    { comparisonMode: "bilingual", files: { jp: "A.txt", cn: "B.txt" }, labels: { jp: "原文", cn: "译文" } },
    { projectKey: "project", rowsSignature: "rows", notesStorage: { key: "rows" } },
  );
  assert.match(html, /id="aiConcurrency"[^>]*max="32"/);
  assert.match(html, /id="aiConcurrencyMax"[^>]*max="32"/);
});

test("智能并发界面：渲染智能并发开关、控件与状态可见性联动", async () => {
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

test("智能并发：连续成功触发动态向上探测试探更高并发", async () => {
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

test("智能并发：遭遇 HTTP 429 频控时自动下调并发、退避并在重试中完成", async () => {
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

test("智能并发：超出重试上限的持续 429 记为单行失败且不崩溃队列", async () => {
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

test("智能并发：状态与并发设置随项目独立持久化，跨项目切换互不污染", async () => {
  const storage = {
    data: new Map(),
    getItem(k) { return this.data.get(k) ?? null; },
    setItem(k, v) { this.data.set(k, v); },
    removeItem(k) { this.data.delete(k); },
  };

  // 1. 打开项目 A（proj-alpha）：开启智能并发，设置初始并发 4，上限 12
  const uiA = createWorkbench(storage, { projectKey: "proj-alpha" });
  const chkA = uiA.element("aiSmartConcurrency");
  const concA = uiA.element("aiConcurrency");
  const maxA = uiA.element("aiConcurrencyMax");

  assert.equal(chkA.checked, false);
  concA.value = "4";
  maxA.value = "12";
  chkA.checked = true;
  await chkA.dispatch("change");

  // 验证全局与项目 A 专属 key 均持久化
  const globalA = JSON.parse(storage.getItem("translation-compare-ai-config-v1") || "{}");
  assert.equal(globalA.smartConcurrency, true);
  assert.equal(globalA.concurrency, "4");
  assert.equal(globalA.concurrencyMax, "12");

  const projectAConfig = JSON.parse(storage.getItem("translation-compare-ai-project-config-v1:proj-alpha") || "{}");
  assert.equal(projectAConfig.smartConcurrency, true);
  assert.equal(projectAConfig.concurrency, "4");
  assert.equal(projectAConfig.concurrencyMax, "12");

  // 2. 打开项目 B（proj-beta）：关闭智能并发，并将并发设为 2
  const uiB = createWorkbench(storage, { projectKey: "proj-beta" });
  const chkB = uiB.element("aiSmartConcurrency");
  const concB = uiB.element("aiConcurrency");

  // 新项目继承全局 baseline，初始为 true
  assert.equal(chkB.checked, true);
  // 用户在项目 B 中关闭智能并发并调整为固定并发 2
  chkB.checked = false;
  concB.value = "2";
  await chkB.dispatch("change");

  const projectBConfig = JSON.parse(storage.getItem("translation-compare-ai-project-config-v1:proj-beta") || "{}");
  assert.equal(projectBConfig.smartConcurrency, false);
  assert.equal(projectBConfig.concurrency, "2");

  // 3. 重新加载项目 A：验证依然保持项目 A 的配置（开启，并发 4，上限 12），未受项目 B 影响
  const uiAReloaded = createWorkbench(storage, { projectKey: "proj-alpha" });
  assert.equal(uiAReloaded.element("aiSmartConcurrency").checked, true);
  assert.equal(uiAReloaded.element("aiConcurrency").value, "4");
  assert.equal(uiAReloaded.element("aiConcurrencyMax").value, "12");
  assert.equal(uiAReloaded.element("aiConcurrencyLabel").textContent, "初始并发");
  assert.equal(uiAReloaded.element("aiConcurrencyMaxWrap").hidden, false);

  // 4. 重新加载项目 B：验证依然保持项目 B 的配置（关闭，并发 2）
  const uiBReloaded = createWorkbench(storage, { projectKey: "proj-beta" });
  assert.equal(uiBReloaded.element("aiSmartConcurrency").checked, false);
  assert.equal(uiBReloaded.element("aiConcurrency").value, "2");
  assert.equal(uiBReloaded.element("aiConcurrencyLabel").textContent, "并发");
  assert.equal(uiBReloaded.element("aiConcurrencyMaxWrap").hidden, true);
});

test("智能并发：历史快照页面缺失控件时具备防冲刷保护，不将已有智能并发覆写为 false", async () => {
  const storage = {
    data: new Map([
      ["translation-compare-ai-config-v1", JSON.stringify({ smartConcurrency: true, concurrencyMax: 15 })],
      ["translation-compare-ai-project-config-v1:proj-legacy", JSON.stringify({ smartConcurrency: true, concurrencyMax: 15 })],
    ]),
    getItem(k) { return this.data.get(k) ?? null; },
    setItem(k, v) { this.data.set(k, v); },
    removeItem(k) { this.data.delete(k); },
  };

  const uiLegacy = createWorkbench(storage, { projectKey: "proj-legacy" });
  // 模拟历史快照 DOM 中缺失 aiSmartConcurrency 控件
  uiLegacy.run("aiIds.smartConcurrency = null; aiIds.concurrencyMax = null;");

  // 触发一次保存（如在历史快照页面中调整其他选项）
  uiLegacy.run("saveAiConfig();");

  // 验证防冲刷保护生效：已有的 smartConcurrency 依然为 true，上限 15 未被重置
  const globalAfter = JSON.parse(storage.getItem("translation-compare-ai-config-v1") || "{}");
  assert.equal(globalAfter.smartConcurrency, true);
  assert.equal(globalAfter.concurrencyMax, 15);

  const projectAfter = JSON.parse(storage.getItem("translation-compare-ai-project-config-v1:proj-legacy") || "{}");
  assert.equal(projectAfter.smartConcurrency, true);
  assert.equal(projectAfter.concurrencyMax, 15);
});

test("多阶段独立并发：各子阶段预设能够正确保留并清洗并发配置", () => {
  const conf = cleanConfig({
    concurrency: 3,
    smartConcurrency: true,
    concurrencyMax: 10,
    stylistConfig: {
      provider: "compatible",
      model: "gemini-3.8-flash",
      concurrency: 4,
      smartConcurrency: true,
      concurrencyMax: 8,
    },
    arbiterConfig: {
      provider: "claude",
      model: "claude-opus-4.6-thinking",
      concurrency: 2,
      smartConcurrency: false,
      concurrencyMax: 3,
    },
  });

  // 主阶段
  assert.equal(conf.concurrency, 3);
  assert.equal(conf.smartConcurrency, true);
  assert.equal(conf.concurrencyMax, 10);

  // 阶段二文学复审预设
  assert.ok(conf.stylistConfig);
  assert.equal(conf.stylistConfig.concurrency, 4);
  assert.equal(conf.stylistConfig.smartConcurrency, true);
  assert.equal(conf.stylistConfig.concurrencyMax, 8);

  // 阶段三终审仲裁预设
  assert.ok(conf.arbiterConfig);
  assert.equal(conf.arbiterConfig.concurrency, 2);
  assert.equal(conf.arbiterConfig.smartConcurrency, false);
  assert.equal(conf.arbiterConfig.concurrencyMax, 3);
});

test("级联流水线：all 模式解析为级联，且必须真的配了阶段二才级联", () => {
  // 客户端契约：stage="all" 是「初审 → 复审 → 仲裁」一次提交，targetStage 归一为 all。
  assert.equal(cleanConfig({ stage: "all" }).targetStage, "all");
  assert.equal(cleanConfig({ targetStage: "all" }).targetStage, "all");
  assert.equal(cleanConfig({ stage: "stage1" }).targetStage, "stage1");
  assert.equal(cleanConfig({ stage: "stage2" }).targetStage, "stage2");
  assert.equal(cleanConfig({ stage: "stage3" }).targetStage, "stage3");

  const stylist = { provider: "compatible", model: "gemini-3.8-flash" };
  // 配了阶段二才级联：否则 runStage2Stylist 会回落主配置，等于背着用户多跑一轮复审。
  assert.equal(shouldCascadeStages(cleanConfig({ stage: "all", stylistConfig: stylist })), true);
  assert.equal(shouldCascadeStages(cleanConfig({ stage: "all" })), false);
  assert.equal(shouldCascadeStages(cleanConfig({ stage: "all", singleModelPersona: true })), true);
  // 非 all 模式永远不级联，哪怕配了阶段二。
  assert.equal(shouldCascadeStages(cleanConfig({ stage: "stage1", stylistConfig: stylist })), false);
  assert.equal(shouldCascadeStages(cleanConfig({ stage: "stage2", stylistConfig: stylist })), false);
});

test("级联流水线：状态接口如实回报本次任务的起步阶段，供刷新后恢复按钮态", () => {
  // 空闲时默认按阶段一回报：客户端据此知道当前没有级联任务在跑。
  assert.equal(clientStatus({ includeResults: false }).stageMode, "stage1");
});

test("级联流水线：all 模式下初审提改行立即移交复审，不等阶段一整体跑完", async () => {
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
      provider: "compatible",
      baseUrl,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 2,
      stage: "all",
      stylistConfig: { provider: "compatible", baseUrl, model: "stylist-model" },
      arbiterEnabled: false,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.stageMode, "all", "状态接口应回报本次是 all 级联任务");
    assert.equal(finished.errors, 0);
    assert.equal(stylistRequests, totalRows, "每一行初审提改都要进入复审");
    assert.ok(stylistFirstSeenAtStage1Completed !== null, "复审请求必须真的发生");
    assert.ok(
      stylistFirstSeenAtStage1Completed < totalRows,
      `复审必须在阶段一整体跑完之前就开始（实际在第 ${stylistFirstSeenAtStage1Completed} 行初审完成后）`,
    );
    assert.ok(
      finished.logs.some((log) => log.includes("级联流水线：阶段一初审完一行立即移交阶段二文学复审")),
      "日志应说明本次走的是级联流水线",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("多阶段看板与预设联动：阶段卡片活跃信息展示各阶段独立并发指标", () => {
  const tools = createPresetTools();
  const storage = {
    data: new Map([
      [
        "translation-compare-ai-presets-v1",
        JSON.stringify([
          { id: "p1", name: "Gemini初审", provider: "compatible", model: "gemini-flash", concurrency: 4, smartConcurrency: true, concurrencyMax: 8 },
          { id: "p2", name: "Claude仲裁", provider: "claude", model: "claude-opus", concurrency: 2, smartConcurrency: true, concurrencyMax: 3 },
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
  const options = s2Preset.children || [];
  const geminiOpt = options.find((o) => o.textContent === "Gemini初审");
  assert.ok(geminiOpt);
  assert.match(geminiOpt.title, /4~8智能并发/);

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
      smartConcurrency: true,
      currentConcurrency: 3,
      concurrencyMax: 10,
      stagePipelines: {
        stage1: { inFlight: 3, pending: 50, concurrency: 3, concurrencyMax: 10, smartConcurrency: true, activeRows: [1, 2, 3] },
        stage2: { inFlight: 4, pending: 10, concurrency: 4, concurrencyMax: 8, smartConcurrency: true, activeRows: [4, 5, 6, 7] },
        stage3: { inFlight: 2, pending: 2, concurrency: 2, concurrencyMax: 3, smartConcurrency: true, activeRows: [8, 9] },
      },
      results: [],
    });
  `);

  const activeText1 = ui.element("stage1ActiveRowsText").textContent;
  const activeText2 = ui.element("stage2ActiveRowsText").textContent;
  const activeText3 = ui.element("stage3ActiveRowsText").textContent;

  assert.match(activeText1, /1, 2, 3/);
  assert.match(activeText1, /并发 3\/10/);

  assert.match(activeText2, /4, 5, 6\.\.\./);
  assert.match(activeText2, /并发 4\/8/);

  assert.match(activeText3, /8, 9/);
  assert.match(activeText3, /并发 2\/3/);
});
