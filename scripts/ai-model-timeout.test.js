const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { callModel } = require("./ai-proofread");
const {
  MODEL_RESPONSE_TIMEOUT_MS,
  diagnoseConnectivityError,
  fetchJson,
} = require("../src/ai/llm-client");
const { classifyAiError } = require("../src/workbenches/translation-compare/ai/error-kinds");

test("翻译模型调用：compatible 与 Claude 都使用完整生成响应预算", async (t) => {
  assert.equal(MODEL_RESPONSE_TIMEOUT_MS, 300000);
  for (const protocol of ["compatible", "claude"]) {
    await t.test(protocol, async () => {
      const originalFetch = global.fetch;
      const originalSetTimeout = global.setTimeout;
      const deadlines = [];
      const requests = [];
      global.setTimeout = (callback, delay, ...args) => {
        deadlines.push(delay);
        return originalSetTimeout(callback, delay, ...args);
      };
      global.fetch = async (url, options) => {
        requests.push({ url, options });
        const body = protocol === "claude"
          ? { content: [{ type: "text", text: "校对完成" }] }
          : { choices: [{ message: { content: "校对完成" } }] };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      };

      try {
        const content = await callModel([{ role: "user", content: "校对测试" }], {
          protocol,
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "timeout-test-model",
        });
        assert.equal(content, "校对完成");
        assert.deepEqual(deadlines, [MODEL_RESPONSE_TIMEOUT_MS], "生成请求不能继续使用通用 90 秒预算");
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, protocol === "claude"
          ? "http://127.0.0.1:11434/v1/messages"
          : "http://127.0.0.1:11434/v1/chat/completions");
        assert.equal(requests[0].options.signal.aborted, false);
      } finally {
        global.fetch = originalFetch;
        global.setTimeout = originalSetTimeout;
      }
    });
  }
});

test("HTTP 错误正文读不完：保留已收到的状态，分类与诊断不误报本地超时", async (t) => {
  for (const status of [500, 429, 503]) {
    await t.test(`HTTP ${status}`, async () => {
      const server = http.createServer((request, response) => {
        request.resume();
        response.writeHead(status, { "content-type": "application/json" });
        response.flushHeaders();
        // 网关已明确拒绝请求，随后错误正文挂起；不能用正文读取超时覆盖 HTTP 状态。
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        await assert.rejects(
          () => fetchJson(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
            method: "POST",
            body: "{}",
          }, { timeoutMs: 1000 }),
          (error) => {
            assert.equal(error.code, "HTTP_ERROR");
            assert.equal(error.httpStatus, status);
            assert.equal(classifyAiError(error), status === 500 ? "server_error" : "rate_limit");
            assert.doesNotMatch(error.message, /超时/);
            if (status === 500) {
              assert.equal(classifyAiError(error.message), "server_error", "客户端只有备注文字时仍应归为服务端错误");
              const diagnosis = diagnoseConnectivityError(error);
              assert.equal(diagnosis.code, "SERVER_ERROR");
              assert.equal(diagnosis.httpStatus, 500);
              assert.doesNotMatch(diagnosis.message, /超时/);
            }
            return true;
          },
        );
      } finally {
        server.closeAllConnections?.();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  }
});

test("网关账号风控：保留 HTTP 证据并区别于可退避的限流", async (t) => {
  const cases = [
    { name: "实际网关错误", status: 429, error: { message: "上游风控已限制本区域账号（403 / code 11140，账号存在异常行为）。网关暂时无法处理请求。" }, restricted: true },
    { name: "结构化账号错误码", status: 429, error: { code: "ACCOUNT_RESTRICTED", message: "Account access is restricted." }, restricted: true },
    { name: "结构化 11140 与账号限制", status: 429, error: { code: 11140, message: "账号存在异常行为，访问已受限。" }, restricted: true },
    { name: "普通频控", status: 429, error: { message: "Too many requests. Try again in 15 seconds." } },
    { name: "服务过载", status: 503, error: { message: "Service overloaded" } },
    { name: "另一种服务过载", status: 529, error: { message: "Temporarily overloaded" } },
    { name: "正文仅提及 403", status: 429, error: { message: "Rate limit after response 403, retry later." } },
    { name: "无账号语义的业务码", status: 429, error: { code: 11140, message: "Too many requests" } },
    { name: "请求编号巧合相同", status: 429, error: { message: "账号请求过多，请稍后重试。Request id 11140." } },
    { name: "非错误字段中的巧合内容", status: 429, body: { prompt: "code 11140，账号存在异常行为", error: { message: "Too many requests" } } },
  ];
  const calls = [];
  const server = http.createServer((request, response) => {
    request.resume();
    const scenario = cases[Number(request.url.slice(1))];
    calls.push(scenario.name);
    response.writeHead(scenario.status, { "content-type": "application/json", "retry-after": "15" });
    response.end(JSON.stringify(scenario.body || { error: scenario.error }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [index, scenario] of cases.entries()) {
      await t.test(scenario.name, async () => {
        await assert.rejects(
          () => fetchJson(`http://127.0.0.1:${server.address().port}/${index}`, { method: "POST", body: "{}" }),
          (error) => {
            assert.equal(error.code, scenario.restricted ? "ACCOUNT_RESTRICTED" : "HTTP_ERROR");
            assert.equal(error.httpStatus, scenario.status);
            assert.equal(error.responseBody, JSON.stringify(scenario.body || { error: scenario.error }));
            assert.equal(error.retryAfter, "15");
            assert.equal(error.receivedHeaders, true);
            assert.equal(classifyAiError(error), scenario.restricted ? "auth" : "rate_limit");
            if (scenario.restricted) {
              assert.match(error.message, /账号访问受限/);
              assert.equal(classifyAiError(error.message), "auth", "备注只保留文字也必须识别账号限制");
              assert.equal(diagnoseConnectivityError(error).code, "ACCOUNT_RESTRICTED");
              assert.match(diagnoseConnectivityError(error).message, /账号/);
            }
            return true;
          },
        );
      });
    }
    assert.equal(calls.length, cases.length, "账号访问限制与 HTTP 错误均不得进入响应流中断重试");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
