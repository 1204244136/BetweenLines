const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeTokenUsage } = require("../src/ai/token-usage");
const { testModelConnectivity } = require("../src/ai/llm-client");
const { callModel, clearProofreadCache, clientStatus } = require("./ai-proofread");

test("缓存用量：OpenAI 与 Responses 字段复用完整输入总量，不重复加缓存", () => {
  for (const raw of [
    { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 75 } },
    { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 75 } },
  ]) {
    assert.deepEqual(normalizeTokenUsage(raw), {
      promptTokens: 100, completionTokens: 20, totalTokens: 120,
      cachedPromptTokens: 75, cacheMissPromptTokens: 25, cacheWritePromptTokens: 0,
      cacheReportedPromptTokens: 100, cacheReportedCalls: 1,
    });
  }
});

test("缓存用量：DeepSeek hit/miss 优先于兼容字段，支持独立恢复完整输入", () => {
  const expected = {
    promptTokens: 100, completionTokens: 20, totalTokens: 120,
    cachedPromptTokens: 70, cacheMissPromptTokens: 30, cacheWritePromptTokens: 0,
    cacheReportedPromptTokens: 100, cacheReportedCalls: 1,
  };
  assert.deepEqual(normalizeTokenUsage({
    prompt_tokens: 100, completion_tokens: 20,
    prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30,
    prompt_tokens_details: { cached_tokens: 60 },
  }), expected);
  assert.deepEqual(normalizeTokenUsage({
    completion_tokens: 20, prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30,
  }), expected);
  assert.deepEqual(normalizeTokenUsage({
    prompt_tokens: 100, completion_tokens: 20, prompt_cache_miss_tokens: 30,
    prompt_tokens_details: { cached_tokens: 60 },
  }), expected);
});

test("缓存用量：Claude 普通输入、缓存读取和缓存创建相加且只计算一次", () => {
  assert.deepEqual(normalizeTokenUsage({
    input_tokens: 10, output_tokens: 5,
    cache_read_input_tokens: 80, cache_creation_input_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 20 },
  }, "claude"), {
    promptTokens: 110, completionTokens: 5, totalTokens: 115,
    cachedPromptTokens: 80, cacheMissPromptTokens: 30, cacheWritePromptTokens: 20,
    cacheReportedPromptTokens: 110, cacheReportedCalls: 1,
  });
});

test("缓存用量：未知与明确零命中可区分，残缺或非法数据不伪造命中率", () => {
  for (const raw of [
    {}, null,
    { prompt_tokens: 100 },
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: null } },
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: "" } },
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: Infinity } },
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: [] } },
    { prompt_cache_hit_tokens: 80 },
    { prompt_tokens: 100, prompt_cache_hit_tokens: 200 },
    { prompt_tokens: 100, prompt_cache_miss_tokens: 200 },
    { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 30 },
    { prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: -1 },
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 200 } },
  ]) {
    const usage = normalizeTokenUsage(raw);
    assert.equal(usage.cacheReportedCalls, 0);
    assert.equal(usage.cacheReportedPromptTokens, 0);
    assert.equal(usage.cachedPromptTokens, 0);
    assert.ok(Object.values(usage).every((value) => Number.isFinite(value) && value >= 0));
  }
  const zero = normalizeTokenUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } });
  assert.equal(zero.cacheReportedCalls, 1);
  assert.equal(zero.cacheReportedPromptTokens, 100);
  assert.equal(zero.cachedPromptTokens, 0);
  assert.equal(zero.cacheMissPromptTokens, 100);
});

test("缓存用量：Claude 缓存字段不完整或非法时仅保留已知输入，不累计部分缓存明细", () => {
  for (const raw of [
    { input_tokens: 100, cache_creation_input_tokens: 1000 },
    { input_tokens: 100, cache_read_input_tokens: -1, cache_creation_input_tokens: 1000 },
    { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: -1 },
    { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: null },
    { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: Infinity },
  ]) {
    const usage = normalizeTokenUsage(raw, "claude");
    assert.equal(usage.cacheReportedCalls, 0);
    assert.equal(usage.cacheReportedPromptTokens, 0);
    assert.equal(usage.cachedPromptTokens, 0);
    assert.equal(usage.cacheMissPromptTokens, 0);
    assert.equal(usage.cacheWritePromptTokens, 0);
    assert.ok(usage.promptTokens >= 100, "总输入仍须保留有效的普通输入及已知缓存输入");
  }
  assert.equal(normalizeTokenUsage({ input_tokens: 100, cache_creation_input_tokens: 1000 }, "claude").promptTokens, 1100);
});

test("模型调用：混合协议只用已报告调用计算命中率，清除运行记录同步清空用量", async () => {
  const originalFetch = global.fetch;
  const payloads = [
    { protocol: "compatible", usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } } },
    { protocol: "claude", usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 } },
    { protocol: "compatible", usage: { prompt_tokens: 1000 } },
    { protocol: "compatible", usage: { prompt_tokens: 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20 } },
    { protocol: "claude", usage: { input_tokens: 100, cache_creation_input_tokens: 1000 } },
    { protocol: "compatible", usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 200 } },
  ];
  clearProofreadCache({ clearPersisted: false });
  try {
    for (const payload of payloads) {
      global.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: "完成" } }],
        content: [{ type: "text", text: "完成" }],
        usage: payload.usage,
      }), { headers: { "content-type": "application/json" } });
      assert.equal(await callModel([{ role: "user", content: "本地测试" }], {
        protocol: payload.protocol, baseUrl: "http://127.0.0.1:11434", model: "usage-test",
      }), "完成");
    }
    const metrics = clientStatus({ includeTermTables: false }).metrics;
    assert.equal(metrics.modelCalls, 6);
    assert.equal(metrics.promptTokens, 2400);
    assert.equal(metrics.totalTokens, 2420);
    assert.equal(metrics.cachedPromptTokens, 110);
    assert.equal(metrics.cacheMissPromptTokens, 90);
    assert.equal(metrics.cacheWritePromptTokens, 20);
    assert.equal(metrics.cacheReportedPromptTokens, 200);
    assert.equal(metrics.cacheReportedCalls, 3);
    clearProofreadCache({ clearPersisted: false });
    const cleared = clientStatus({ includeTermTables: false }).metrics;
    assert.ok(Object.values(cleared).every((value) => value === 0));
  } finally {
    global.fetch = originalFetch;
    clearProofreadCache({ clearPersisted: false });
  }
});

test("连通性测试：两种协议保留缓存明细并使用共享的输入计数口径", async () => {
  const originalFetch = global.fetch;
  try {
    for (const protocol of ["compatible", "claude"]) {
      global.fetch = async () => new Response(JSON.stringify({
        choices: [{ message: { content: "Hi" } }], content: [{ type: "text", text: "Hi" }],
        usage: protocol === "claude"
          ? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 }
          : { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
      }), { headers: { "content-type": "application/json" } });
      const result = await testModelConnectivity({ protocol, baseUrl: "http://127.0.0.1:11434", model: "usage-test" });
      assert.equal(result.ok, true);
      assert.equal(result.usage.promptTokens, 100);
      assert.equal(result.usage.cachedPromptTokens, 80);
      assert.equal(result.usage.cacheMissPromptTokens, 20);
      assert.equal(result.usage.cacheReportedCalls, 1);
      assert.equal(result.usage.cacheReportedPromptTokens, 100);
    }
  } finally {
    global.fetch = originalFetch;
  }
});
