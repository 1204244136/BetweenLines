const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizePresetPool, createPresetPool, assignPendingPresetIds } = require("../src/workbenches/translation-compare/ai/preset-pool");

test("预设池归一化并保留独立并发上限", () => {
  const pool = normalizePresetPool([{ id: "fast", concurrency: 8 }, { presetId: "strict", name: "严格", concurrency: 2 }]);
  assert.deepEqual(pool.map((item) => [item.presetId, item.concurrency]), [["fast", 8], ["strict", 2]]);
});

test("预设池按负载选择并根据结果动态调整配额", () => {
  const scheduler = createPresetPool([
    { id: "fast", concurrency: 4 },
    { id: "strict", concurrency: 2 },
  ]);
  scheduler.setPending({ fast: 3, strict: 3 });
  const first = scheduler.next();
  assert.ok(first);
  scheduler.begin(first.presetId, 1);
  scheduler.finish(first.presetId, 1, { ok: false });
  const after = scheduler.snapshot().find((item) => item.presetId === first.presetId);
  assert.equal(after.quota, 2);
  assert.ok(scheduler.snapshot().every((item) => item.activeRows.length === 0));
});

test("预设池为新增队列项分配各自预设，避免后续任务全部落到第一个预设", () => {
  const scheduler = createPresetPool([
    { id: "fast", concurrency: 8 },
    { id: "strict", concurrency: 2 },
    { id: "backup", concurrency: 4 },
  ]);
  const items = [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }, { index: 5 }];
  const counts = assignPendingPresetIds(scheduler, items);

  assert.deepEqual(items.map((item) => item.presetId), ["fast", "strict", "backup", "fast", "strict"]);
  assert.deepEqual(counts, { fast: 2, strict: 2, backup: 1 });
  assert.deepEqual(scheduler.snapshot().map((item) => item.pending), [2, 2, 1]);

  const later = [{ index: 6 }, { index: 7 }];
  assignPendingPresetIds(scheduler, items.concat(later));
  assert.deepEqual(later.map((item) => item.presetId), ["backup", "fast"]);
});

test("预设池：注入并发通道后，配额取各通道当前并发，阶段总并发是各通道之和", () => {
  const channels = new Map();
  const pool = createPresetPool(
    [{ id: "p1", concurrency: 3 }, { id: "p2", concurrency: 5 }],
    null,
    {
      createChannel: (preset, index, total) => {
        const channel = {
          presetId: preset.presetId,
          currentConcurrency: 2,
          initialConcurrency: 2,
          maxConcurrency: preset.concurrency,
          presetLabel: `${preset.name} ${index + 1}/${total}`,
        };
        channels.set(preset.presetId, channel);
        return channel;
      },
    }
  );

  assert.equal(pool.totalQuota(), 4, "总并发 = 各通道当前允许并发之和");
  assert.equal(pool.totalInitialQuota(), 4);
  assert.equal(pool.totalMaxQuota(), 8, "上限之和 = 各预设自己的并发上限之和");
  assert.equal(pool.channelOf("p1"), channels.get("p1"));
  assert.equal(pool.channels().length, 2);
  assert.deepEqual(pool.snapshot().map((item) => item.quota), [2, 2], "运行状态里的配额就是通道当前并发");
  // 通道是活对象（含定时器与 Map），绝不能跟着状态接口序列化出去。
  assert.deepEqual(Object.keys(pool.snapshot()[0]).includes("channel"), false);

  // 派发按通道各自的余量走：p1 只允许 2 个在飞，p2 允许 5 个，加起来就是阶段可派发量。
  channels.get("p2").currentConcurrency = 5;
  assert.equal(pool.totalQuota(), 7);
  pool.setPending({ p1: 10, p2: 10 });
  const dispatched = [];
  for (let i = 0; i < 10; i += 1) {
    const item = pool.next();
    if (!item) break;
    dispatched.push(item.presetId);
    pool.begin(item.presetId, i + 1);
  }
  const counts = dispatched.reduce((acc, id) => ({ ...acc, [id]: (acc[id] || 0) + 1 }), {});
  assert.equal(counts.p1, 2, "p1 的通道只允许 2 个在飞");
  assert.equal(counts.p2, 5, "p2 的通道允许 5 个在飞");
  assert.equal(dispatched.length, 7, "同时派出的总量等于各通道余量之和");

  // 挂了通道的预设，配额升降由通道（concurrency-controller）负责，池内不再自算一套 ±1。
  pool.finish("p1", 1, { ok: false });
  assert.equal(channels.get("p1").currentConcurrency, 2, "通道配额不被池内的失败下调改动");
  assert.equal(pool.snapshot().find((item) => item.presetId === "p1").quota, 2);
});

test("预设池：不注入通道时仍按池内配额自适应（纯单测与旧调用方）", () => {
  const scheduler = createPresetPool([{ id: "solo", concurrency: 6 }]);
  assert.equal(scheduler.totalQuota(), 3, "起步配额仍是 min(上限, 3)");
  assert.equal(scheduler.totalMaxQuota(), 6);
  scheduler.setPending({ solo: 5 });
  scheduler.begin("solo", 1);
  scheduler.finish("solo", 1, { ok: true });
  assert.equal(scheduler.snapshot()[0].quota, 3);
});

test("预设池热更新：运行中增删预设会递增版本，并随数量刷新日志用的预设名", () => {
  const channels = new Map();
  const pool = createPresetPool([{ id: "p1", name: "甲", concurrency: 4 }], null, {
    createChannel: (preset) => {
      const channel = {
        currentConcurrency: 2,
        initialConcurrency: 2,
        maxConcurrency: preset.concurrency,
        presetLabel: "",
      };
      channels.set(preset.presetId, channel);
      return channel;
    },
  });

  assert.deepEqual(pool.presets.map((item) => item.presetId), ["p1"]);
  assert.equal(channels.get("p1").presetLabel, "", "单预设不写预设名前缀");
  const versionBefore = pool.version;

  const added = pool.addPreset({ id: "p2", name: "乙", concurrency: 8 });
  assert.equal(added.presetId, "p2");
  assert.ok(pool.version > versionBefore, "增删预设必须让版本前进，调用方才知道要整队重算");
  assert.deepEqual(pool.presets.map((item) => item.presetId), ["p1", "p2"]);
  assert.equal(pool.totalQuota(), 4, "总并发立刻加上新通道的配额");
  assert.equal(pool.totalMaxQuota(), 12);
  assert.equal(channels.get("p1").presetLabel, "甲", "多预设时日志要带预设名");
  assert.equal(channels.get("p2").presetLabel, "乙");

  // 重复加入同一个预设是幂等的：不能出现两条同名通道。
  assert.equal(pool.addPreset({ id: "p2", name: "乙", concurrency: 8 }).presetId, "p2");
  assert.equal(pool.presets.length, 2);

  assert.equal(pool.removePreset("p1"), true);
  assert.equal(pool.removePreset("p1"), false, "重复移除返回 false");
  assert.deepEqual(pool.presets.map((item) => item.presetId), ["p2"]);
  assert.equal(pool.totalQuota(), 2);
  assert.equal(channels.get("p2").presetLabel, "", "删到只剩一个时去掉预设名前缀");
});

test("预设池热更新：整队重算时新预设立刻分到活，被删预设的绑定被清掉", () => {
  const pool = createPresetPool([{ id: "pa", concurrency: 2 }, { id: "pb", concurrency: 2 }]);
  const items = [{ index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }];
  assignPendingPresetIds(pool, items);
  assert.deepEqual(items.map((item) => item.presetId), ["pa", "pb", "pa", "pb"]);

  // 稳态（预设集合没变）不重算：已有绑定保持不动。
  assignPendingPresetIds(pool, items);
  assert.deepEqual(items.map((item) => item.presetId), ["pa", "pb", "pa", "pb"]);

  // 运行中加入 pc：整队重算后四条待审行分摊到三个预设，新预设立刻有活。
  pool.addPreset({ id: "pc", concurrency: 2 });
  const counts = assignPendingPresetIds(pool, items, { reassign: true });
  assert.deepEqual(counts, { pa: 2, pb: 1, pc: 1 });
  assert.equal(items.filter((item) => item.presetId === "pc").length, 1, "新预设要立刻分到活");

  // 运行中删掉 pa：不能留下已删预设的绑定，否则它的待审行会永远派不出去。
  pool.removePreset("pa");
  assignPendingPresetIds(pool, items, { reassign: true });
  assert.equal(items.some((item) => item.presetId === "pa"), false);
  assert.deepEqual([...new Set(items.map((item) => item.presetId))].sort(), ["pb", "pc"]);

  // 预设全被删光：残留绑定要清掉，不能拿旧 id 去找一条不存在的通道。
  pool.removePreset("pb");
  pool.removePreset("pc");
  assignPendingPresetIds(pool, items, { reassign: true });
  assert.equal(items.some((item) => "presetId" in item), false);
});
