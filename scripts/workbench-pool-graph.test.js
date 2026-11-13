const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPoolFlowGraph, poolFlowCount, poolFlowWidth, poolFlowGeometry, poolFlowSourceCenter, poolFlowTooltip,
} = require("../public/workbench-pool-graph");

test("管道只按实际在途数变粗，显示宽度封顶不截断真实计数", () => {
  assert.equal(poolFlowWidth(0), 1.5);
  assert.ok(poolFlowWidth(1) < poolFlowWidth(32));
  assert.ok(poolFlowWidth(32) < poolFlowWidth(128));
  assert.equal(poolFlowWidth(128), 12);
  assert.equal(poolFlowWidth(10000), 12);
  assert.equal(poolFlowCount(10000), 10000);
  for (const value of [NaN, Infinity, -1, "invalid"]) assert.equal(poolFlowCount(value), 0);
});

test("箭头和管道使用同一条连续流动路径，粗线不伸过箭头后缘", () => {
  for (const inFlight of [0, 1, 32, 128, 1024]) {
    const geometry = poolFlowGeometry({ x1: 120, y1: 100, x2: 300, y2: 200, inFlight });
    assert.equal(geometry.width, poolFlowWidth(inFlight));
    assert.ok(geometry.arrowBase < geometry.x2);
    assert.ok(geometry.flowPath.startsWith(geometry.path));
    assert.ok(geometry.flowPath.endsWith("L 300 200"));
    assert.ok(geometry.path.endsWith(`${geometry.arrowBase} 200`));
    assert.ok(geometry.arrowPath.startsWith("M 300 200"));
    assert.ok(geometry.arrowHalf * 2 > geometry.width);
  }
});

test("总并发的中线使用实际起点组边界，增删起点与线宽变化都会重算", () => {
  assert.equal(poolFlowSourceCenter([], 90), 90);
  assert.equal(poolFlowSourceCenter([{ y1: 40, radius: 6 }]), 40);
  assert.equal(poolFlowSourceCenter([{ y1: 40, radius: 3 }, { y1: 56, radius: 3 }]), 48);
  assert.equal(poolFlowSourceCenter([{ y1: 40, radius: 6 }, { y1: 56, radius: 3 }, { y1: 72, radius: 3 }]), 54.5);
  assert.equal(poolFlowSourceCenter([{ y1: 56, radius: 3 }, { y1: 72, radius: 3 }]), 64);
});

test("悬停只展示本条连接的四行状态，不混入共享配额或预设总量", () => {
  const connection = { label: "供应商 / 模型", stage: "stage2", stageLabel: "阶段二 文学复审", inFlight: 8, quota: 64, total: 20 };
  assert.deepEqual(poolFlowTooltip(connection).split("\n"), [
    "预设：供应商 / 模型", "阶段：阶段二 文学复审", "状态：运行中", "当前并发：8",
  ]);
  assert.match(poolFlowTooltip({ ...connection, inFlight: 0, state: "冷却中" }), /状态：冷却中\n当前并发：0$/);
  assert.match(poolFlowTooltip({ ...connection, state: "停止中" }), /状态：停止中\n当前并发：8$/);
  assert.match(poolFlowTooltip({ ...connection, inFlight: null, state: "状态未获取" }), /状态：状态未获取\n当前并发：—$/);
  assert.doesNotMatch(poolFlowTooltip(connection), /64|20|配额|总并发/);
});

test("缺少 SVG 能力的旧页面和 VM DOM 可安全加载", () => {
  const graph = createPoolFlowGraph({ board: { ownerDocument: {} }, svg: {}, list: {} });
  assert.doesNotThrow(() => { graph.update([{ presetId: "a", stage: "stage1" }]); graph.schedule(); graph.destroy(); });
});

function graphFixture() {
  const frames = new Map();
  let frameId = 0;
  const view = {
    innerWidth: 800, innerHeight: 600, performance: { now: () => 100 },
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); }, addEventListener() {}, removeEventListener() {},
  };
  const doc = { defaultView: view };
  class Element {
    constructor(tag, rect = { left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 }) {
      this.tag = tag; this.ownerDocument = doc; this.children = []; this.parentNode = null;
      this.rect = rect; this.dataset = {}; this.attributes = new Map(); this.events = new Map();
      this.style = { setProperty(name, value) { this[name] = value; } };
      const classes = new Set();
      this.classList = {
        add: (value) => classes.add(value), remove: (value) => classes.delete(value),
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
        contains: (value) => classes.has(value),
      };
      this.htmlWrites = 0; this._html = "";
    }
    set innerHTML(value) { this._html = value; this.htmlWrites += 1; }
    get innerHTML() { return this._html; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) { nodes.forEach((node) => this.insertBefore(node, null)); }
    insertBefore(node, before) {
      node.remove();
      node.parentNode = this;
      const index = before ? this.children.indexOf(before) : this.children.length;
      this.children.splice(index, 0, node);
    }
    remove() {
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    getBoundingClientRect() { return this.rect; }
    querySelector(selector) { return selector === ".ai-pool-preset-runtime" ? this.runtime : null; }
    addEventListener(name, callback) { this.events.set(name, callback); }
    removeEventListener(name) { this.events.delete(name); }
    emit(name, event = {}) { this.events.get(name)?.(event); }
  }
  doc.createElement = (tag) => new Element(tag);
  doc.createElementNS = (_ns, tag) => new Element(tag);
  const board = new Element("div");
  const svg = new Element("svg");
  svg.getScreenCTM = () => ({});
  const list = new Element("div", { left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300 });
  const card = new Element("div", { left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100 });
  card.dataset.presetId = "a";
  card.runtime = new Element("span");
  list.append(card);
  const stages = Object.fromEntries(["stage1", "stage2", "stage3"].map((stage, index) => [stage,
    new Element("article", { left: 500, top: index * 120, right: 800, bottom: index * 120 + 100, width: 300, height: 100 }),
  ]));
  const graph = createPoolFlowGraph({ board, svg, list, stages });
  const flush = () => { const work = [...frames.values()]; frames.clear(); work.forEach((callback) => callback()); };
  return { board, svg, list, card, graph, flush, frames };
}

test("轮询复用动效和命中节点，悬停只改颜色状态，实时提示跟随本条并发", () => {
  const ui = graphFixture();
  const connection = { presetId: "a", stage: "stage1", label: "A", inFlight: 128 };
  ui.graph.update([connection]); ui.flush();
  const group = ui.svg.children[0].children[0];
  const hit = ui.svg.children[1].children[0];
  const tooltip = ui.board.children[0];
  const writes = group.htmlWrites;
  hit.emit("pointerenter", { clientX: 380, clientY: 50 });
  assert.equal(group.classList.contains("is-hovered"), true);
  assert.equal(group.style["--flow-width"], "12px");
  assert.match(tooltip.textContent, /当前并发：128$/);
  ui.graph.update([{ ...connection, inFlight: 1024 }]); ui.flush();
  assert.equal(ui.svg.children[0].children[0], group);
  assert.equal(ui.svg.children[1].children[0], hit);
  assert.equal(group.htmlWrites, writes);
  assert.match(tooltip.textContent, /当前并发：1024$/);
  ui.graph.update([{ ...connection, inFlight: 1024, state: "停止中" }]); ui.flush();
  assert.equal(group.htmlWrites, writes);
  assert.match(tooltip.textContent, /状态：停止中\n当前并发：1024$/);
  ui.graph.update([{ ...connection, inFlight: null, state: "状态未获取" }]); ui.flush();
  assert.match(tooltip.textContent, /状态：状态未获取\n当前并发：—$/);
  assert.equal(group.classList.contains("is-running"), false);
  hit.emit("pointerleave");
  assert.equal(group.classList.contains("is-hovered"), false);
  assert.equal(tooltip.hidden, true);
  ui.graph.destroy();
});

test("实际生成的圆点变化重算总并发中线，列表滚动隐藏不可见管道", () => {
  const ui = graphFixture();
  ui.graph.update(["stage1", "stage2", "stage3"].map((stage, index) => ({ presetId: "a", stage, inFlight: index ? 0 : 128 })));
  ui.flush();
  assert.equal(ui.card.runtime.style.top, "48.25px");
  assert.equal(ui.svg.children[0].children.length, 3);
  ui.graph.update([{ presetId: "a", stage: "stage1", inFlight: 128 }]); ui.flush();
  assert.equal(ui.card.runtime.style.top, "50px");
  ui.card.clientTop = 1;
  ui.graph.schedule(); ui.flush();
  assert.equal(ui.card.runtime.style.top, "49px", "absolute top 应扣除卡片边框，使文本屏幕中心与源点中心对齐");
  assert.equal(parseFloat(ui.card.runtime.style.top) + ui.card.clientTop, 50);
  ui.card.ownerDocument.defaultView.getComputedStyle = () => ({ borderTopWidth: "0.666667px" });
  ui.graph.schedule(); ui.flush();
  assert.ok(Math.abs(parseFloat(ui.card.runtime.style.top) + 2 / 3 - 50) < 0.00001,
    "缩放后的亚像素边框不应被 clientTop 的整数舍入破坏对齐");
  ui.card.rect = { left: 0, top: -120, right: 300, bottom: -20, width: 300, height: 100 };
  ui.list.emit("scroll"); ui.list.emit("scroll");
  assert.equal(ui.frames.size, 1);
  ui.flush();
  assert.equal(ui.svg.children[0].children.length, 0);
  assert.equal(ui.svg.children[1].children.length, 0);
  ui.graph.destroy();
});
