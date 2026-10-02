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
