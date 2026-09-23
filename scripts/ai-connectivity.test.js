const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const {
  testModelConnectivity,
  diagnoseConnectivityError,
  assertSafeOutboundUrl,
  buildApiUrl,
  buildProviderHeaders,
  buildChatCompletionBody,
  cleanJsonPayload,
  fetchJson,
} = require("../src/ai/llm-client");
const { TaskQueue } = require("../src/ai/task-queue");
const { testModel } = require("../src/workbenches/translation-compare/ai/ai-proofread");
const { createServer, host } = require("../src/runtime/input-server");
const { createWorkbench, toastMessages } = require("./workbench-fixture");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function apiToken(port) {
  const response = await fetch(`http://${host}:${port}/`);
  const html = await response.text();
  const match = html.match(/<meta\s+name="transcomparator-session-token"\s+content="([^"]+)">/i);
  assert.ok(match, "setup page should contain an injected API session token");
  return match[1];
}

test("testModelConnectivity: 针对 OpenAI 兼容协议正常响应返回连通成功", async () => {
  let receivedBody = null;
  let receivedHeaders = null;
  const mockServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      receivedHeaders = req.headers;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "Hello there!" } }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await listen(mockServer);
  try {
    const result = await testModelConnectivity({
      provider: "compatible",
      baseUrl: `http://${host}:${port}/v1`,
      apiKey: "sk-mock-key",
      model: "qwen2.5:7b",
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, "compatible");
    assert.equal(result.model, "qwen2.5:7b");
    assert.ok(result.latencyMs >= 0);
    assert.equal(result.replyPreview, "Hello there!");
    assert.deepEqual(result.usage, {
      promptTokens: 8,
      completionTokens: 3,
      totalTokens: 11,
    });
    assert.match(result.message, /模型连通成功/);

    // 验证请求体符合业内惯例：轻量测试问候、极小 token
    assert.equal(receivedHeaders.authorization, "Bearer sk-mock-key");
    assert.deepEqual(receivedBody.messages, [{ role: "user", content: "Hi" }]);
    assert.equal(receivedBody.stream, false);
    assert.equal(receivedBody.max_tokens, 5);
  } finally {
    await close(mockServer);
  }
});

test("testModelConnectivity: 针对 Claude 原生 Messages 协议返回连通成功", async () => {
  let receivedBody = null;
  let receivedHeaders = null;
  const mockServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/messages") {
      receivedHeaders = req.headers;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        content: [{ type: "text", text: "Hi! How can I help?" }],
        usage: { input_tokens: 6, output_tokens: 5 },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await listen(mockServer);
  try {
    const result = await testModelConnectivity({
      provider: "claude",
      baseUrl: `http://${host}:${port}`,
      apiKey: "sk-ant-test-key",
      model: "claude-3-5-sonnet",
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, "claude");
    assert.equal(result.model, "claude-3-5-sonnet");
    assert.ok(result.latencyMs >= 0);
    assert.equal(result.replyPreview, "Hi! How can I help?");
    assert.deepEqual(result.usage, {
      promptTokens: 6,
      completionTokens: 5,
      totalTokens: 11,
    });
    assert.equal(receivedHeaders["x-api-key"], "sk-ant-test-key");
    assert.equal(receivedHeaders["anthropic-version"], "2023-06-01");
    assert.equal(receivedBody.max_tokens, 5);
    assert.deepEqual(receivedBody.messages, [{ role: "user", content: "Hi" }]);
  } finally {
    await close(mockServer);
  }
});

test("testModelConnectivity: 自适应处理推理模型 max_completion_tokens 降级重试", async () => {
  let callCount = 0;
  const mockServer = http.createServer(async (req, res) => {
    callCount += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    if (body.max_tokens && !body.max_completion_tokens) {
      // 模拟某些 OpenAI 兼容接口拒绝 max_tokens 并要求 max_completion_tokens
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." },
      }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: "OK" } }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }));
  });

  const port = await listen(mockServer);
  try {
    const result = await testModelConnectivity({
      provider: "compatible",
      baseUrl: `http://${host}:${port}/v1`,
      model: "my-custom-llm",
    });

    assert.equal(result.ok, true);
    assert.equal(callCount, 2, "应自适应重试并成功");
    assert.equal(result.replyPreview, "OK");
  } finally {
    await close(mockServer);
  }
});

test("testModelConnectivity: 参数校验与各种错误诊断诊断清晰", async () => {
  // 缺少 baseUrl
  const noBase = await testModelConnectivity({ baseUrl: "", model: "qwen" });
  assert.equal(noBase.ok, false);
  assert.equal(noBase.code, "MISSING_BASE_URL");

  // 缺少 model
  const noModel = await testModelConnectivity({ baseUrl: "http://127.0.0.1:11434/v1", model: "" });
  assert.equal(noModel.ok, false);
  assert.equal(noModel.code, "MISSING_MODEL");

  // HTTP 401 认证失败
  const diag401 = diagnoseConnectivityError(Object.assign(new Error("401"), { httpStatus: 401 }));
  assert.equal(diag401.code, "UNAUTHORIZED");
  assert.match(diag401.message, /API Key/);

  // HTTP 403 访问受限
  const diag403 = diagnoseConnectivityError(Object.assign(new Error("403"), { httpStatus: 403 }));
  assert.equal(diag403.code, "FORBIDDEN");
  assert.match(diag403.message, /受限/);

  // HTTP 404 模型或端点不存在
  const diag404 = diagnoseConnectivityError(Object.assign(new Error("404"), { httpStatus: 404 }), { model: "non-existent-model" });
  assert.equal(diag404.code, "NOT_FOUND");
  assert.match(diag404.message, /non-existent-model/);

  // HTTP 429 频控/额度超限
  const diag429 = diagnoseConnectivityError(Object.assign(new Error("429"), { httpStatus: 429 }));
  assert.equal(diag429.code, "RATE_LIMITED");
  assert.match(diag429.message, /频控|余额/);

  // HTTP 500 服务端异常
  const diag500 = diagnoseConnectivityError(Object.assign(new Error("500"), { httpStatus: 500 }));
  assert.equal(diag500.code, "SERVER_ERROR");
  assert.match(diag500.message, /服务端异常/);

  // 非 JSON 响应
  const diagHtml = diagnoseConnectivityError(Object.assign(new Error("HTML"), { code: "INVALID_JSON_RESPONSE" }));
  assert.equal(diagHtml.code, "INVALID_JSON_RESPONSE");
  assert.match(diagHtml.message, /非 JSON/);
});

test("testModelConnectivity: 遇到服务拒绝连接 (ECONNREFUSED) 时返回诊断信息", async () => {
  // 请求一个确定没有服务的端口
  const result = await testModelConnectivity({
    provider: "compatible",
    baseUrl: "http://127.0.0.1:49999/v1",
    model: "qwen",
    timeoutMs: 2000,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "CONNECTION_REFUSED");
  assert.match(result.error, /连接被拒绝/);
});

test("testModel: translation-compare 工作台封装正确清洗配置", async () => {
  const result = await testModel({
    model: "",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MISSING_MODEL");
});

test("API: /api/ai-proofread/test 和 /api/speaker-ai/test 正确响应测试请求", async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const token = await apiToken(port);

    // 缺少 model 返回 MISSING_MODEL
    const res1 = await fetch(`http://${host}:${port}/api/ai-proofread/test`, {
      method: "POST",
      headers: {
        "x-transcomparator-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "",
      }),
    });
    const data1 = await res1.json();
    assert.equal(res1.status, 200);
    assert.equal(data1.ok, false);
    assert.equal(data1.code, "MISSING_MODEL");

    // speaker-ai test 端点
    const res2 = await fetch(`http://${host}:${port}/api/speaker-ai/test`, {
      method: "POST",
      headers: {
        "x-transcomparator-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "",
      }),
    });
    const data2 = await res2.json();
    assert.equal(res2.status, 200);
    assert.equal(data2.ok, false);
    assert.equal(data2.code, "MISSING_MODEL");
  } finally {
    await close(server);
  }
});

test("UI: 工作台测试模型按钮触发连通性测试并弹出 Toast", async () => {
  const ui = createWorkbench(undefined, {
    apiResponses: {
      "/api/ai-proofread/test": {
        ok: true,
        model: "deepseek-chat",
        latencyMs: 180,
        replyPreview: "Pong!",
      },
    },
  });

  const testBtn = ui.element("aiTestModel");
  assert.ok(testBtn, "页面应包含 aiTestModel 测试按钮");

  ui.element("aiModel").value = "deepseek-chat";
  await testBtn.dispatch("click");

  const toasts = toastMessages(ui);
  assert.ok(toasts.some((msg) => msg.includes("模型连通成功") && msg.includes("180ms")), `Toast 应该包含连通成功提示，实际为：${JSON.stringify(toasts)}`);
});

test("UI: 工作台测试失败时弹出 error Toast 并提示失败原因", async () => {
  const ui = createWorkbench(undefined, {
    apiResponses: {
      "/api/ai-proofread/test": {
        ok: false,
        model: "deepseek-chat",
        latencyMs: 85,
        error: "认证失败（HTTP 401）：API Key 无效",
      },
    },
  });

  const testBtn = ui.element("aiTestModel");
  await testBtn.dispatch("click");

  const toasts = toastMessages(ui);
  assert.ok(toasts.some((msg) => msg.includes("模型连通失败") && msg.includes("HTTP 401")), `Toast 应该包含连通失败提示，实际为：${JSON.stringify(toasts)}`);
});

test("共享 LLM 传输层：buildApiUrl 处理各类 endpoint 与 /v1 前缀", () => {
  assert.equal(buildApiUrl("https://api.openai.com/v1", "/v1/chat/completions"), "https://api.openai.com/v1/chat/completions");
  assert.equal(buildApiUrl("https://api.openai.com", "/v1/chat/completions"), "https://api.openai.com/v1/chat/completions");
  assert.equal(buildApiUrl("http://localhost:11434/v1", "/v1/chat/completions"), "http://localhost:11434/v1/chat/completions");
  assert.equal(buildApiUrl("https://api.anthropic.com", "/v1/messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(buildApiUrl("https://api.anthropic.com/v1", "/v1/messages"), "https://api.anthropic.com/v1/messages");
});

test("共享 LLM 传输层：拒绝非 HTTP 与云元数据出站目标", async () => {
  await assert.rejects(
    () => assertSafeOutboundUrl("file:///etc/passwd"),
    /只支持 http/,
  );
  await assert.rejects(
    () => assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data"),
    /link-local/,
  );
  await assert.rejects(
    () => assertSafeOutboundUrl("http://metadata.google.internal/computeMetadata/v1"),
    /云元数据/,
  );
  await assert.doesNotReject(
    () => assertSafeOutboundUrl("http://127.0.0.1:11434/v1"),
  );
});

test("共享 LLM 传输层：不自动跟随可能转向内网的重定向", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await assert.rejects(
      () => fetchJson(`http://127.0.0.1:${address.port}/v1/models`, { method: "GET" }),
      /HTTP 302/,
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("共享 LLM 传输层：buildProviderHeaders 与 cleanJsonPayload", () => {
  const claudeHeaders = buildProviderHeaders({ provider: "claude", apiKey: "sk-ant-test" });
  assert.equal(claudeHeaders["x-api-key"], "sk-ant-test");
  assert.equal(claudeHeaders["anthropic-version"], "2023-06-01");

  const openaiHeaders = buildProviderHeaders({ provider: "compatible", apiKey: "sk-test" });
  assert.equal(openaiHeaders.authorization, "Bearer sk-test");

  const parsed1 = cleanJsonPayload('```json\n{"speaker": "山田太郎", "confidence": 0.95}\n```');
  assert.deepEqual(parsed1, { speaker: "山田太郎", confidence: 0.95 });

  const parsed2 = cleanJsonPayload('前后有废话 {"speaker": "佐藤花子", "status": "confirmed"} 结尾也有');
  assert.deepEqual(parsed2, { speaker: "佐藤花子", status: "confirmed" });
});

test("非推理模型文本化强度档位映射：low 到 max 正确映射温度并向下兼容数值", () => {
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

  const controller = new AbortController();
  const cancelQueue = new TaskQueue({ concurrency: 1, signal: controller.signal });
  controller.abort();
  const cancelResults = await cancelQueue.runAll([1, 2], async (x) => x);
  assert.equal(cancelResults.filter(Boolean).length, 0);
});
