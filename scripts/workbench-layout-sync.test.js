// 布局同步的性能契约回归：工作台在「开关审核轨迹 / 抽屉开合 / 窗口尺寸变化 / 显示开关」时，
// 绝不能对整表反复强制同步布局。读 scrollHeight / 读 getBoundingClientRect 都必须先把
// 待处理的样式与布局算完，读几次就是几次强制布局——逐行读一次就是一次整表重排。
// 实测 500 行页面单次全量同步 = 533 次强制布局、245ms 布局、311ms 主线程占用，
// 连续触发会把主线程占满，表现就是鼠标移动变慢、输入出现延迟。
//
// 这里用"计数假 DOM"把强制布局次数变成可断言的事实。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture } = require("./workbench-fixture");

const REVISION = "他终究还是没能推开那扇门。";
const NOTE_WITH_STAGES = [
  "[AI校对]",
  "语义是否相同：不同",
  "是否需要修改：是",
  "Gatekeeper初审：指出否定时态遗漏。",
  "Stylist复审[调整]：调整为更自然的主谓句。",
  "Arbiter仲裁[Stylist方案]：裁定采纳复审方案。",
  "修改结果：" + REVISION,
].join("\n");

function makeClassList() {
  const set = new Set();
  return {
    add(name) { set.add(name); },
    remove(name) { set.delete(name); },
    toggle(name, force) {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name); else set.delete(name);
      return on;
    },
    contains(name) { return set.has(name); },
  };
}

function countingWorkbench(editorCount) {
  const counters = { heightReads: 0, frameRects: 0, editorQueries: 0, maxHeightWrites: 0 };
  const makeEditors = () => Array.from({ length: editorCount }, () => ({
    value: REVISION,
    classList: makeClassList(),
    style: { height: "", setProperty() {} },
    get scrollHeight() { counters.heightReads += 1; return 320; },
    getClientRects() { return [{}]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
  }));
  // 整页重渲染（tbody.innerHTML = ...）在真实页面里产生的是全新节点，这里如实模拟。
  let editors = makeEditors();
  const rerender = () => { editors = makeEditors(); };
  // 容器位置可被测试推动，用来模拟"抽屉开合把表格推下去"。
  let frameTop = 120;
  const moveFrame = (top) => { frameTop = top; };

  const tbody = {
    querySelectorAll(selector) {
      const name = String(selector);
      if (name.includes(".revision-editor")) {
        counters.editorQueries += 1;
        return editors;
      }
      // 表格行数：超过 3 行才不会走 is-fit-content 分支。
      if (name.includes("tr[data-index]")) return new Array(editorCount).fill({});
      return [];
    },
  };
  const tableFrame = {
    classList: makeClassList(),
    getBoundingClientRect() { counters.frameRects += 1; return { top: frameTop, height: 600, bottom: frameTop + 600 }; },
    querySelector() { return null; },
    clientHeight: 600,
    scrollHeight: 4000,
    offsetTop: frameTop,
  };

  const ui = createWorkbench(storageFixture({}), {
    rows: [
      { index: 1, jp: "原文一", cn: "译文一", relation: "1:1", score: 0.9, signature: "sig-1" },
      { index: 2, jp: "原文二", cn: "译文二", relation: "1:1", score: 0.9, signature: "sig-2" },
    ],
  });
  ui.run(`notes["1"] = { note: ${JSON.stringify(NOTE_WITH_STAGES)}, revisionText: ${JSON.stringify(REVISION)}, revisionTarget: "cn", manualDone: false, done: false, aiDone: true };`);
  ui.element("tbody").querySelectorAll = tbody.querySelectorAll;
  // 客户端拿的是 document.querySelector(".table-frame")，夹具按原始选择器字符串建键，
  // 所以这里必须用 ".table-frame" 才是同一个对象。
  const frame = ui.element(".table-frame");
  frame.getBoundingClientRect = tableFrame.getBoundingClientRect;
  frame.classList = tableFrame.classList;
  frame.clientHeight = tableFrame.clientHeight;
  frame.scrollHeight = tableFrame.scrollHeight;
  frame.querySelector = tableFrame.querySelector;
  // --results-max-height 的写入次数就是"整棵表格子树样式重算"的次数。
  const wrap = ui.element(".wrap");
  wrap.style.setProperty = () => { counters.maxHeightWrites += 1; };

  // 建立"缓存已预热"的基线：先给一个真实视口高度并按内容量一次高，再把计数清零，
  // 后续断言只反映增量。
  ui.run("window.innerHeight = 900");
  ui.run("syncVisibleRowLayout()");
  counters.heightReads = 0;
  counters.frameRects = 0;
  counters.editorQueries = 0;
  counters.maxHeightWrites = 0;
  return { ui, counters, rerender, moveFrame, editors: () => editors, editorCount };
}

test("布局同步：尺寸没变时连续同步不得再量高", () => {
  const { ui, counters } = countingWorkbench(40);

  ui.run("syncVisibleRowLayout()");
  ui.run("syncVisibleRowLayout()");
  ui.run("syncVisibleRowLayout()");
  assert.equal(
    counters.heightReads,
    0,
    "尺寸没变时不得再读 scrollHeight（读一次就是一次整表强制重排）"
  );
});

test("布局同步：稳态下单次同步的强制布局次数不随行数增长", () => {
  const measureSteadyState = (editorCount) => {
    const { ui, counters } = countingWorkbench(editorCount);
    ui.run("syncVisibleRowLayout()");
    return counters.heightReads + counters.frameRects;
  };
  const small = measureSteadyState(5);
  const large = measureSteadyState(300);
  assert.equal(
    large,
    small,
    "稳态同步成本必须与行数无关：与行数成正比的强制布局正是鼠标变慢的根因"
  );
  assert.ok(small <= 2, "稳态下单次同步的强制布局次数应保持在个位数以内，实际 " + small);
});

test("布局同步：可用高度没变就不写 CSS 变量", () => {
  const { ui, counters, moveFrame } = countingWorkbench(10);

  ui.run("syncVisibleRowLayout()");
  assert.equal(counters.maxHeightWrites, 0, "可用高度值没变时不得重复写 --results-max-height");

  moveFrame(200);
  ui.run("syncVisibleRowLayout()");
  assert.equal(counters.maxHeightWrites, 1, "容器位置变了必须更新可用高度");
});

test("布局同步：视口高度变化后必须重新量高", () => {
  const { ui, counters, editorCount } = countingWorkbench(40);

  // 40vh 上限随视口变化：缓存的像素高度全部作废。
  ui.run("window.innerHeight = 700");
  ui.run("syncVisibleRowLayout()");
  assert.equal(counters.heightReads, editorCount, "视口高度变化后必须重新量高");

  ui.run("syncVisibleRowLayout()");
  assert.equal(counters.heightReads, editorCount, "同一视口高度下不得重复量高");
});

test("布局同步：列宽变化（显示开关）后必须整批重算", () => {
  const { ui, counters, editorCount } = countingWorkbench(20);

  // 隐藏原文列会把输入框从 412px 拉到 579px，行高必须重算。
  ui.run("syncVisibleRowLayout({ remeasureEditors: true })");
  assert.equal(counters.heightReads, editorCount, "列宽变化后必须整批重新量高");
});

test("布局同步：单个编辑器内容变化只重算它自己", () => {
  const { ui, counters } = countingWorkbench(30);

  // 切版本只改写一行：只失效那一行的缓存，其余行不该被连带重量。
  ui.run(`
    window.__one = tbody.querySelectorAll(".revision-editor")[0];
    invalidateRevisionEditorHeight(window.__one);
  `);
  assert.equal(counters.heightReads, 0, "失效缓存本身不得触发任何强制布局");

  ui.run("syncVisibleRowLayout()");
  assert.equal(counters.heightReads, 1, "只失效一个编辑器时，只应重算这一个");
});

test("布局同步：整页重新渲染后必须重新量高", () => {
  const { ui, counters, rerender, editorCount } = countingWorkbench(10);

  rerender();
  ui.run("syncVisibleRowLayout()");
  assert.equal(counters.heightReads, editorCount, "整页重渲染后的新节点必须按内容量高");
});

test("审核轨迹开关：点击不触发任何整表布局工作", async () => {
  const { ui, counters } = countingWorkbench(30);

  const badge = {
    dataset: { pipelineToggle: "1" },
    querySelector: () => null,
    closest: () => null,
  };
  const details = ui.element("pipelineDetails_1");
  details.hidden = true;
  ui.element("pipelineDetails_1").hidden = true;
  // 走真实点击处理器：target.closest("[data-pipeline-toggle]") 命中轨迹胶囊。
  const event = {
    target: { closest: (selector) => (selector === "[data-pipeline-toggle]" ? badge : null) },
    preventDefault() {},
    stopPropagation() {},
  };
  await ui.element("tbody").dispatch("click", event);

  assert.equal(details.hidden, false, "点击后轨迹抽屉必须展开（功能不能被优化掉）");
  assert.equal(counters.heightReads, 0, "开关审核轨迹不得重新量高");
  assert.equal(counters.editorQueries, 0, "开关审核轨迹不得查编辑器列表");
  assert.equal(counters.frameRects, 0, "开关审核轨迹不得读容器矩形");
  assert.equal(counters.maxHeightWrites, 0, "开关审核轨迹不得重写可用高度");
});

test("面板抽屉：容器位置没变就整段收工，位移了才更新可用高度", () => {
  const { ui, counters, moveFrame } = countingWorkbench(30);

  ui.run("syncVisibleRowLayout({ ifFrameMoved: true })");
  assert.equal(counters.heightReads, 0, "容器没动时不得量高");
  assert.equal(counters.editorQueries, 0, "容器没动时应直接收工，连编辑器列表都不查");
  assert.equal(counters.maxHeightWrites, 0, "容器没动时不得重写可用高度");

  // 抽屉展开把表格推下去：这时必须真的更新一次可用高度。
  moveFrame(260);
  ui.run("syncVisibleRowLayout({ ifFrameMoved: true })");
  assert.equal(counters.maxHeightWrites, 1, "容器位移后必须更新可用高度");
  assert.equal(counters.heightReads, 0, "行宽没变，逐行高度一律不必重量");
});
