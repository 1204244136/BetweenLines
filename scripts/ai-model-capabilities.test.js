const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  ALL_THINKING_LEVELS,
  detectModelCapabilities,
  isReasoningModel,
  normalizeModelReasoningEffort,
} = require("../src/workbenches/translation-compare/ai/model-capabilities");

const {
  buildChatCompletionBody,
  buildClaudeMessageBody,
  listModels,
} = require("./ai-proofread");

// 传入空的 models.dev 数据 → 强制走 manifest / 启发式 / 保守默认，保证测试确定性
function caps(model, provider = "") {
  return detectModelCapabilities(model, provider, {});
}

test("思考档位全集与 pi-ai 词汇表对齐", () => {
  assert.deepEqual(ALL_THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("manifest 命中：kimi-k3 只支持 max 档且不支持 temperature", () => {
  const c = caps("kimi-k3");
  assert.equal(c.reasoning, true);
  assert.deepEqual(c.reasoningEfforts, ["max"]);
  assert.equal(c.supportsTemperature, false);
  assert.equal(c.source, "manifest");
});

test("manifest 命中：deepseek-reasoner 支持 high/max 档", () => {
  const c = caps("deepseek-reasoner");
  assert.equal(c.reasoning, true);
  assert.deepEqual(c.reasoningEfforts, ["high", "max"]);
  assert.equal(c.supportsTemperature, false);
  assert.equal(c.source, "manifest");
});

test("manifest 命中：o3-mini 支持 low/medium/high 且不支持 temperature", () => {
  const c = caps("o3-mini");
  assert.equal(c.reasoning, true);
  assert.deepEqual(c.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(c.supportsTemperature, false);
  assert.equal(c.source, "manifest");
});

test("启发式：带提供方前缀的 o 系列变体走启发式规则", () => {
  const c = caps("openai/o1-mini");
  assert.equal(c.reasoning, true);
  assert.deepEqual(c.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(c.supportsTemperature, false);
  assert.equal(c.source, "heuristic");
});

test("启发式：deepseek-r1 与 QwQ 命中推理规则", () => {
  assert.equal(caps("deepseek-r1-distill-qwen-32b").reasoning, true);
  const qwq = caps("Qwen/QwQ-32B");
  assert.equal(qwq.reasoning, true);
  assert.deepEqual(qwq.reasoningEfforts, ["low", "medium", "high", "xhigh"]);
});

test("启发式：名字含 thinking/reasoner 的模型视为推理模型", () => {
  assert.equal(caps("qwen3-32b-thinking").reasoning, true);
  assert.equal(caps("glm-4-reasoner").reasoning, true);
});

test("保守默认：普通非推理模型走 temperature", () => {
  const c = caps("qwen2.5:14b-instruct");
  assert.equal(c.reasoning, false);
  assert.deepEqual(c.reasoningEfforts, []);
  assert.equal(c.supportsTemperature, true);
  assert.equal(c.source, "default");
  assert.equal(isReasoningModel("qwen2.5:14b-instruct", c), false);
});

test("manifest 命中不受模型名前缀/日期后缀影响", () => {
  const c = caps("kimi-k3-20260101");
  assert.equal(c.source, "manifest");
  assert.deepEqual(c.reasoningEfforts, ["max"]);
});

test("normalizeModelReasoningEffort 只接受该模型声明的档位", () => {
  const kimi = caps("kimi-k3");
  assert.equal(normalizeModelReasoningEffort("max", "kimi-k3", kimi), "max");
  assert.equal(normalizeModelReasoningEffort("high", "kimi-k3", kimi), "");
  assert.equal(normalizeModelReasoningEffort("0.8", "kimi-k3", kimi), "");

  const deepseek = caps("deepseek-reasoner");
  assert.equal(normalizeModelReasoningEffort("HIGH", "deepseek-reasoner", deepseek), "high");
  assert.equal(normalizeModelReasoningEffort("low", "deepseek-reasoner", deepseek), "");
});

test("推理模型请求携带 reasoning_effort 且不带 temperature", () => {
  const body = buildChatCompletionBody([{ role: "user", content: "proofread" }], {
    model: "deepseek-reasoner",
    reasoningEffort: "high",
  });
  assert.deepEqual(body, {
    model: "deepseek-reasoner",
    messages: [{ role: "user", content: "proofread" }],
    stream: false,
    reasoning_effort: "high",
  });
});

test("推理模型不支持 temperature：即使传入数值也不发送", () => {
  const body = buildChatCompletionBody([], {
    model: "deepseek-reasoner",
    reasoningEffort: "0.8",
  });
  assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(body, "temperature"), false);
});

test("模型不支持的思考档位不会写入请求", () => {
  const body = buildChatCompletionBody([], {
    model: "kimi-k3",
    reasoningEffort: "high",
  });
  assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(body, "temperature"), false);
});

test("非推理模型仍使用 temperature 采样", () => {
  const body = buildChatCompletionBody([], {
    model: "qwen2.5:14b-instruct",
    reasoningEffort: "0.8",
  });
  assert.deepEqual(body, {
    model: "qwen2.5:14b-instruct",
    messages: [],
    stream: false,
    temperature: 0.8,
  });
});

test("Claude 思考模型按档位映射 thinking budget", () => {
  const messages = [
    { role: "system", content: "proofread carefully" },
    { role: "user", content: "text" },
  ];
  const body = buildClaudeMessageBody(messages, {
    model: "claude-sonnet-5",
    reasoningEffort: "high",
  });
  assert.equal(body.thinking.type, "enabled");
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 8192 });
  assert.equal(body.max_tokens, 12288);
  assert.equal(Object.hasOwn(body, "temperature"), false);
});

test("Claude 非 thinking 请求保持 temperature 行为", () => {
  const messages = [
    { role: "system", content: "proofread carefully" },
    { role: "user", content: "text" },
  ];
  const body = buildClaudeMessageBody(messages, {
    model: "claude-sonnet-5",
    reasoningEffort: "0.2",
  });
  assert.equal(Object.hasOwn(body, "thinking"), false);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 4096);
});

test("模型列表发现会富化推理能力与思考档位", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      data: [
        { id: "kimi-k3" },
        { id: "qwen2.5:14b-instruct" },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const result = await listModels({
      protocol: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
    });

    const kimi = result.models.find((model) => model.id === "kimi-k3");
    const qwen = result.models.find((model) => model.id === "qwen2.5:14b-instruct");
    assert.equal(kimi.reasoning, true);
    assert.equal(Array.isArray(kimi.reasoningEfforts), true);
    assert.equal(qwen.reasoning, false);
    assert.equal(qwen.supportsTemperature, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
