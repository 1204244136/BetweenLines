const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  validateSpeakerOutput,
  normalizeStatus,
  makeCacheKey,
  inferSpeakerBatch,
} = require("../src/workbenches/speaker-attribution/ai/speaker-inference");
const { clientRowsFor } = require("../src/workbenches/speaker-attribution/build-workbench");
const { buildSpeakerPromptMessages } = require("../src/workbenches/speaker-attribution/ai/speaker-contract");

test("说话人客户端 AI 停止/重启使用运行号隔离旧任务", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "public", "speaker-workbench-client.js"),
    "utf8",
  );
  assert.match(source, /let aiActiveRunId = 0/);
  assert.match(source, /const isCurrentRun = \(\) => aiActiveRunId === runId/);
  assert.doesNotMatch(source, /signal: aiAbortController\?\.signal/);
  assert.match(source, /if \(!isCurrentRun\(\)\) return;/);
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
