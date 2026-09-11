const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  buildApiUrl,
  buildProviderHeaders,
  buildChatCompletionBody,
  buildClaudeMessageBody,
  cleanJsonPayload,
} = require("../src/ai/llm-client");
const { TaskQueue } = require("../src/ai/task-queue");
const {
  validateSpeakerOutput,
  normalizeStatus,
  makeCacheKey,
  inferSpeakerBatch,
} = require("../src/workbenches/speaker-attribution/ai/speaker-inference");
const { clientRowsFor } = require("../src/workbenches/speaker-attribution/build-workbench");

test("共享 LLM 传输层：buildApiUrl 处理各类 endpoint 与 /v1 前缀", () => {
  assert.equal(buildApiUrl("https://api.openai.com/v1", "/v1/chat/completions"), "https://api.openai.com/v1/chat/completions");
  assert.equal(buildApiUrl("https://api.openai.com", "/v1/chat/completions"), "https://api.openai.com/v1/chat/completions");
  assert.equal(buildApiUrl("http://localhost:11434/v1", "/v1/chat/completions"), "http://localhost:11434/v1/chat/completions");
  assert.equal(buildApiUrl("https://api.anthropic.com", "/v1/messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(buildApiUrl("https://api.anthropic.com/v1", "/v1/messages"), "https://api.anthropic.com/v1/messages");
});

test("共享 LLM 传输层：buildProviderHeaders 与 cleanJsonPayload", () => {
  const claudeHeaders = buildProviderHeaders({ provider: "claude", apiKey: "sk-ant-test" });
  assert.equal(claudeHeaders["x-api-key"], "sk-ant-test");
  assert.equal(claudeHeaders["anthropic-version"], "2023-06-01");

  const openaiHeaders = buildProviderHeaders({ provider: "compatible", apiKey: "sk-test" });
  assert.equal(openaiHeaders.authorization, "Bearer sk-test");

  // 代码块 JSON 清洗
  const parsed1 = cleanJsonPayload('```json\n{"speaker": "山田太郎", "confidence": 0.95}\n```');
  assert.deepEqual(parsed1, { speaker: "山田太郎", confidence: 0.95 });

  // 裸文本 JSON
  const parsed2 = cleanJsonPayload('前后有废话 {"speaker": "佐藤花子", "status": "confirmed"} 结尾也有');
  assert.deepEqual(parsed2, { speaker: "佐藤花子", status: "confirmed" });
});

test("非推理模型文本化强度档位映射：low 到 max 正确映射温度并向下兼容数值", () => {
  const { buildChatCompletionBody } = require("../src/ai/llm-client");
  const bodyLow = buildChatCompletionBody([], { model: "qwen2.5:14b-instruct", reasoningEffort: "low" });
  assert.equal(bodyLow.temperature, 0.2);

  const bodyMedium = buildChatCompletionBody([], { model: "qwen2.5:14b-instruct", reasoningEffort: "medium" });
  assert.equal(bodyMedium.temperature, 0.5);

  const bodyHigh = buildChatCompletionBody([], { model: "qwen2.5:14b-instruct", reasoningEffort: "high" });
  assert.equal(bodyHigh.temperature, 0.7);

  const bodyXHigh = buildChatCompletionBody([], { model: "qwen2.5:14b-instruct", reasoningEffort: "xhigh" });
  assert.equal(bodyXHigh.temperature, 0.85);

  const bodyUltra = buildChatCompletionBody([], { model: "qwen2.5:14b-instruct", reasoningEffort: "ultra" });
  assert.equal(bodyUltra.temperature, 0.95);

  const bodyMax = buildChatCompletionBody([], { model: "qwen2.5:14b-instruct", reasoningEffort: "max" });
  assert.equal(bodyMax.temperature, 1.0);

  const bodyDefault = buildChatCompletionBody([], { model: "qwen2.5:14b-instruct", reasoningEffort: "" });
  assert.equal(bodyDefault.temperature, undefined);
});

test("共享 TaskQueue：控制有界并发与 AbortSignal 取消", async () => {
  const items = [1, 2, 3, 4, 5];
  let maxActive = 0;
  const progressList = [];

  const queue = new TaskQueue({
    concurrency: 2,
    onProgress: (p) => progressList.push(p.completed),
  });

  const results = await queue.runAll(items, async (item) => {
    return item * 10;
  });

  assert.deepEqual(results, [10, 20, 30, 40, 50]);
  assert.equal(progressList.length, 5);

  // 取消测试
  const controller = new AbortController();
  const cancelQueue = new TaskQueue({ concurrency: 1, signal: controller.signal });
  controller.abort();
  const cancelResults = await cancelQueue.runAll([1, 2], async (x) => x);
  assert.equal(cancelResults.filter(Boolean).length, 0);
});

test("说话人推断：validateSpeakerOutput 规范化校验与容错", () => {
  const valid = validateSpeakerOutput({
    speaker: "艾莉丝",
    status: "confirmed",
    confidence: 0.88,
    evidence: "说了「当麻」",
    needsContext: false,
  });
  assert.equal(valid.speaker, "艾莉丝");
  assert.equal(valid.status, "confirmed");
  assert.equal(valid.confidence, 0.88);
  assert.equal(valid.needsContext, false);

  // 缺少字段与非法状态
  const fallback = validateSpeakerOutput({
    speaker: "",
    status: "invalid-status",
    needsContext: true,
  });
  assert.equal(fallback.speaker, "");
  assert.equal(fallback.status, "needs-review");
  assert.equal(fallback.needsContext, true);

  // 非对象输入
  const errorFallback = validateSpeakerOutput(null);
  assert.equal(errorFallback.status, "needs-review");
  assert.equal(errorFallback.needsContext, true);
});

test("说话人推断：缓存键稳定性与批量推断挂载", async () => {
  const row = {
    index: 1,
    sourceText: "「ふん」",
    parallelText: "“哼。”",
    attention: {
      version: "evidence-attention-v2",
      score: 0.8,
      level: "high",
      candidates: [{ name: "佐藤花子", score: 0.9 }],
      focus: [],
      needsMoreContext: false,
    },
  };

  const key1 = makeCacheKey(row, { version: "v1" }, "gpt-4");
  const key2 = makeCacheKey(row, { version: "v1" }, "gpt-4");
  assert.equal(key1, key2);

  const key3 = makeCacheKey(row, { version: "v1" }, "claude-3");
  assert.notEqual(key1, key3);

  // clientRowsFor 透传 prediction
  row.prediction = {
    speaker: "佐藤花子",
    status: "confirmed",
    confidence: 0.9,
    evidence: "「ふん」傲娇语气与邻近动作",
    needsContext: false,
  };

  const clientRows = clientRowsFor({ rows: [row] });
  assert.equal(clientRows.length, 1);
  assert.equal(clientRows[0].prediction.speaker, "佐藤花子");
  assert.equal(clientRows[0].prediction.confidence, 0.9);
});

test("说话人归属 Prompt 契约：单语与双语模式模块化适配与输出校验", () => {
  const {
    speakerPromptFor,
    buildSpeakerSystemPrompt,
    speakerOutputSchema,
    validateSpeakerOutput,
  } = require("../src/workbenches/speaker-attribution/ai/speaker-contract");
  const { buildSpeakerPrompt } = require("../src/workbenches/speaker-attribution/attention");

  const monolingualPrompt = speakerPromptFor("monolingual");
  const bilingualPrompt = speakerPromptFor("bilingual");

  assert.notEqual(monolingualPrompt.system, bilingualPrompt.system);
  assert.match(monolingualPrompt.system, /当前是单语发话推断/);
  assert.doesNotMatch(monolingualPrompt.system, /双语输入/);
  assert.match(bilingualPrompt.system, /当前是双语对照推断/);
  assert.match(bilingualPrompt.system, /双语输入中，原文与主文本只是同一发话的两种表达/);

  // 默认根据 parallelText 自动判别模式
  const monoRow = { index: 1, sourceText: "「……」" };
  const monoBuilt = buildSpeakerPrompt(monoRow);
  assert.equal(monoBuilt.mode, "monolingual");
  assert.match(monoBuilt.system, /当前是单语发话推断/);
  const monoUser = JSON.parse(monoBuilt.user);
  assert.equal(monoUser.target.parallelText, undefined);
  assert.equal(monoUser.alignment, undefined);

  const biRow = { index: 2, sourceText: "「待ちなさい」", parallelText: "“等等”" };
  const biBuilt = buildSpeakerPrompt(biRow);
  assert.equal(biBuilt.mode, "bilingual");
  assert.match(biBuilt.system, /当前是双语对照推断/);
  const biUser = JSON.parse(biBuilt.user);
  assert.equal(biUser.target.parallelText, "“等等”");
  assert.ok(biUser.alignment);

  // 自定义系统提示词注入
  const custom = buildSpeakerSystemPrompt({ mode: "monolingual", customSystem: "自定义规则" });
  assert.match(custom, /自定义规则/);
  assert.match(custom, /当前是单语发话推断/);
  assert.match(custom, /只返回一个 JSON 对象/);

  // 输出契约校验：非 confirmed 强制清空 speaker，并补充默认 evidence
  const unconfirmed = validateSpeakerOutput({
    speaker: "佐藤花子",
    status: "unknown",
  });
  assert.equal(unconfirmed.speaker, "");
  assert.equal(unconfirmed.status, "unknown");
  assert.ok(unconfirmed.evidence.length > 0);
});
