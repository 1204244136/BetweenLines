const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createPoolFlowGraph, poolFlowCount, poolFlowWidth, poolFlowLatency, poolFlowCycleSeconds, poolFlowGeometry, poolFlowSourceCenter, poolFlowTooltip,
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

test("每条管道按完成请求样本加权求延迟，周期有界且随延迟单调增加", () => {
  assert.equal(poolFlowLatency({ latencyTotalMs: 3 * 10000 + 100000, latencySamples: 4 }), 32500);
  const cycle = (latency) => poolFlowCycleSeconds({ averageLatencyMs: latency, latencySamples: 1 });
  assert.equal(cycle(30000), 2);
  assert.equal(cycle(120000), 4);
  assert.equal(cycle(0), .9, "真实零毫秒样本仍表示低延迟");
  assert.equal(cycle(3000000), 6);
  assert.ok(cycle(10000) < cycle(30000) && cycle(30000) < cycle(60000));
  for (const value of [{}, { averageLatencyMs: 1 }, { averageLatencyMs: 5000, latencySamples: 0 },
    { latencyTotalMs: -1, latencySamples: 1 }, { averageLatencyMs: Infinity, latencySamples: 3 },
    { averageLatencyMs: 1, latencySamples: .5 }]) {
    assert.equal(poolFlowLatency(value), null);
    assert.equal(poolFlowCycleSeconds(value), 2, "没有可靠样本时使用默认周期");
  }
});

test("悬停展示本条连接的五行状态与平均延迟，不混入共享配额或预设总量", () => {
  const connection = { label: "供应商 / 模型", stage: "stage2", stageLabel: "阶段二 文学复审", inFlight: 8, quota: 64, total: 20 };
  assert.deepEqual(poolFlowTooltip(connection).split("\n"), [
    "预设：供应商 / 模型", "阶段：阶段二 文学复审", "状态：运行中", "当前并发：8", "平均延迟：—",
  ]);
  assert.match(poolFlowTooltip({ ...connection, inFlight: 0, state: "冷却中" }), /状态：冷却中\n当前并发：0\n/);
  assert.match(poolFlowTooltip({ ...connection, state: "停止中" }), /状态：停止中\n当前并发：8\n/);
  assert.match(poolFlowTooltip({ ...connection, inFlight: null, state: "状态未获取" }), /状态：状态未获取\n当前并发：—\n/);
  assert.match(poolFlowTooltip({ ...connection, latencyTotalMs: 65000, latencySamples: 2 }), /平均延迟：32.5 秒$/);
  assert.doesNotMatch(poolFlowTooltip(connection), /64|20|配额|总并发/);
});

test("缺少 SVG 能力的旧页面和 VM DOM 可安全加载", () => {
  const graph = createPoolFlowGraph({ board: { ownerDocument: {} }, svg: {}, list: {} });
  assert.doesNotThrow(() => { graph.update([{ presetId: "a", stage: "stage1" }]); graph.schedule(); graph.destroy(); });
});

function graphFixture() {
  const frames = new Map();
  let frameId = 0;
  const motion = { matches: false, listener: null,
    addEventListener(_name, listener) { this.listener = listener; },
    removeEventListener() { this.listener = null; } };
  const view = {
    innerWidth: 800, innerHeight: 600, performance: { now: () => 100 },
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); }, addEventListener() {}, removeEventListener() {},
    matchMedia: () => motion,
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
      this.htmlWrites = 0; this._html = ""; this.geometryReads = 0; this.attributeWrites = 0;
    }
    set innerHTML(value) { this._html = value; this.htmlWrites += 1; }
    get innerHTML() { return this._html; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); this.attributeWrites += 1; }
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
    getBoundingClientRect() { this.geometryReads += 1; return this.rect; }
    getAnimations() {
      this.animationReads = (this.animationReads || 0) + 1;
      if (!this.animations) this.animations = waveNodes(this).map((wave) => ({
        animationName: "ai-pool-water-surge", effect: { target: wave }, currentTime: 500, playbackRate: 1, rates: [],
        updatePlaybackRate(rate) { this.playbackRate = rate; this.rates.push(rate); },
      }));
      return this.animations;
    }
    querySelector(selector) { return selector === ".ai-pool-preset-actions" ? this.actions : null; }
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
  card.actions = new Element("div");
  list.append(card);
  const stages = Object.fromEntries(["stage1", "stage2", "stage3"].map((stage, index) => [stage,
    new Element("article", { left: 500, top: index * 120, right: 800, bottom: index * 120 + 100, width: 300, height: 100 }),
  ]));
  const graph = createPoolFlowGraph({ board, svg, list, stages });
  const flush = () => { const work = [...frames.values()]; frames.clear(); work.forEach((callback) => callback()); };
  return { board, svg, list, card, stages, graph, flush, frames, motion };
}

function waveNodes(node) {
  return node.children.flatMap((child) => [
    ...(child.attributes.get("class") === "ai-pool-flow-surge" ? [child] : []), ...waveNodes(child),
  ]);
}

function routeGeometryReads(ui) {
  return [ui.list, ui.card, ...Object.values(ui.stages)].filter(Boolean)
    .reduce((count, node) => count + node.geometryReads, 0);
}

function attributeWrites(node) {
  return node.attributeWrites + node.children.reduce((count, child) => count + attributeWrites(child), 0);
}

test("统计轮询的相同管道投影不安排图形帧，也不测量或重写 SVG", () => {
  const ui = graphFixture();
  const connection = { presetId: "a", stage: "stage1", inFlight: 8, label: "A", state: "运行中" };
  ui.graph.update([connection]); ui.flush();
  const reads = routeGeometryReads(ui), writes = attributeWrites(ui.svg);
  ui.graph.update([{ state: "运行中", label: "A", stage: "stage1", presetId: "a", inFlight: "8" }]);
  assert.equal(ui.frames.size, 0, "等价投影不应在每次统计轮询时再进入图形帧");
  ui.flush();
  assert.equal(routeGeometryReads(ui), reads);
  assert.equal(attributeWrites(ui.svg), writes);
  ui.graph.destroy();
});

test("状态提示与平均延迟变化直接更新文本和速率，不重新测量走线几何", () => {
  const ui = graphFixture();
  const connection = { presetId: "a", stage: "stage1", label: "A", inFlight: 8, latencyTotalMs: 30000, latencySamples: 1 };
  ui.graph.update([connection]); ui.flush();
  const group = ui.svg.children[0].children[0], hit = ui.svg.children[1].children[0];
  const animations = group.animations, waves = waveNodes(group);
  hit.emit("pointerenter", { clientX: 380, clientY: 50 });
  const reads = routeGeometryReads(ui);
  const path = hit.attributes.get("d");
  ui.graph.update([{ ...connection, label: "新名称", state: "停止中", latencyTotalMs: 120000 }]); ui.flush();
  assert.equal(routeGeometryReads(ui), reads, "纯数据变化不应量取预设和阶段的位置");
  assert.equal(hit.attributes.get("d"), path);
  assert.equal(group.animations, animations);
  assert.deepEqual(waveNodes(group), waves);
  assert.ok(animations.every((animation) => animation.playbackRate === .5 && animation.currentTime === 500));
  assert.match(hit.attributes.get("aria-label"), /预设：新名称\n/);
  assert.match(ui.board.children[0].textContent, /状态：停止中\n当前并发：8\n平均延迟：120 秒$/);
  ui.graph.destroy();
});

test("已空闲管道不随延迟轮询调速，再运行时在原动画上应用最新速率", () => {
  const ui = graphFixture();
  const connection = { presetId: "a", stage: "stage1", inFlight: 8, latencyTotalMs: 30000, latencySamples: 1 };
  ui.graph.update([connection]); ui.flush();
  const group = ui.svg.children[0].children[0], animations = group.animations, waves = waveNodes(group);
  ui.graph.update([{ ...connection, inFlight: 0 }]); ui.flush();
  const reads = group.animationReads;
  const updates = animations.map((animation) => animation.rates.length);
  ui.graph.update([{ ...connection, inFlight: 0, latencyTotalMs: 120000 }]); ui.flush();
  assert.equal(group.animationReads, reads);
  assert.deepEqual(animations.map((animation) => animation.rates.length), updates, "空闲动画不应继续收到调速写入");
  ui.graph.update([{ ...connection, latencyTotalMs: 120000 }]); ui.flush();
  assert.equal(group.animations, animations);
  assert.deepEqual(waveNodes(group), waves);
  assert.ok(animations.every((animation) => animation.playbackRate === .5 && animation.currentTime === 500));
  ui.graph.destroy();
});

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
  assert.match(tooltip.textContent, /当前并发：128\n/);
  ui.graph.update([{ ...connection, inFlight: 1024 }]); ui.flush();
  assert.equal(ui.svg.children[0].children[0], group);
  assert.equal(ui.svg.children[1].children[0], hit);
  assert.equal(group.htmlWrites, writes);
  assert.match(tooltip.textContent, /当前并发：1024\n/);
  ui.graph.update([{ ...connection, inFlight: 1024, state: "停止中" }]); ui.flush();
  assert.equal(group.htmlWrites, writes);
  assert.match(tooltip.textContent, /状态：停止中\n当前并发：1024\n/);
  ui.graph.update([{ ...connection, inFlight: null, state: "状态未获取" }]); ui.flush();
  assert.match(tooltip.textContent, /状态：状态未获取\n当前并发：—\n/);
  assert.equal(group.classList.contains("is-running"), false);
  hit.emit("pointerleave");
  assert.equal(group.classList.contains("is-hovered"), false);
  assert.equal(tooltip.hidden, true);
  ui.graph.destroy();
});

test("延迟变化仅调已有水流播放速率，重复轮询不重读或重设动画", () => {
  const ui = graphFixture();
  const connection = { presetId: "a", stage: "stage1", inFlight: 32, latencyTotalMs: 300000, latencySamples: 10 };
  ui.graph.update([connection]); ui.flush();
  const group = ui.svg.children[0].children[0];
  const animations = group.animations;
  const waves = waveNodes(group);
  assert.equal(animations.length, 64);
  assert.ok(animations.every((animation) => animation.playbackRate === 1));
  const reads = group.animationReads;
  ui.graph.update([connection]); ui.flush();
  assert.equal(group.animationReads, reads);
  assert.ok(animations.every((animation) => animation.rates.length === 1));
  ui.graph.update([{ ...connection, latencyTotalMs: 1200000 }]); ui.flush();
  assert.equal(group.animations, animations);
  assert.equal(group.style["--flow-width"], poolFlowWidth(32) + "px");
  assert.ok(animations.every((animation) => animation.playbackRate === .5 && animation.currentTime === 500));
  waveNodes(group).forEach((wave, index) => assert.equal(wave, waves[index]));
  ui.graph.destroy();
});

test("减少动态效果恢复后重新取得动画，并恢复同管道的延迟速率", () => {
  const ui = graphFixture();
  ui.graph.update([{ presetId: "a", stage: "stage1", inFlight: 8, latencyTotalMs: 120000, latencySamples: 1 }]); ui.flush();
  const group = ui.svg.children[0].children[0];
  const old = group.animations;
  assert.ok(old.every((animation) => animation.playbackRate === .5));
  ui.motion.matches = true; ui.motion.listener(); ui.flush();
  group.animations = null;
  ui.motion.matches = false; ui.motion.listener(); ui.flush();
  assert.notEqual(group.animations, old);
  assert.ok(group.animations.every((animation) => animation.playbackRate === .5));
  ui.graph.destroy();
  assert.equal(ui.motion.listener, null);
});

test("面板隐藏或动画已取消后，重新取得当前动画并恢复延迟速率", () => {
  const ui = graphFixture();
  ui.graph.update([{ presetId: "a", stage: "stage1", inFlight: 8, latencyTotalMs: 120000, latencySamples: 1 }]); ui.flush();
  const group = ui.svg.children[0].children[0];
  const bounds = ui.board.rect;
  const beforeHide = group.animations;
  ui.board.rect = { ...bounds, width: 0, height: 0 };
  ui.graph.schedule(); ui.flush();
  group.animations = null;
  ui.board.rect = bounds;
  ui.graph.schedule(); ui.flush();
  assert.notEqual(group.animations, beforeHide);
  assert.ok(group.animations.every((animation) => animation.playbackRate === .5));
  const cancelled = group.animations;
  cancelled.forEach((animation) => { animation.playState = "idle"; });
  group.animations = null;
  ui.graph.schedule(); ui.flush();
  assert.notEqual(group.animations, cancelled, "未经历零尺寸回调时，仍能识别已取消的旧动画");
  assert.ok(group.animations.every((animation) => animation.playbackRate === .5));
  ui.graph.destroy();
});

test("正并发数字变化只更新粗细，不替换进行中的水流子树", () => {
  const ui = graphFixture();
  const connection = { presetId: "a", stage: "stage1", label: "A", inFlight: 128 };
  ui.graph.update([connection]); ui.flush();
  const group = ui.svg.children[0].children[0];
  const hit = ui.svg.children[1].children[0];
  const writes = group.htmlWrites;
  const waves = waveNodes(group);
  const phase = group.style["--flow-delay"];
  assert.equal(waves.length, 64, "管道与箭头共用减半的渐变切片预算");
  assert.ok(waves.every((wave) => wave.tag === "path" && !wave.attributes.has("href")), "波包直接绘制路径，避免 SVG 实例树样式开销");
  for (const inFlight of [127, 64, 3, 128]) {
    ui.graph.update([{ ...connection, inFlight }]); ui.flush();
    assert.equal(ui.svg.children[0].children[0], group);
    assert.equal(ui.svg.children[1].children[0], hit);
    assert.equal(group.style["--flow-width"], poolFlowWidth(inFlight) + "px");
    assert.equal(group.classList.contains("is-running"), true);
    assert.equal(group.htmlWrites, writes, "运行数变化不得重建水流子树并打断其动画时间线");
    assert.equal(waveNodes(group).length, waves.length);
    waveNodes(group).forEach((wave, index) => assert.equal(wave, waves[index]));
    assert.ok(waves.every((wave) => wave.attributes.get("d") === hit.attributes.get("d")), "粗细变化后，管道和箭头波包继续沿更新后的连续路径流动");
    assert.equal(group.style["--flow-delay"], phase, "线宽变化不重置水流相位");
  }
  ui.graph.destroy();
});

test("布局重算更新管道路径但保留进行中的水流子树", () => {
  const ui = graphFixture();
  ui.graph.update([{ presetId: "a", stage: "stage1", inFlight: 64 }]); ui.flush();
  const group = ui.svg.children[0].children[0];
  const hit = ui.svg.children[1].children[0];
  const writes = group.htmlWrites;
  const waves = waveNodes(group);
  const before = hit.attributes.get("d");
  ui.card.rect = { ...ui.card.rect, right: 320, width: 320 };
  ui.graph.schedule(); ui.flush();
  assert.notEqual(hit.attributes.get("d"), before, "卡片宽度变化必须更新实际路径");
  assert.equal(ui.svg.children[0].children[0], group);
  assert.equal(ui.svg.children[1].children[0], hit);
  assert.equal(group.htmlWrites, writes, "几何变化不得替换正在运行的水流子树");
  assert.equal(waveNodes(group).length, waves.length);
  waveNodes(group).forEach((wave, index) => assert.equal(wave, waves[index]));
  assert.ok(waves.every((wave) => wave.attributes.get("d") === hit.attributes.get("d")), "布局变化必须同步更新保留下来的直接波包路径");
  ui.graph.destroy();
});

test("其它管道启停不会重排持续运行连接的绘制和命中节点", () => {
  const ui = graphFixture();
  const connections = ["stage1", "stage2", "stage3"].map((stage, index) => ({ presetId: "a", stage, inFlight: index === 1 ? 0 : 32 }));
  ui.graph.update(connections); ui.flush();
  const visuals = [...ui.svg.children[0].children];
  const hits = [...ui.svg.children[1].children];
  for (const inFlight of [1, 0, 32]) {
    ui.graph.update(connections.map((connection, index) => index === 1 ? { ...connection, inFlight } : connection)); ui.flush();
    visuals.forEach((node, index) => assert.equal(ui.svg.children[0].children[index], node));
    hits.forEach((node, index) => assert.equal(ui.svg.children[1].children[index], node));
  }
  ui.graph.destroy();
});

test("空闲与运行切换继续使用真实状态控制虚实及粗细", () => {
  const ui = graphFixture();
  const connection = { presetId: "a", stage: "stage1" };
  for (const inFlight of [0, 64, 0, 32]) {
    ui.graph.update([{ ...connection, inFlight }]); ui.flush();
    const group = ui.svg.children[0].children[0];
    assert.equal(group.classList.contains("is-running"), inFlight > 0);
    assert.equal(group.style["--flow-width"], poolFlowWidth(inFlight) + "px");
  }
  ui.graph.destroy();
});

test("实际生成的圆点变化重算移除与总并发操作组中线，列表滚动隐藏不可见管道", () => {
  const ui = graphFixture();
  ui.graph.update(["stage1", "stage2", "stage3"].map((stage, index) => ({ presetId: "a", stage, inFlight: index ? 0 : 128 })));
  ui.flush();
  assert.equal(ui.card.actions.style.top, "48.25px");
  assert.equal(ui.svg.children[0].children.length, 3);
  ui.graph.update([{ presetId: "a", stage: "stage1", inFlight: 128 }]); ui.flush();
  assert.equal(ui.card.actions.style.top, "50px");
  ui.card.clientTop = 1;
  ui.graph.schedule(); ui.flush();
  assert.equal(ui.card.actions.style.top, "49px", "absolute top 应扣除卡片边框，使操作组屏幕中心与源点中心对齐");
  assert.equal(parseFloat(ui.card.actions.style.top) + ui.card.clientTop, 50);
  ui.card.ownerDocument.defaultView.getComputedStyle = () => ({ borderTopWidth: "0.666667px" });
  ui.graph.schedule(); ui.flush();
  assert.ok(Math.abs(parseFloat(ui.card.actions.style.top) + 2 / 3 - 50) < 0.00001,
    "缩放后的亚像素边框不应被 clientTop 的整数舍入破坏对齐");
  ui.card.rect = { left: 0, top: -120, right: 300, bottom: -20, width: 300, height: 100 };
  ui.list.emit("scroll"); ui.list.emit("scroll");
  assert.equal(ui.frames.size, 1);
  ui.flush();
  assert.equal(ui.svg.children[0].children.length, 0);
  assert.equal(ui.svg.children[1].children.length, 0);
  ui.graph.destroy();
});

function sourceMarkers(ui) {
  return Object.fromEntries(ui.svg.children[2].children
    .filter((node) => node.attributes.get("visibility") === "visible")
    .map((node) => [node.attributes.get("data-stage") + ":" + node.attributes.get("data-direction"), Number(node.attributes.get("data-count"))]));
}

test("阶段入口按真实分工提示上下方隐藏来源，滚动与增高视口实时消除提示", () => {
  const ui = graphFixture();
  const addCard = (id, top) => {
    const card = new ui.card.constructor("div", { ...ui.card.rect, top, bottom: top + 100 });
    card.dataset.presetId = id;
    ui.list.append(card);
    return card;
  };
  const b = addCard("b", 310), c = addCard("c", 420);
  const connections = [
    ...["stage1", "stage2", "stage3"].map((stage) => ({ presetId: "a", stage, inFlight: 64 })),
    { presetId: "b", stage: "stage2" },
    { presetId: "c", stage: "stage1" }, { presetId: "c", stage: "stage3" },
  ];
  ui.graph.update(connections); ui.flush();
  assert.deepEqual(sourceMarkers(ui), { "stage1:below": 1, "stage2:below": 1, "stage3:below": 1 });
  const running = ui.svg.children[0].children[1];
  const animations = running.animations;
  const waves = waveNodes(running);
  const move = (delta) => {
    [ui.card, b, c].forEach((card) => { card.rect = { ...card.rect, top: card.rect.top + delta, bottom: card.rect.bottom + delta }; });
    ui.list.emit("scroll"); ui.flush();
  };
  move(-40);
  assert.deepEqual(sourceMarkers(ui), { "stage1:below": 1, "stage2:below": 1, "stage3:below": 1, "stage1:above": 1 });
  assert.ok(ui.svg.children[0].children.includes(running));
  assert.equal(running.animations, animations, "滚动时仍可见管道的动画必须保持连续");
  assert.deepEqual(waveNodes(running), waves);
  move(-400);
  assert.deepEqual(sourceMarkers(ui), { "stage1:above": 1, "stage2:above": 2, "stage3:above": 1 });
  ui.graph.update(connections.filter((connection) => connection.presetId !== "b")); ui.flush();
  assert.equal(sourceMarkers(ui)["stage2:above"], 1, "取消分工后只统计仍分配的隐藏来源");
  move(440);
  ui.list.rect = { ...ui.list.rect, bottom: 600, height: 600 };
  ui.graph.schedule(); ui.flush();
  assert.deepEqual(sourceMarkers(ui), {}, "扩大视口后不应残留方向提示");
  ui.graph.destroy();
  assert.equal(ui.svg.children.length, 0);
});

test("部分卡片以各条源点可见性提示方向，忽略失效目标与已移除预设", () => {
  const ui = graphFixture();
  ui.card.rect = { ...ui.card.rect, top: -50, bottom: 50 };
  ui.stages.stage3 = null;
  const connections = [
    { presetId: "a", stage: "stage1", inFlight: 128 },
    { presetId: "a", stage: "stage2" },
    { presetId: "a", stage: "stage3" },
    { presetId: "removed", stage: "stage1" },
  ];
  ui.graph.update(connections); ui.flush();
  assert.deepEqual(sourceMarkers(ui), { "stage1:above": 1 });
  assert.equal(ui.svg.children[0].children.length, 1, "仅裁掉上侧端口，保留下侧可见端口");
  const marker = ui.svg.children[2].children[0];
  assert.match(marker.attributes.get("aria-label"), /列表上方还有 1 个预设/);
  ui.card.remove();
  ui.graph.schedule(); ui.flush();
  assert.deepEqual(sourceMarkers(ui), {});
  assert.equal(marker.attributes.get("aria-hidden"), "true");
  ui.graph.destroy();
});
