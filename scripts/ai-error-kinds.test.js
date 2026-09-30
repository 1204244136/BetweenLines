const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AI_ERROR_ROW_SAMPLE_LIMIT,
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

test("异常明细：两端口径按行号合并，同一批行只算一次", () => {
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

test("异常明细：两端把同一行归到不同类别时以服务端为准，不会让这一行同时出现在两类里", () => {
  // 服务端看得到 code（ECONNRESET → 网络），备注只有「请求失败」这类没有线索的文本（→ 其他）。
  const fromNotes = { unknown: { count: 3, rows: [1, 2, 3], sample: "请求失败" } };
  const fromServer = { network: { count: 3, rows: [1, 2, 3], sample: "请求失败" } };
  const merged = mergeAiErrorKinds(fromNotes, fromServer);
  assert.deepEqual(Object.keys(merged), ["network"], "被服务端认领的行不能在本地口径里再出现一次");
  assert.equal(merged.network.count, 3);

  // 只有部分行被服务端认领：其余行保留本地口径的归类。
  const partial = mergeAiErrorKinds(
    { unknown: { count: 4, rows: [1, 2, 3, 4], sample: "本地" } },
    { network: { count: 2, rows: [1, 2], sample: "服务端" } },
  );
  assert.equal(partial.network.count, 2);
  assert.deepEqual(partial.network.rows, [1, 2]);
  assert.equal(partial.unknown.count, 2);
  assert.deepEqual(partial.unknown.rows, [3, 4]);
  assert.equal(partial.unknown.sample, "本地");

  const total = Object.values(partial).reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(total, 4, "分类明细的总行数与实际出错行数一致");
});

test("异常明细：行号样本被截断的部分无法逐行去重，同类里按 max 处理而不是累加", () => {
  const capped = Array.from({ length: AI_ERROR_ROW_SAMPLE_LIMIT }, (_, offset) => offset + 1);
  const merged = mergeAiErrorKinds(
    { timeout: { count: AI_ERROR_ROW_SAMPLE_LIMIT + 100, rows: capped } },
    { timeout: { count: AI_ERROR_ROW_SAMPLE_LIMIT + 50, rows: capped } },
  );
  assert.equal(merged.timeout.count, AI_ERROR_ROW_SAMPLE_LIMIT + 100, "超出样本上限的行只有计数，两端取较大者");
  assert.equal(merged.timeout.rows.length, AI_ERROR_ROW_SAMPLE_LIMIT);

  // 老服务端只回报计数、没有行号：仍要保留计数，不能被行号并集吞掉。
  const countOnly = mergeAiErrorKinds({}, { rate_limit: { count: 5 } });
  assert.equal(countOnly.rate_limit.count, 5);
});

test("异常明细：合并不改动入参，空入参得到空结果", () => {
  const base = { timeout: { count: 1, rows: [1], sample: "a" } };
  const extra = { timeout: { count: 1, rows: [2], sample: "b" } };
  const snapshot = JSON.stringify([base, extra]);
  mergeAiErrorKinds(base, extra);
  assert.equal(JSON.stringify([base, extra]), snapshot);
  assert.deepEqual(mergeAiErrorKinds(null, undefined), {});
  assert.deepEqual(mergeAiErrorKinds({ timeout: { count: 0, rows: [] } }, {}), {}, "零计数的类别不进入结果");
});

test("悬停文本：逐类列出问题、行号与代表性消息", () => {
  const title = formatAiErrorHoverTitle("阶段三 终审仲裁", 12, {
    rate_limit: { count: 8, rows: [1, 2, 3], sample: "请求受限或额度不足（HTTP 429）" },
    server_error: { count: 4, rows: [9, 10] },
  });
  const lines = title.split("\n");
  assert.equal(lines[0], "阶段三 终审仲裁 · 异常 12 行");
  assert.match(lines[1], /^· 频控限流：8 行（第 1 行、第 2 行、第 3 行，另有 5 行）$/, "只存了 3 个行号但共 8 行：其余 5 行要如实算进「另有」");
  assert.match(lines[2], /请求受限或额度不足（HTTP 429）/);
  assert.match(lines[3], /^· 服务端错误：4 行（第 9 行、第 10 行，另有 2 行）$/);
});

test("悬停文本：行号过多时折叠，没有明细时不空着", () => {
  const manyRows = Array.from({ length: 30 }, (_, offset) => offset + 1);
  const title = formatAiErrorHoverTitle("阶段一 事实初审", 30, { timeout: { count: 30, rows: manyRows } });
  assert.match(title, /另有 18 行/, "只列前 12 个行号，其余折叠");

  // 行号样本有上限：出错行数超过样本时，「另有 N 行」要按总数算，不能只数已存下来的行号。
  const capped = Array.from({ length: AI_ERROR_ROW_SAMPLE_LIMIT }, (_, offset) => offset + 1);
  const overflow = formatAiErrorHoverTitle("阶段一 事实初审", 500, { timeout: { count: 500, rows: capped } });
  assert.match(overflow, /· 请求超时：500 行（.*，另有 488 行）/, "500 行里只列了 12 个，其余 488 行都要算进去");

  const noDetail = formatAiErrorHoverTitle("阶段二 文学复审", 4, {});
  assert.match(noDetail, /阶段二 文学复审 · 异常 4 行/);
  assert.match(noDetail, /暂无可分类的失败明细/);
});
