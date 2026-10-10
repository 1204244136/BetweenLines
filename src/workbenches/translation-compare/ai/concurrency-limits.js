// AI 校对的并发边界：本模块是唯一权威来源。
//
// 这里只有两件事：下界 1，以及把非有限值折算成默认值。**没有并发上限硬顶**——用户填多少
// 就是多少。安全网由自适应调度（起步 min(上限, 3)、慢启动翻倍上探）与熔断（错误率 /
// 限流饱和即终止）承担，配置层不再截断。
//
// 这道天花板历史上走过两轮：先是硬编码 1~12，用户填 20 被静默压回去；后来统一放开到 32。
// 32 在熔断机制完善后已经失去意义——它只拦得住用户主动选择的高并发，而且拦得没有提示
// （填 64 实际跑 32，页面上仍写着 64）。因此边界只保留「下界 + 合法性」。
//
// 面板上只有一个「并发上限」输入：实际并发由调度器（concurrency-controller.js）在 1~上限 之间自动升降，
// 用户填的数字只决定天花板。因此这里只有一套边界，不再区分「主并发」与「智能并发上限」。
//
// 注意：ai-presets.js 的 createPresetTools 会被 toString() 注入浏览器页面，不能引用
// 本模块作用域，因此它在函数内自带一份同值字面量；两边的边界行为由
// scripts/ai-smart-concurrency.test.js 的边界断言锁死，改这里必须同步改那边。
const AI_CONCURRENCY_LIMITS = {
  // 并发下界：低于 1 的并发没有意义，且会让队列永远排不出任务。
  min: 1,
  // 算术护栏，不是业务上限：给各 clamp 调用点挡住 Infinity / NaN 传播，
  // 任何配置路径都不得把用户输入压到它以下（面板输入框也不再渲染 max 属性）。
  max: Number.MAX_SAFE_INTEGER,
  // 未显式配置时的并发上限，保持既有行为不变（默认 3 也恰好等于起步并发，即默认不需要上探）。
  defaultConcurrency: 3,
};

function clampCap(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(AI_CONCURRENCY_LIMITS.min, Math.min(AI_CONCURRENCY_LIMITS.max, Math.round(number)));
}

// 归一化「并发上限」。
//
// 旧客户端（已发布快照里内联的旧脚本、旧预设、旧本地存档）还会带 smartConcurrency + concurrencyMax：
// 当时开启智能并发的有效上限是 max(初始并发, concurrencyMax)，关闭时就是 concurrency 本身。
// 这里把两种旧口径折算成同一个上限，让旧数据无需迁移脚本即可继续按原来的天花板运行。
function resolveConcurrencyCap(input, fallback = AI_CONCURRENCY_LIMITS.defaultConcurrency) {
  const source = input && typeof input === "object" ? input : {};
  const base = source.concurrency == null ? fallback : clampCap(source.concurrency, fallback);
  if (source.smartConcurrency === true && source.concurrencyMax != null) {
    return Math.max(base, clampCap(source.concurrencyMax, base));
  }
  return base;
}

module.exports = { AI_CONCURRENCY_LIMITS, resolveConcurrencyCap };
