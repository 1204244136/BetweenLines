const assert = require("node:assert/strict");
const test = require("node:test");
const { createSystemMessage, CACHEABLE_PREFIX_LENGTH } = require("../src/ai/prompt-contract");
const { buildClaudeMessageBody, buildChatCompletionBody, callChatCompletions } = require("../src/ai/llm-client");

test("提示词缓存：仅稳定 system 前缀带 Claude 缓存断点，动态资料和当前行不写缓存", () => {
  const prefix = "固定校对规范。\n只返回 JSON。";
  const suffix = "\n本行命中的术语。";
  const messages = [createSystemMessage(prefix + suffix, prefix.length), { role: "user", content: "当前行" }];
  const body = buildClaudeMessageBody(messages, { model: "test" });
  assert.deepEqual(body.system, [
    { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
    { type: "text", text: suffix },
  ]);
  assert.deepEqual(body.messages, [{ role: "user", content: "当前行" }]);
  assert.equal(body.cache_control, undefined);
  assert.equal(messages[0].content, prefix + suffix);
});

test("提示词缓存：内部边界不进入 compatible JSON，旧消息与非法边界保持原请求格式", () => {
  const message = createSystemMessage("固定规则", 4);
  assert.equal(message[CACHEABLE_PREFIX_LENGTH], 4);
  assert.deepEqual(message, { role: "system", content: "固定规则" });
  const body = JSON.parse(JSON.stringify(buildChatCompletionBody([message], { model: "test" })));
  assert.deepEqual(body.messages, [{ role: "system", content: "固定规则" }]);
  assert.equal(JSON.stringify(body).includes("cache"), false);
  for (const invalid of [0, -1, 100, 1.5, NaN, Infinity]) {
    assert.equal(buildClaudeMessageBody([createSystemMessage("规则", invalid)], { model: "test" }).system, "规则");
  }
  assert.equal(buildClaudeMessageBody([
    { role: "system", content: "第一段" }, { role: "system", content: "第二段" },
  ], { model: "test" }).system, "第一段\n\n第二段");
});

test("提示词缓存：多 system 消息保留分隔和顺序，最多四个显式断点", () => {
  const messages = Array.from({ length: 6 }, (_, index) => createSystemMessage("规则" + index, 3));
  const body = buildClaudeMessageBody(messages, { model: "test" });
  assert.equal(body.system.filter((block) => block.cache_control).length, 4);
  assert.equal(body.system.map((block) => block.text).join(""), messages.map((message) => message.content).join("\n\n"));
});

test("提示词缓存：前条 system 出现动态后缀或未知内容后，后续断点不得覆盖它", () => {
  const body = buildClaudeMessageBody([
    createSystemMessage("规则\n动态资料", 2), createSystemMessage("后续固定规则", 6),
  ], { model: "test" });
  assert.equal(body.system.filter((block) => block.cache_control).length, 1);
  assert.equal(body.system[0].text, "规则");
  assert.equal(body.system.map((block) => block.text).join(""), "规则\n动态资料\n\n后续固定规则");
  const unknown = buildClaudeMessageBody([
    { role: "system", content: "未声明的资料" }, createSystemMessage("后续规则", 4),
  ], { model: "test" });
  assert.equal(unknown.system, "未声明的资料\n\n后续规则");
});

test("提示词缓存：真实传输包装保留稳定边界，切换行只改变动态后缀", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { headers: { "content-type": "application/json" } });
  };
  try {
    for (const row of ["甲", "乙"]) {
      await callChatCompletions([createSystemMessage("固定规则\n" + row, 4), { role: "user", content: row }], {
        protocol: "claude", model: "test", baseUrl: "http://127.0.0.1:11434",
      });
    }
    assert.deepEqual(requests[0].system[0], requests[1].system[0]);
    assert.notDeepEqual(requests[0].system[1], requests[1].system[1]);
    assert.equal(requests.every((request) => request.messages[0].cache_control == null), true);
  } finally { global.fetch = originalFetch; }
});
