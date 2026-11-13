function poolFlowCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function poolFlowWidth(value) {
  const count = poolFlowCount(value);
  return count > 0 ? 2.5 + 9.5 * Math.min(128, count) / 128 : 1.5;
}

function poolFlowLatency(connection = {}) {
  const samples = Number(connection.latencySamples);
  if (!Number.isInteger(samples) || samples <= 0) return null;
  const total = Number(connection.latencyTotalMs);
  if (connection.latencyTotalMs != null && Number.isFinite(total) && total >= 0) return total / samples;
  const average = Number(connection.averageLatencyMs);
  return connection.averageLatencyMs != null && Number.isFinite(average) && average >= 0 ? average : null;
}

function poolFlowCycleSeconds(connection) {
  const latency = poolFlowLatency(connection);
  return latency === null ? 2 : Math.max(.9, Math.min(6, 2 * Math.sqrt(latency / 30000)));
}

function poolFlowGeometry({ x1, y1, x2, y2, inFlight }) {
  const running = poolFlowCount(inFlight) > 0;
  const width = poolFlowWidth(inFlight);
  const control = (x2 - x1) * .5;
  const arrowHalf = running ? Math.max(4, width * .65 + 1.5) : 3;
  const arrowDepth = running ? Math.max(8, arrowHalf * 1.55) : 7;
  const arrowBase = x2 - arrowDepth;
  const path = `M ${x1} ${y1} C ${x1 + control} ${y1}, ${x2 - control} ${y2}, ${arrowBase} ${y2}`;
  return {
    x1, y1, x2, y2, width, arrowHalf, arrowBase,
    radius: running ? Math.max(3, width / 2) : 2.5,
    path,
    flowPath: `${path} L ${x2} ${y2}`,
    arrowPath: `M ${x2} ${y2} l ${-arrowDepth} ${-arrowHalf} v ${2 * arrowHalf} z`,
  };
}

function poolFlowSourceCenter(ports, fallback = 0) {
  if (!ports.length) return fallback;
  return (Math.min(...ports.map((port) => port.y1 - port.radius))
    + Math.max(...ports.map((port) => port.y1 + port.radius))) / 2;
}

function poolFlowTooltip(connection) {
  const inFlight = connection.inFlight == null ? null : poolFlowCount(connection.inFlight);
  const latency = poolFlowLatency(connection);
  const latencyText = latency === null ? "—" : latency < 1000 ? Math.round(latency) + " ms"
    : (latency / 1000).toFixed(1).replace(/\.0$/, "") + " 秒";
  const state = String(connection.state || (inFlight > 0 ? "运行中" : inFlight === null ? "状态未获取" : "已分配 · 空闲"));
  return [
    "预设：" + String(connection.label || connection.presetId || ""),
    "阶段：" + String(connection.stageLabel || connection.stage || ""),
    "状态：" + state,
    "当前并发：" + (inFlight === null ? "—" : inFlight),
    "平均延迟：" + latencyText,
  ].join("\n");
}

function createPoolFlowGraph({ board, svg, list, stages } = {}) {
  const noop = { update() {}, schedule() {}, destroy() {} };
  const doc = board?.ownerDocument;
  if (!board || !svg || !list || !doc?.createElementNS || !board.getBoundingClientRect
    || !svg.getBoundingClientRect || !svg.classList || typeof svg.getScreenCTM !== "function") return noop;
  const view = doc.defaultView || globalThis;
  const motion = view.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
  const requestFrame = view.requestAnimationFrame?.bind(view) || ((callback) => view.setTimeout(callback, 16));
  const cancelFrame = view.cancelAnimationFrame?.bind(view) || view.clearTimeout.bind(view);
  const ns = "http://www.w3.org/2000/svg";
  const prefix = "ai-pool-flow-" + (createPoolFlowGraph.nextId = (createPoolFlowGraph.nextId || 0) + 1);
  const makeSvg = (name, attributes = {}) => {
    const node = doc.createElementNS(ns, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };
  const visuals = makeSvg("g", { "aria-hidden": "true" });
  const hits = makeSvg("g");
  svg.append(visuals, hits);
  const tooltip = doc.createElement("div");
  tooltip.className = "ai-pool-flow-tooltip";
  tooltip.id = prefix + "-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  board.append(tooltip);
  const entries = new Map();
  let connections = [];
  let hovered = null;
  let pointer = null;
  let frame = 0;
  let serial = 0;
  let destroyed = false;

  function closeTooltip() {
    if (hovered) {
      hovered.group.classList.remove("is-hovered");
      hovered.hit.removeAttribute("aria-describedby");
    }
    hovered = null;
    pointer = null;
    tooltip.hidden = true;
  }

  function positionTooltip() {
    if (!hovered || !pointer) return;
    const bounds = board.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const viewportWidth = Number(view.innerWidth) || bounds.right;
    const viewportHeight = Number(view.innerHeight) || bounds.bottom;
    const minX = Math.max(4, 4 - bounds.left);
    const maxX = Math.max(minX, Math.min(bounds.width - 4, viewportWidth - bounds.left - 4) - box.width);
    const minY = Math.max(4, 4 - bounds.top);
    const maxY = Math.max(minY, Math.min(bounds.height - 4, viewportHeight - bounds.top - 4) - box.height);
    const left = Math.max(minX, Math.min(maxX, pointer.x - bounds.left + 12));
    let top = pointer.y - bounds.top + 12;
    if (top > maxY) top = pointer.y - bounds.top - box.height - 12;
    tooltip.style.left = left + "px";
    tooltip.style.top = Math.max(minY, Math.min(maxY, top)) + "px";
  }

  function refreshTooltip() {
    if (!hovered) return;
    tooltip.textContent = poolFlowTooltip(hovered.connection);
    positionTooltip();
  }

  function showTooltip(entry, event) {
    if (hovered !== entry) {
      closeTooltip();
      hovered = entry;
      entry.group.classList.add("is-hovered");
      entry.hit.setAttribute("aria-describedby", tooltip.id);
    }
    if (event && Number.isFinite(event.clientX)) pointer = { x: event.clientX, y: event.clientY };
    else {
      const bounds = entry.hit.getBoundingClientRect();
      pointer = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    }
    tooltip.hidden = false;
    refreshTooltip();
  }

  function createEntry(key) {
    const group = makeSvg("g", { class: "ai-pool-flow-connection" });
    const hit = makeSvg("path", { class: "ai-pool-flow-hit", fill: "none", stroke: "transparent", tabindex: "0", role: "img" });
    const clipId = prefix + "-" + ++serial;
    const flow = makeSvg("path", { id: clipId + "-flow", pathLength: "1000" });
    const rect = makeSvg("rect", { x: "0", y: "-20" });
    const arrowShape = makeSvg("path");
    const pipeClip = makeSvg("clipPath", { id: clipId + "-pipe", clipPathUnits: "userSpaceOnUse" });
    const arrowClip = makeSvg("clipPath", { id: clipId + "-arrow", clipPathUnits: "userSpaceOnUse" });
    pipeClip.append(rect); arrowClip.append(arrowShape);
    const defs = makeSvg("defs");
    defs.append(flow, pipeClip, arrowClip);
    const pipe = makeSvg("g", { class: "ai-pool-flow-pipe", "clip-path": `url(#${clipId}-pipe)` });
    const line = makeSvg("path", { class: "ai-pool-flow-line" });
    const pipeWave = makeSvg("g", { class: "ai-pool-flow-wave" });
    pipe.append(line, pipeWave);
    const port = makeSvg("circle", { class: "ai-pool-flow-port" });
    const arrow = makeSvg("path", { class: "ai-pool-flow-arrow" });
    const arrowWave = makeSvg("g", { class: "ai-pool-flow-arrow-surge ai-pool-flow-wave", "clip-path": `url(#${clipId}-arrow)` });
    group.append(defs, pipe, port, arrow, arrowWave);
    const entry = {
      key, group, hit, clipId, signature: "", label: "", connection: null, wavesReady: false,
      animations: null, playbackRate: null,
      flow, rect, arrowShape, line, pipeWave, port, arrow, arrowWave,
    };
    hit.addEventListener("pointerenter", (event) => showTooltip(entry, event));
    hit.addEventListener("pointermove", (event) => showTooltip(entry, event));
    hit.addEventListener("pointerleave", () => { if (hovered === entry) closeTooltip(); });
    hit.addEventListener("focus", () => showTooltip(entry));
    hit.addEventListener("blur", () => { if (hovered === entry) closeTooltip(); });
    hit.addEventListener("keydown", (event) => { if (event.key === "Escape") closeTooltip(); });
    entries.set(key, entry);
    return entry;
  }

  function createWaves(entry, index) {
    const phase = -(((view.performance?.now?.() || Date.now()) / 1000 + index * .25) % 2);
    entry.group.style.setProperty("--flow-delay", phase + "s");
    const step = 340 / 64;
    for (let slice = 0; slice < 64; slice++) {
      const t = (slice + .5) / 64;
      const strength = t < .82 ? Math.pow(t / .82, 1.7) : Math.pow((1 - t) / .18, .7);
      const start = 340 - slice * step;
      for (const layer of [entry.pipeWave, entry.arrowWave]) {
        const wave = makeSvg("use", { class: "ai-pool-flow-surge", href: `#${entry.clipId}-flow` });
        wave.style.setProperty("--flow-step", step + .12);
        wave.style.setProperty("--flow-opacity", strength);
        wave.style.setProperty("--flow-start", start);
        wave.style.setProperty("--flow-end", start - 1400);
        layer.append(wave);
      }
    }
    entry.wavesReady = true;
  }

  function renderEntry(entry, geometry, bounds, index) {
    const { path, flowPath, arrowPath, width, radius, arrowHalf, arrowBase, x1, y1 } = geometry;
    const running = poolFlowCount(entry.connection.inFlight) > 0;
    const signature = JSON.stringify([path, width, radius, arrowPath, bounds.height, running]);
    const label = poolFlowTooltip(entry.connection);
    if (label !== entry.label) { entry.hit.setAttribute("aria-label", label); entry.label = label; }
    if (signature === entry.signature) return;
    entry.signature = signature;
    entry.group.classList.toggle("is-running", running);
    entry.group.style.setProperty("--flow-width", width + "px");
    entry.hit.setAttribute("d", flowPath);
    entry.hit.setAttribute("stroke-width", String(Math.max(16, width + 6)));
    entry.flow.setAttribute("d", flowPath);
    entry.line.setAttribute("d", path);
    entry.rect.setAttribute("width", String(arrowBase));
    entry.rect.setAttribute("height", String(bounds.height + 40));
    entry.arrowShape.setAttribute("d", arrowPath);
    entry.port.setAttribute("cx", String(x1));
    entry.port.setAttribute("cy", String(y1));
    entry.port.setAttribute("r", String(radius));
    entry.arrow.setAttribute("d", arrowPath);
    entry.arrowWave.style.setProperty("--flow-width", (2 * arrowHalf + 2) + "px");
    if (running && !entry.wavesReady) createWaves(entry, index);
  }

  function syncAnimationRates(shown) {
    const updates = [];
    for (const entry of shown) {
      if (!entry.wavesReady || typeof entry.group.getAnimations !== "function") continue;
      if (motion?.matches) { entry.animations = null; entry.playbackRate = null; continue; }
      if (entry.animations?.some((animation) => animation.playState === "idle")) {
        entry.animations = null; entry.playbackRate = null;
      }
      const rate = 2 / poolFlowCycleSeconds(entry.connection);
      if (entry.playbackRate === rate && entry.animations?.length) continue;
      const animations = entry.animations?.length ? entry.animations : entry.group.getAnimations({ subtree: true })
        .filter((animation) => animation.animationName === "ai-pool-water-surge" && typeof animation.updatePlaybackRate === "function");
      if (animations.length) updates.push({ entry, animations, rate });
    }
    for (const { entry, animations, rate } of updates) {
      animations.forEach((animation) => animation.updatePlaybackRate(rate));
      entry.animations = animations;
      entry.playbackRate = rate;
    }
  }

  function onMotionChange() {
    entries.forEach((entry) => { entry.animations = null; entry.playbackRate = null; });
    schedule();
  }

  function draw() {
    frame = 0;
    if (destroyed) return;
    const bounds = board.getBoundingClientRect();
    if (!(bounds.width > 0 && bounds.height > 0)) {
      closeTooltip();
      entries.forEach((entry) => { entry.animations = null; entry.playbackRate = null; });
      return;
    }
    svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
    const cards = new Map(Array.from(list.children).filter((node) => node.dataset?.presetId)
      .map((node) => [node.dataset.presetId, { node, rect: node.getBoundingClientRect(), ports: [] }]));
    const listBounds = list.getBoundingClientRect();
    const available = connections.filter((connection) => {
      const card = cards.get(connection.presetId);
      return card && stages?.[connection.stage] && card.rect.bottom > listBounds.top && card.rect.top < listBounds.bottom;
    });
    const outgoing = new Map(), incoming = new Map();
    available.forEach((connection) => {
      if (!outgoing.has(connection.presetId)) outgoing.set(connection.presetId, []);
      if (!incoming.has(connection.stage)) incoming.set(connection.stage, []);
      outgoing.get(connection.presetId).push(connection);
      incoming.get(connection.stage).push(connection);
    });
    const shown = [];
    available.forEach((connection) => {
      const card = cards.get(connection.presetId);
      const target = stages[connection.stage].getBoundingClientRect();
      if (!(card.rect.width > 0 && card.rect.height > 0 && target.width > 0 && target.height > 0)) return;
      const x1 = card.rect.right - bounds.left, x2 = target.left - bounds.left;
      if (x2 <= x1 + 20) return;
      const sourceConnections = outgoing.get(connection.presetId);
      const targetConnections = incoming.get(connection.stage);
      const geometry = poolFlowGeometry({ x1, x2,
        y1: card.rect.top + card.rect.height / 2 - bounds.top + (sourceConnections.indexOf(connection) - (sourceConnections.length - 1) / 2) * 16,
        y2: target.top + target.height / 2 - bounds.top + (targetConnections.indexOf(connection) - (targetConnections.length - 1) / 2) * 14,
        inFlight: connection.inFlight,
      });
      if (geometry.y1 - geometry.radius < listBounds.top - bounds.top
        || geometry.y1 + geometry.radius > listBounds.bottom - bounds.top) return;
      const key = String(connection.key || connection.presetId + ":" + connection.stage);
      const entry = entries.get(key) || createEntry(key);
      entry.connection = connection;
      card.ports.push(geometry);
      renderEntry(entry, geometry, bounds, shown.length);
      shown.push(entry);
    });
    cards.forEach(({ node, rect, ports }) => {
      const actions = node.querySelector(".ai-pool-preset-actions");
      const measuredBorder = parseFloat(view.getComputedStyle?.(node)?.borderTopWidth);
      const border = Number.isFinite(measuredBorder) ? measuredBorder : (Number(node.clientTop) || 0);
      if (actions) actions.style.top = (poolFlowSourceCenter(ports, rect.top + rect.height / 2 - bounds.top) - rect.top + bounds.top - border) + "px";
    });
    const keys = new Set(shown.map((entry) => entry.key));
    entries.forEach((entry, key) => {
      if (keys.has(key)) return;
      if (hovered === entry) closeTooltip();
      entry.group.remove(); entry.hit.remove(); entries.delete(key);
    });
    shown.forEach((entry) => {
      if (entry.group.parentNode !== visuals) visuals.append(entry.group);
      if (entry.hit.parentNode !== hits) hits.append(entry.hit);
    });
    syncAnimationRates(shown);
    refreshTooltip();
  }

  function schedule() {
    if (!destroyed && !frame) frame = requestFrame(draw);
  }

  const observer = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(schedule) : null;
  [board, list, ...Object.values(stages || {})].forEach((node) => { if (node) observer?.observe(node); });
  view.addEventListener?.("resize", schedule);
  if (motion?.addEventListener) motion.addEventListener("change", onMotionChange);
  else motion?.addListener?.(onMotionChange);
  list.addEventListener("scroll", schedule, { passive: true });
  board.addEventListener("pointerleave", closeTooltip);
  return {
    update(next) {
      const seen = new Set();
      connections = (Array.isArray(next) ? next : []).filter((connection) => {
        if (!connection?.presetId || !connection.stage) return false;
        const key = String(connection.key || connection.presetId + ":" + connection.stage);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map((connection) => ({ ...connection, inFlight: connection.inFlight == null ? null : poolFlowCount(connection.inFlight) }));
      if (hovered) {
        const current = connections.find((connection) => String(connection.key || connection.presetId + ":" + connection.stage) === hovered.key);
        if (current) { hovered.connection = current; refreshTooltip(); }
        else closeTooltip();
      }
      schedule();
    },
    schedule,
    destroy() {
      destroyed = true;
      if (frame) cancelFrame(frame);
      observer?.disconnect();
      view.removeEventListener?.("resize", schedule);
      if (motion?.removeEventListener) motion.removeEventListener("change", onMotionChange);
      else motion?.removeListener?.(onMotionChange);
      list.removeEventListener("scroll", schedule);
      board.removeEventListener("pointerleave", closeTooltip);
      closeTooltip(); visuals.remove(); hits.remove(); tooltip.remove(); entries.clear();
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createPoolFlowGraph, poolFlowCount, poolFlowWidth, poolFlowLatency, poolFlowCycleSeconds, poolFlowGeometry, poolFlowSourceCenter, poolFlowTooltip };
}
