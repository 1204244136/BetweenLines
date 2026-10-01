// 「已生成项目」下拉框的选中规则：服务端换了活动项目必须跟随（新生成的工作台要自动切过去），
// 活动项目没变时不能被 700ms 一次的轮询顶掉用户正在浏览的项目。
const assert = require("node:assert/strict");
const test = require("node:test");

const { createConsole } = require("./setup-console-fixture");

function project(id, { active = false, snapshotId = `${id}-s1`, name = id } = {}) {
  return {
    id,
    snapshotId,
    name,
    active,
    comparisonMode: "bilingual",
    inputMode: "epub",
    files: { jp: { name: `${id}.epub` } },
    rowCount: 100,
    generatedAt: "2026-10-01T00:00:00.000Z",
    outputUrl: `/output/${id}/translation-compare.html`,
  };
}

const render = (ui, projects, activeProjectKey) => ui.run(
  `renderProjects(${JSON.stringify(projects)}, ${JSON.stringify(activeProjectKey)})`,
);

test("生成完成后「已生成项目」自动切到新项目", () => {
  const ui = createConsole();
  const previous = project("s3-05", { active: true });
  render(ui, [previous], "s3-05");
  assert.equal(ui.element("projectSelect").value, "s3-05");

  const generated = project("s3-06", { active: true });
  render(ui, [generated, { ...previous, active: false }], "s3-06");

  assert.equal(ui.element("projectSelect").value, "s3-06");
  assert.match(ui.element("projectSummary").innerHTML, /当前项目/);
  // 切换按钮对活动项目应当是禁用的：选中项与活动项目一致，不再提示「可切换项目」。
  assert.equal(ui.element("switchProjectButton").disabled, true);
});

test("生成完成时用户正选着别的项目，也要切到新项目", () => {
  const ui = createConsole();
  const active = project("s3-05", { active: true });
  const other = project("s3-04");
  render(ui, [active, other], "s3-05");
  ui.element("projectSelect").value = "s3-04";

  const generated = project("s3-06", { active: true });
  render(ui, [generated, { ...active, active: false }, other], "s3-06");

  assert.equal(ui.element("projectSelect").value, "s3-06");
});

test("同一项目重新生成（key 相同、快照不同）同样跟随", () => {
  const ui = createConsole();
  const other = project("s3-04");
  const first = project("s3-05", { active: true, snapshotId: "s3-05-a" });
  render(ui, [first, other], "s3-05");
  ui.element("projectSelect").value = "s3-04";

  const rebuilt = project("s3-05", { active: true, snapshotId: "s3-05-b" });
  render(ui, [rebuilt, other], "s3-05");

  assert.equal(ui.element("projectSelect").value, "s3-05");
});

test("活动项目没变时，轮询保留用户手动选择", () => {
  const ui = createConsole();
  const active = project("s3-05", { active: true });
  const other = project("s3-04");
  render(ui, [active, other], "s3-05");
  ui.element("projectSelect").value = "s3-04";

  for (let poll = 0; poll < 3; poll += 1) render(ui, [active, other], "s3-05");

  assert.equal(ui.element("projectSelect").value, "s3-04");
  assert.match(ui.element("projectSummary").innerHTML, /可切换项目/);
});

test("选中的项目被删除后回落到活动项目", () => {
  const ui = createConsole();
  const active = project("s3-05", { active: true });
  const other = project("s3-04");
  render(ui, [active, other], "s3-05");
  ui.element("projectSelect").value = "s3-04";

  render(ui, [active], "s3-05");

  assert.equal(ui.element("projectSelect").value, "s3-05");
});

test("本机没有已生成项目时禁用下拉框并给出占位项", () => {
  const ui = createConsole();
  render(ui, [], "");
  assert.equal(ui.element("projectSelect").value, "");
  assert.equal(ui.element("projectSelect").disabled, true);
  assert.equal(ui.element("projectCount").textContent, "0 个项目");
});

test("生成流水线回报的完成项目也会被选中", () => {
  const ui = createConsole();
  const previous = project("s3-05", { active: true });
  render(ui, [previous], "s3-05");

  const generated = project("s3-06", { active: true });
  ui.run(`upsertCompletedProject(${JSON.stringify(generated)})`);

  assert.equal(ui.element("projectSelect").value, "s3-06");
});

test("轮询 /api/status 后自动切到新发布的项目", async () => {
  const ui = createConsole();
  const previous = project("s3-05", { active: true });
  render(ui, [previous], "s3-05");

  const generated = project("s3-06", { active: true });
  ui.context.fetch = async () => ({
    json: async () => ({
      ok: true,
      apiVersion: 5,
      projects: [generated, { ...previous, active: false }],
      activeProjectKey: "s3-06",
      saved: null,
      savedFiles: {},
      pipeline: { running: false, step: "done", logs: [], progress: { percent: 100, step: "done" } },
    }),
  });

  await ui.run("refreshPipeline()");

  assert.equal(ui.element("projectSelect").value, "s3-06");
});
