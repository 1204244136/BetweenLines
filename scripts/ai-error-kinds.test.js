const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyAiError,
  recordAiErrorKind,
  mergeAiErrorKinds,
  sortAiErrorKinds,
  formatAiErrorHoverTitle,
} = require("../src/workbenches/translation-compare/ai/error-kinds");

test("异常归类：服务端的 error 对象按 code/httpStatus 落到对应类别", () => {
  assert.equal(classifyAiError({ httpStatus: 429, message: "请求受限" }), "rate_limit");
  assert.equal(classifyAiError({ httpStatus: 503, message: "服务暂时不可用" }), "rate_limit", "503 与频控同口径，不算 5xx");
  assert.equal(classifyAiError({ httpStatus: 500, message: "模型服务端异常" }), "server_error");
  assert.equal(classifyAiError({ code: "REQUEST_TIMEOUT", message: "请求超时" }), "timeout");
  assert.equal(classifyAiError({ httpStatus: 401, message: "认证失败" }), "auth");
  assert.equal(classifyAiError({ httpStatus: 404, message: "模型或端点不存在" }), "not_found");
  assert.equal(classifyAiError({ code: "INVALID_JSON_RESPONSE", message: "接口返回了非 JSON 响应" }), "bad_response");
  assert.equal(classifyAiError({ code: "ECONNREFUSED", message: "无法连接到模型服务" }), "network");
  assert.equal(classifyAiError({ code: "MISSING_BASE_URL", message: "未填写接口地址" }), "config");
  assert.equal(classifyAiError({ code: "MODEL_REFUSAL", message: "模型拒答" }), "refusal");
  assert.equal(classifyAiError({ message: "某种没见过的故障" }), "unknown");
});

test("异常归类：客户端的备注文本同样能落到对应类别", () => {
  assert.equal(classifyAiError("调用失败：请求超时，网络连接超时或模型响应过慢。"), "timeout");
  assert.equal(classifyAiError("调用失败（频控限制已达重试上限）：请求受限或额度不足（HTTP 429）。"), "rate_limit");
  assert.equal(classifyAiError("调用失败：模型服务端异常（HTTP 500）：服务提供方内部发生错误。"), "server_error");
  assert.equal(classifyAiError("调用失败：认证失败（HTTP 401）：API Key 无效或未提供。"), "auth");
  assert.equal(classifyAiError("调用失败：模型或端点不存在（HTTP 404）：请确认模型名称。"), "not_found");
  assert.equal(classifyAiError("调用失败：接口返回了非 JSON 响应，可能是网关拦截并返回了 HTML。"), "bad_response");
  assert.equal(classifyAiError("调用失败：域名解析失败（ENOTFOUND），请检查主机名。"), "network");
  assert.equal(classifyAiError("校对已终止。"), "stopped");
  assert.equal(classifyAiError("Stylist复审调用异常：超时"), "timeout");
  // 阶段名出现在错误正文里不算阶段归类，但正文里的「Arbiter endpoint 404」仍应按内容归类。
  assert.equal(classifyAiError("调用失败：Arbiter endpoint 404"), "not_found");
});

test("异常归类：非法输入不抛错，一律落到「其他错误」", () => {
  assert.equal(classifyAiError(null), "unknown");
  assert.equal(classifyAiError(undefined), "unknown");
  assert.equal(classifyAiError(""), "unknown");
  assert.equal(classifyAiError({}), "unknown");
});

test("异常明细：按类别累计行号并保留代表性消息，超出样本上限不再追加", () => {
  const kinds = {};
  recordAiErrorKind(kinds, "rate_limit", 3, "请求受限或额度不足（HTTP 429）");
  recordAiErrorKind(kinds, "rate_limit", 5, "另一条消息不该覆盖样本");
  recordAiErrorKind(kinds, "rate_limit", 3, "同一行不重复计行号");
  assert.equal(kinds.rate_limit.count, 3);
  assert.deepEqual(kinds.rate_limit.rows, [3, 5]);
  assert.match(kinds.rate_limit.sample, /HTTP 429/);

  const sorted = sortAiErrorKinds({ unknown: { count: 1, rows: [1] }, timeout: { count: 2, rows: [2, 4] } });
  assert.deepEqual(sorted.map((entry) => entry.kind), ["timeout", "unknown"], "展示顺序按固定优先级，而不是对象键序");
  assert.equal(sorted[0].label, "请求超时");
});

test("异常明细：两端口径合并取 max 计数与行号并集，不重复计同一行", () => {
  const fromNotes = { rate_limit: { count: 3, rows: [1, 2, 3], sample: "备注口径" } };
  const fromServer = { rate_limit: { count: 2, rows: [2, 3], sample: "服务端口径" } };
  const merged = mergeAiErrorKinds(fromNotes, fromServer);
  assert.equal(merged.rate_limit.count, 3, "同一批行在两端口径里只算一次");
  assert.deepEqual(merged.rate_limit.rows, [1, 2, 3]);
  assert.equal(merged.rate_limit.sample, "备注口径");

  // 两边观察到的不是同一批行（历史遗留 + 本次运行）时，以行号并集为准，避免低估。
  const historical = { timeout: { count: 2, rows: [1, 2] } };
  const current = { timeout: { count: 2, rows: [7, 8] } };
  const combined = mergeAiErrorKinds(historical, current);
  assert.equal(combined.timeout.count, 4);
  assert.deepEqual(combined.timeout.rows, [1, 2, 7, 8]);
});

test("悬停文本：逐类列出问题、行号与代表性消息", () => {
  const title = formatAiErrorHoverTitle("阶段三 终审仲裁", 12, {
    rate_limit: { count: 8, rows: [1, 2, 3], sample: "请求受限或额度不足（HTTP 429）" },
    server_error: { count: 4, rows: [9, 10] },
  });
  const lines = title.split("\n");
  assert.equal(lines[0], "阶段三 终审仲裁 · 异常 12 行");
  assert.match(lines[1], /^· 频控限流：8 行（第 1 行、第 2 行、第 3 行）$/);
  assert.match(lines[2], /请求受限或额度不足（HTTP 429）/);
  assert.match(lines[3], /^· 服务端错误：4 行（第 9 行、第 10 行）$/);
});

test("悬停文本：行号过多时折叠，没有明细时不空着", () => {
  const manyRows = Array.from({ length: 30 }, (_, offset) => offset + 1);
  const title = formatAiErrorHoverTitle("阶段一 事实初审", 30, { timeout: { count: 30, rows: manyRows } });
  assert.match(title, /另有 18 行/, "只列前 12 个行号，其余折叠");

  const noDetail = formatAiErrorHoverTitle("阶段二 文学复审", 4, {});
  assert.match(noDetail, /阶段二 文学复审 · 异常 4 行/);
  assert.match(noDetail, /暂无可分类的失败明细/);
});
