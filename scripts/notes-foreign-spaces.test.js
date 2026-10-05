const assert = require("node:assert/strict");
const test = require("node:test");
const { createWorkbench, storageFixture, currentKey, siblingKey } = require("./workbench-fixture");

// 浏览器 localStorage 由多个项目共享。当前工作台只对「本项目的空间」开放找回，
// 但其他项目/旧版空间同样占着同一份容量——写满之后本页备注就再也存不进去，刷新即丢。
// 这一区因此单独列出，只给导出与删除，不给找回。
const foreignKey = "translation-compare-notes-v7:other-project:otherRows";

test("其他项目/旧版空间单列一区：可导出可删除，但不进找回入口", () => {
  const storage = storageFixture({
    [currentKey]: "{}",
    [siblingKey]: JSON.stringify({ 1: { note: "本项目历史" } }),
    [foreignKey]: JSON.stringify({ 1: { note: "其他项目历史" } }),
  });
  const ui = createWorkbench(storage);

  // 找回入口（notesSpaceInventory）仍然只装本项目的空间。
  assert.equal(
    ui.run(`notesSpaceInventory.some((space) => space.key === ${JSON.stringify(foreignKey)})`),
    false,
    "其他项目空间不得进入当前项目的找回入口",
  );
  assert.deepEqual(
    JSON.parse(ui.run("JSON.stringify(collectForeignNotesSpaces().map((space) => space.key))")),
    [foreignKey],
    "其他项目空间单独成表",
  );

  // 页面上确实露出这一区，并且只给导出/删除。
  assert.equal(ui.element("notesForeignHeading").hidden, false, "有其他项目空间时要露出这一区");
  assert.equal(ui.element("notesForeignList").hidden, false);
  const markup = ui.element("notesForeignList").innerHTML;
  assert.match(markup, /other-project/, "列表里能看到是哪个项目");
  assert.match(markup, /data-notes-drop/, "可以删除，才能腾出浏览器容量");
  assert.match(markup, /data-notes-export/, "删除前可以单独导出");
  assert.equal(/data-notes-restore/.test(markup), false, "其他项目空间不给「预览找回」");
  assert.equal(/data-notes-index/.test(markup), false, "其他项目空间不给「按行号找回」");

  // 导出与删除按空间键回查；找回路径仍然查不到其他项目空间。
  const exported = JSON.parse(ui.run("JSON.stringify(notesBackup(collectForeignNotesSpaces()))"));
  assert.deepEqual(exported.spaces.map((space) => space.key), [foreignKey]);
  assert.equal(ui.run(`Boolean(freshAnyNotesSpace(${JSON.stringify(foreignKey)}))`), true);
  assert.equal(
    ui.run(`Boolean(freshNotesSpace(${JSON.stringify(foreignKey)}))`),
    false,
    "找回路径（freshNotesSpace）仍然只认本项目的空间",
  );
  // 隔离只影响当前页面：这一区不得顺手删掉别的项目的记录。
  assert.notEqual(ui.storage.getItem(foreignKey), null, "列出不等于删除");
});

test("没有其他项目空间时，这一区整块收起", () => {
  const ui = createWorkbench(storageFixture({
    [currentKey]: "{}",
    [siblingKey]: JSON.stringify({ 1: { note: "本项目历史" } }),
  }));
  assert.equal(ui.element("notesForeignHeading").hidden, true);
  assert.equal(ui.element("notesForeignList").hidden, true);
  assert.deepEqual(JSON.parse(ui.run("JSON.stringify(collectForeignNotesSpaces())")), []);
});

test("「备份全部」仍然只导出本项目的空间，不把别的项目记录带出去", () => {
  const ui = createWorkbench(storageFixture({
    [currentKey]: "{}",
    [siblingKey]: JSON.stringify({ 1: { note: "本项目历史" } }),
    [foreignKey]: JSON.stringify({ 1: { note: "其他项目历史" } }),
  }));
  const backup = JSON.parse(ui.run("JSON.stringify(notesBackup(collectNotesSpaces()))"));
  assert.equal(backup.spaces.some((space) => space.key === siblingKey), true, "本项目历史照常导出");
  assert.equal(
    backup.spaces.some((space) => space.key === foreignKey),
    false,
    "当前项目备份不得带出其他项目记录",
  );
});
