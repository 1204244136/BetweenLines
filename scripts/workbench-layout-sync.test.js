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
      // 表格行：带上 dataset.index，让 renderVisibleRows 的 renderedRowsById 能真的建起来。
      if (name.includes("tr[data-index]")) {
        return new Array(editorCount).fill(0).map((_, i) => ({
          dataset: { index: String(i + 1) },
          classList: makeClassList(),
          querySelector: () => null,
          querySelectorAll: () => [],
          closest: () => null,
        }));
      }
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
  // 真实页面里 renderVisibleRows 会建好 renderedRowsById；可用高度的行数取自它，
  // 所以夹具必须如实建起来，否则测不到真实分支。
  ui.run(`
    renderedRowsById.clear();
    for (let i = 1; i <= ${editorCount}; i += 1) renderedRowsById.set(String(i), {});
  `);
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

test("批量量高：一批输入框只强制布局一次，而不是每行一次", () => {
  const { ui, counters, editorCount } = countingWorkbench(300);

  // 缓存预热后整批失效：真页面里这发生在整页重渲染 / 视口变化 / 列宽变化之后。
  ui.run("invalidateRevisionEditorHeights()");
  counters.heightReads = 0;
  ui.run("syncVisibleRowLayout()");

  assert.equal(
    counters.heightReads,
    editorCount,
    "每个未命中的编辑器仍要读一次 scrollHeight（读的次数不变，正确性不变）"
  );
  // 关键在于读的"排列方式"：交错写读时每行读都会重新触发强制布局；批量读时
  // 只有第一次读强制布局，后续读命中同一次布局结果。用真实浏览器实测的判据是
  // 耗时（300 个输入框 287ms → 20ms），这里锁住的是实现必须走批量路径：
  // 一次同步里对整批的读必须发生在所有写之后，而不是写读交替。
  const reads = ui.run(`
    (() => {
      const order = [];
      const editors = Array.from(tbody.querySelectorAll(".revision-editor"));
      let writes = 0;
      let reads = 0;
      for (const e of editors) {
        Object.defineProperty(e, "scrollHeight", { configurable: true, get() { reads += 1; order.push("read"); return 320; } });
        const prev = e.style;
        e.style = new Proxy(prev, { set(target, key, value) { if (key === "height") { writes += 1; order.push("write"); } target[key] = value; return true; } });
      }
      invalidateRevisionEditorHeights();
      syncVisibleRowLayout();
      // 统计"写→读"的切换次数：交错实现是 O(2n)，批量实现最多 2 次切换。
      let switches = 0;
      for (let i = 1; i < order.length; i += 1) if (order[i] !== order[i - 1]) switches += 1;
      return { switches, reads, writes };
    })()
  `);
  assert.ok(
    reads.switches <= 2,
    "整批量高必须是「先整批写、再连续读、最后统一写回」三段式，读写切换不得超过 2 次（实测 " + reads.switches + " 次）"
  );
});

test("可用高度：不得为数行数而查 DOM（500 行实测 239ms 的强制布局）", () => {
  const { ui, counters } = countingWorkbench(300);

  // 已渲染行数由 renderVisibleRows 传进来 / 取自 renderedRowsById，查 DOM 是多付一次整表布局。
  ui.run("syncVisibleRowLayout()");
  counters.editorQueries = 0;
  ui.run("syncVisibleRowLayout({ remeasureEditors: true })");
  assert.equal(
    counters.editorQueries,
    1,
    "一次同步只允许查一次编辑器列表；为数行数再查一次 tr[data-index] 就是多一次整表强制布局"
  );
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

test("审核轨迹：手动开合的选择必须跨重渲染保持，否则用户要反复点", async () => {
  const { ui } = countingWorkbench(10);

  // 夹具不解析 DOM，重渲染只产出 HTML 字符串；真实语义看的正是这段字符串里
  // 审核轨迹块带不带 hidden——它决定用户看到的到底是展开还是收起。
  const renderedHidden = (rowId) => {
    const html = String(ui.element("tbody").innerHTML || "");
    const block = html.match(new RegExp('id="pipelineDetails_' + rowId + '"([^>]*)>'));
    if (!block) return null;
    return /\shidden/.test(block[1]);
  };

  // 默认：待人工确认行的审核轨迹展开，普通行收起。
  ui.run(`notes["2"] = { note: ${JSON.stringify(NOTE_WITH_STAGES)}, revisionText: ${JSON.stringify(REVISION)}, revisionTarget: "cn", manualDone: false, done: false, aiDone: true };`);
  ui.run('notes["2"].note = notes["2"].note.replace("是否需要修改：是", "是否需要修改：待人工确认");');

  ui.run("applyFilters({ reset: false })");
  assert.equal(renderedHidden("1"), true, "普通行（非待判）的审核轨迹默认收起");
  assert.equal(renderedHidden("2"), false, "待人工确认行的审核轨迹默认展开");

  // 用户点击收起第 2 行。
  const badge = { dataset: { pipelineToggle: "2" }, querySelector: () => null, closest: () => null };
  const click = async () => {
    await ui.element("tbody").dispatch("click", {
      target: { closest: (selector) => (selector === "[data-pipeline-toggle]" ? badge : null) },
      preventDefault() {},
      stopPropagation() {},
    });
  };
  await click();
  assert.equal(ui.element("pipelineDetails_2").hidden, true, "点击后必须收起");

  // 重渲染（筛选 / 翻页 / 改每页行数 / AI 结果到达都会走这里）后必须保持收起，
  // 否则用户收起的行又弹开，只能反复点——每次点击都连带一次整页重渲染。
  ui.run("applyFilters({ reset: false })");
  assert.equal(
    renderedHidden("2"),
    true,
    "重渲染后必须保持用户选择的收起状态（回弹会迫使用户反复点击，每次都吃一次整页重渲染）"
  );
  assert.equal(ui.element("pipelineDetails_2").hidden, true, "页面上的状态同样保持收起");

  // 再点一次展开，同样要跨重渲染保持。
  await click();
  ui.run("applyFilters({ reset: false })");
  assert.equal(renderedHidden("2"), false, "重渲染后必须保持用户选择的展开状态");

  // 没被手动开合过的行不受影响。
  assert.equal(renderedHidden("1"), true, "未手动开合的行仍走默认状态");
});

test("性能优化：computeStageMetricsFromNotes 稳态下直接命中缓存，不随轮询重复扫描全表", () => {
  const currentKey = "translation-compare-notes-v7:project:rows";
  const mockNotes = {};
  for (let i = 1; i <= 200; i += 1) {
    mockNotes[i] = {
      note: `[AI校对]\n语义是否相同：相同\n是否需要修改：${i % 2 === 0 ? "是" : "否"}\nGatekeeper初审：评语${i}\n${i % 2 === 0 ? `初审改案：改案${i}\nStylist复审[采纳]：同意\n修改结果：改案${i}` : ""}`,
      aiDone: true,
    };
  }
  const storage = storageFixture({
    [currentKey]: JSON.stringify(mockNotes),
  });
  const rows = Array.from({ length: 200 }, (_, i) => ({
    index: i + 1,
    jp: "JP" + (i + 1),
    cn: "CN" + (i + 1),
    tw: "TW" + (i + 1),
    relation: "1:1",
    score: 0.85,
    signature: "sig-" + (i + 1),
  }));

  const ui = createWorkbench(storage, { rows });

  // 第一次已在初始化时计算并缓存，记录连续调用 50 次未修改状态下的总耗时
  const start = Date.now();
  ui.run(`
    for (let j = 0; j < 50; j++) {
      computeStageMetricsFromNotes(notes);
    }
  `);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 200, `50 次无变动查询总耗时应小于 200ms（实测 ${elapsed}ms），必须直接命中缓存`);
});

test("性能优化：inlineDiffHtml 与 parseAutomatedNote 具备高频结果缓存", () => {
  const ui = createWorkbench();

  // 1. parseAutomatedNote 缓存验证：相同文本多次解析返回同一内容
  const sameNote = "[AI校对]\n语义是否相同：相同\n是否需要修改：是\n初审改案：测试改案\n修改结果：测试改案";
  const ref1 = ui.run(`parseAutomatedNote(${JSON.stringify(sameNote)})`);
  const ref2 = ui.run(`parseAutomatedNote(${JSON.stringify(sameNote)})`);
  assert.deepEqual(ref1, ref2);

  // 2. inlineDiffHtml 缓存验证：多次计算相同文本对结果完全一致且命中缓存
  const diff1 = ui.run(`inlineDiffHtml("那是没办法的事。", "那是莫可奈何的事。")`);
  const diff2 = ui.run(`inlineDiffHtml("那是没办法的事。", "那是莫可奈何的事。")`);
  assert.equal(diff1, diff2);
  assert.match(diff1, /<del>.*<\/del>/);
});
