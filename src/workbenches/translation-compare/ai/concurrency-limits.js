// AI 校对的并发边界：本模块是唯一权威来源。
//
// 历史上主并发被硬编码在 1~12，用户填 20 会被静默压回去；预设清洗那条路径更狠——
// 越界不是截断而是直接回落到默认值 3，导致「我选了 20，实际变成 3」且没有任何提示。
// 这里统一放开到 32（与 src/ai/task-queue.js 的上限一致），下界仍保留 1，
// 避免误填 0 或负数时把任务队列卡死。
//
// 注意：ai-presets.js 的 createPresetTools 会被 toString() 注入浏览器页面，不能引用
// 本模块作用域，因此它在函数内自带一份同值字面量；两边的边界行为由
// scripts/ai-smart-concurrency.test.js 的边界断言锁死，改这里必须同步改那边。
const AI_CONCURRENCY_LIMITS = {
  // 并发下界：低于 1 的并发没有意义，且会让队列永远排不出任务。
  min: 1,
  // 主并发与各阶段并发（初审、文学复审、终审仲裁）共用的上界。
  max: 32,
  // 智能并发的上探上界，与主并发同档，避免"上限被压到主并发以下"的隐性截断。
  maxSmart: 32,
  // 未显式配置时的默认值，保持既有行为不变。
  defaultConcurrency: 3,
  defaultMax: 10,
};

module.exports = { AI_CONCURRENCY_LIMITS };
