/**
 * AI 异常归类：把一次模型调用的失败原因收敛到有限的几类，供阶段看板的「异常」指标悬停展示。
 *
 * 为什么要共享：服务端拿到的是带 code/httpStatus 的 error 对象，客户端只能从备注文本反推，
 * 但「异常」这个数字在两边是同一个口径（服务端 stageMetrics 与客户端备注统计取 max）。
 * 分类规则各写一份必然漂移，于是这里做成纯函数模块：服务端直接 require，
 * 构建器（render-workbench.js）再把纯函数与常量序列化进页面，两端只有这一份规则。
 *
 * 约束：这些函数会被 .toString() 注入浏览器，函数体不得捕获模块私有依赖——
 * 它们只允许引用本文件导出的常量（注入时同样作为页面常量输出）。
 */

/** 分类展示顺序：越靠前越常见、越该被用户先看到。 */
const AI_ERROR_KIND_ORDER = [
  "rate_limit",
  "timeout",
  "auth",
  "not_found",
  "server_error",
  "bad_response",
  "network",
  "config",
  "refusal",
  "stopped",
  "unknown",
];

const AI_ERROR_KIND_LABELS = {
  rate_limit: "频控限流",
  timeout: "请求超时",
  auth: "认证失败",
  not_found: "模型或端点不存在",
  server_error: "服务端错误",
  bad_response: "响应格式异常",
  network: "网络连接失败",
  config: "接口配置缺失",
  refusal: "模型拒答",
  stopped: "任务已终止",
  unknown: "其他错误",
};

/** 每类异常最多留多少个行号样本：行号是两端口径合并时的去重键，不是给人看的台账。 */
const AI_ERROR_ROW_SAMPLE_LIMIT = 200;
/** 明细里样本错误消息的截断长度：样本随状态接口回报，不进入悬停文本。 */
const AI_ERROR_SAMPLE_DISPLAY_LIMIT = 120;

/**
 * 归类一条失败原因。入参可以是 error 对象（服务端），也可以是备注/日志文本（客户端）。
 * 判定顺序与服务端的既有语义对齐：拒答不算故障、503/529 算频控而非 5xx、非 JSON 响应优先于网络故障。
 */
function classifyAiError(input) {
  if (input === null || input === undefined) return "unknown";
  const isObject = typeof input === "object";
  const code = String((isObject ? (input.code || input.errorCode) : "") || "").toUpperCase();
  const httpStatus = isObject ? Number(input.httpStatus || input.status || input.statusCode) || 0 : 0;
  const text = String(isObject
    ? (input.message || input.error?.message || input.responseBody || input.error || "")
    : input);
  const haystack = `${code} ${text}`.toLowerCase();
  // 客户端只有备注文本、拿不到 httpStatus，用消息里的三位状态码兜底（错误文本里的 4xx/5xx 基本就是它）。
  const statusFromText = Number((haystack.match(/\b(4\d\d|5\d\d)\b/) || [])[1]) || 0;
  const status = httpStatus || statusFromText;

  // 1. 用户主动终止：不是故障，但备注口径把它记成失败行，单列一类以免与真实错误混淆。
  if (/校对已终止|任务已终止|已终止|stoprequested/.test(haystack)) return "stopped";
  if (code === "ACCOUNT_RESTRICTED" || /账号访问受限[:：]/.test(text)) return "auth";
  // 2. 模型拒答（内容安全审查）：上游正常应答，不是接口故障。
  if (code === "MODEL_REFUSAL" || code === "CONTENT_FILTER") return "refusal";
  if (/拒答|内容安全|content_filter|content management policy|responsible ai|safety policy|policy violation|declined to answer|敏感内容/.test(haystack)) {
    return "refusal";
  }
  // 3. 频控限流：429/503/529 与服务端 isConcurrencyOrRateLimitError 同口径（503/529 算过载，不算 5xx）。
  if (status === 429 || status === 503 || status === 529) return "rate_limit";
  if (/rate_limit|rate limit|too many requests|resource_exhausted|overloaded|concurrency_limit|频控|限流|频次超限|并发超限|额度不足|额度频控|重试上限|速率限制|负载过高|请求受限|服务暂时不可用/.test(haystack)) {
    return "rate_limit";
  }
  // 4. 超时
  if (/request_timeout|etimedout|timeout|超时/.test(haystack)) return "timeout";
  // 5. 认证 / 授权
  if (status === 401 || status === 403) return "auth";
  if (/unauthorized|forbidden|认证失败|api key|无权限|访问受限|权限不足/.test(haystack)) return "auth";
  // 6. 模型或端点不存在
  if (status === 404) return "not_found";
  if (/not_found|模型或端点不存在|端点不存在|模型不存在|接口路径/.test(haystack)) return "not_found";
  // 7. 响应格式异常：必须早于网络判断，否则「网关返回 HTML」会被归成网络故障。
  //    这里只认「响应/JSON 解析失败」这类限定说法：裸的「解析失败」会误吞 DNS 的「域名解析失败」。
  if (/invalid_json_response|非 ?json|json\s*解析失败|响应解析失败|响应格式|不是有效的 ?json/.test(haystack)) return "bad_response";
  // 8. 服务端 5xx（503/529 已在频控里归口）
  if (status >= 500) return "server_error";
  if (/server_error|服务端异常|服务端错误|内部发生错误|internal server error|http 5\d\d/.test(haystack)) return "server_error";
  // 9. 网络层
  if (code === "STREAM_INTERRUPTED"
    || /stream interrupted|响应流中断|econnrefused|enotfound|econnreset|eai_again|ehostunreach|fetch failed|socket hang up|连接被拒|域名解析|无法连接|网络|network error/.test(haystack)) {
    return "network";
  }
  // 10. 配置缺失
  if (/missing_base_url|missing_model|stage2_config_missing|stage3_config_missing|未填写接口地址|未选择或填写模型|未配置|配置缺失/.test(haystack)) {
    return "config";
  }
  return "unknown";
}

/** 登记一条异常行号：kinds 形如 { [kind]: { count, rows: [], sample } }。 */
function recordAiErrorKind(kinds, kind, row, sample = "") {
  if (!kinds || typeof kinds !== "object") return kinds;
  const key = AI_ERROR_KIND_LABELS[kind] ? kind : "unknown";
  const entry = kinds[key] || (kinds[key] = { count: 0, rows: [], sample: "" });
  entry.count += 1;
  const index = Number(row);
  if (Number.isFinite(index) && !entry.rows.includes(index) && entry.rows.length < AI_ERROR_ROW_SAMPLE_LIMIT) {
    entry.rows.push(index);
  }
  const text = String(sample || "").replace(/\s+/g, " ").trim();
  if (!entry.sample && text) entry.sample = text.slice(0, AI_ERROR_SAMPLE_DISPLAY_LIMIT);
  return kinds;
}

/**
 * 合并两端口径的分类明细：base 是客户端从备注反推的，extra 是服务端记录的，同一行以 extra 为准。
 *
 * 按行号去重，而不是按类别取 max：备注与服务端观察的常常是同一批行，但两端对同一行的归类
 * 可能不同（服务端看得到 code，备注只有文本），按类别取 max 会让这一行同时出现在两类里。
 * - extra 已登记的行号，从 base 的各类里剔除；两边行号不重叠时（历史遗留 + 本次运行）取并集。
 * - 行号样本有上限（AI_ERROR_ROW_SAMPLE_LIMIT），超出的部分只有计数、没有行号，无法逐行去重：
 *   同一类里这部分按 max 处理，宁可低估也不重复累加。
 */
function mergeAiErrorKinds(base, extra) {
  const normalize = (source) => {
    const result = {};
    if (!source || typeof source !== "object") return result;
    for (const [kind, raw] of Object.entries(source)) {
      const entry = raw && typeof raw === "object" ? raw : {};
      const rows = [];
      for (const row of Array.isArray(entry.rows) ? entry.rows : []) {
        const index = Number(row);
        if (Number.isFinite(index) && !rows.includes(index)) rows.push(index);
      }
      const count = Math.max(0, Number(entry.count) || 0);
      result[kind] = {
        rows,
        unlisted: Math.max(0, count - rows.length),
        sample: entry.sample ? String(entry.sample) : "",
      };
    }
    return result;
  };
  const baseKinds = normalize(base);
  const extraKinds = normalize(extra);
  const claimed = new Set();
  for (const entry of Object.values(extraKinds)) {
    for (const row of entry.rows) claimed.add(row);
  }

  const merged = {};
  for (const kind of new Set([...Object.keys(baseKinds), ...Object.keys(extraKinds)])) {
    const fromBase = baseKinds[kind];
    const fromExtra = extraKinds[kind];
    const keptBaseRows = fromBase ? fromBase.rows.filter((row) => !claimed.has(row)) : [];
    const baseSurvives = keptBaseRows.length > 0 || Boolean(fromBase && fromBase.unlisted > 0);
    const allRows = [...(fromExtra ? fromExtra.rows : []), ...keptBaseRows].sort((a, b) => a - b);
    const unlisted = Math.max(baseSurvives ? fromBase.unlisted : 0, fromExtra ? fromExtra.unlisted : 0);
    const count = allRows.length + unlisted;
    if (count <= 0) continue;
    merged[kind] = {
      count,
      rows: allRows.slice(0, AI_ERROR_ROW_SAMPLE_LIMIT),
      sample: (baseSurvives && fromBase.sample) || (fromExtra ? fromExtra.sample : ""),
    };
  }
  return merged;
}

/** 把 { kind: { count, rows } } 展开成按展示顺序排好的数组。 */
function sortAiErrorKinds(kinds) {
  const source = kinds && typeof kinds === "object" ? kinds : {};
  const known = AI_ERROR_KIND_ORDER.filter((kind) => source[kind]);
  const extra = Object.keys(source).filter((kind) => !AI_ERROR_KIND_ORDER.includes(kind));
  return [...known, ...extra]
    .map((kind) => {
      const entry = source[kind] && typeof source[kind] === "object" ? source[kind] : {};
      return {
        kind,
        label: AI_ERROR_KIND_LABELS[kind] || kind,
        count: Math.max(0, Number(entry.count) || 0),
        rows: (Array.isArray(entry.rows) ? entry.rows : []).map(Number).filter(Number.isFinite),
        sample: String(entry.sample || ""),
      };
    })
    .filter((entry) => entry.count > 0);
}

/**
 * 生成「异常」指标的悬停文本：一行总数 + 每类一行「类别：N 行」。
 * 只回答「出了哪几类问题、各多少行」——行号与代表性消息都不进悬停文本：
 * 异常定位靠失败备注与 AI 日志，把行号列进提示只会把它撑成一份台账。
 * 只有类别数、没有行号时（旧服务端未回报明细）也要给出可读提示，不能空着。
 */
function formatAiErrorHoverTitle(stageLabel, total, kinds) {
  const count = Math.max(0, Number(total) || 0);
  const label = String(stageLabel || "").trim();
  const head = label ? `${label} · 异常 ${count} 行` : `异常 ${count} 行`;
  const entries = sortAiErrorKinds(kinds);
  if (!entries.length) {
    return count > 0
      ? `${head}\n（暂无可分类的失败明细：失败记录只保留在运行中的服务端，可对照 AI 日志逐条核对）`
      : head;
  }
  return [head, ...entries.map((entry) => `· ${entry.label}：${entry.count} 行`)].join("\n");
}

module.exports = {
  AI_ERROR_KIND_ORDER,
  AI_ERROR_KIND_LABELS,
  AI_ERROR_ROW_SAMPLE_LIMIT,
  AI_ERROR_SAMPLE_DISPLAY_LIMIT,
  classifyAiError,
  recordAiErrorKind,
  mergeAiErrorKinds,
  sortAiErrorKinds,
  formatAiErrorHoverTitle,
};
