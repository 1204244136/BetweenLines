const assert = require("node:assert/strict");
const test = require("node:test");
const { ROWS, createWorkbench, storageFixture } = require("./workbench-fixture");

// 写回定位按「整卷行序」推进锚点：未改动的行也要按自己的文本先占住位置，要改的行才落在
// 自己那一处。这份行序清单由客户端随请求发出（服务端只做形状校验），缺了它同一段文字在
// 别处先出现时就会被本行改掉——所以请求体必须带上它，且只能带真实存在的列。
test("写回请求带整卷行序：批量写回按目标列发出全部行文本", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: { "/api/translation-export": { ok: true, updated: 2, missed: [], ambiguous: [], targets: ["B.txt"] } },
  });
  ui.run('notes["1"] = { revisionText: "译文一改", revisionTarget: "cn" }; notes["3"] = { revisionText: "译文三改", revisionTarget: "cn" };');
  await ui.element("exportNotes").dispatch("click");

  assert.equal(ui.posts.length, 1);
  const [post] = ui.posts;
  assert.equal(post.url, "/api/translation-export");
  assert.deepEqual(post.body.entries.map((entry) => entry.id), ["1", "3"]);
  assert.deepEqual(post.body.entries.map((entry) => entry.searchText), ["译文一", "译文三"]);
  assert.deepEqual(post.body.rowTexts, { cn: ROWS.map((row) => row.cn) });
  // 双语模式没有第三列，行序清单里也不允许出现 tw。
  assert.equal(Object.prototype.hasOwnProperty.call(post.body.rowTexts, "tw"), false);
});

test("写回请求带整卷行序：单行写回只发到该行为止", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: { "/api/translation-export": { ok: true, updated: 1, missed: [], ambiguous: [], targets: ["B.txt"] } },
  });
  ui.run('notes["2"] = { revisionText: "译文二改", revisionTarget: "cn" };');
  ui.run('writebackSingleRevision("2", { disabled: false, textContent: "", classList: { add() {} } })');

  assert.equal(ui.posts.length, 1);
  // 更靠后的行不参与锚点，没必要发——第 2 行只带前两行。
  assert.deepEqual(ui.posts[0].body.rowTexts, { cn: ["译文一", "译文二"] });
  assert.deepEqual(ui.posts[0].body.entries.map((entry) => entry.id), ["2"]);
});
