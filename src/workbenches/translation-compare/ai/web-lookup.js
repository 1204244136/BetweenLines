/**
 * 线上查询层：模型自己判断不了时，按顺序去作品维基**站内查证**，拿到关键信息就停；
 * 三个官方站点都不行，再让模型自行检索；仍不行才转人工。
 *
 * 位置（与既有分层的顺序）：
 *   对照表（离线判定） → 模型（必要时补相邻行再判） → 低分归因与修复（只对极低分行） → **线上查询层（多站点按轮）** → 待人工确认。
 * 低分归因层（`low-score.js`）排在前面，但它**不改这一层的触发条件**：那一层只把极低分行的原因问清楚，
 * 问不清的行照旧带着 needsContext/unclear 走到这里。
 * 触发条件很窄，同时满足才进入：① 本行有 `advisory` 命中（假名写法、可能只是普通词）；
 * ② 模型自己返回 `needsContext`/`unclear`，且相邻行也补过。`conflict`/`consistent`/`term-only` 都不进来。
 *
 * 为什么**不给直达词条链接**：`.../wiki/GROUP` 这种链接依赖“条目名恰好等于我们的查询词”，
 * 猜错就是 404 或指向别的条目，模型只会照着一个打不开的地址瞎猜。所以这里只给**官网入口** +
 * **要查的词条**，由模型在站内搜索、自己找到对应条目——找得到才有依据，找不到就如实说找不到。
 *
 * 为什么**由程序按轮驱动**而不是一次把三个站点都塞进去：
 * “按顺序、失败换下一个、拿到关键信息就立刻停”只有程序能保证——一次给三个站点，模型可能
 * 三个都读、也可能跳过第一个直接读第三个，还会让“它到底查了哪个”变得不可审计。分轮之后：
 * 一轮只给一个站点，答不出才进下一轮，答出来立即结束（后面的站点与自行检索一轮都不再发）。
 *
 * 为什么**本机不抓网页**：实测这些站点对本机一律返回 403 风控挑战页
 * （`<title>请稍候…</title>`，换 UA、换客户端都一样），绕过需要 clearance cookie 或浏览器引擎；
 * 而模型侧的联网/检索能力是现成的。本机只负责“按什么顺序、给哪个入口、问什么、什么时候停”。
 *
 * 边界（改这个文件前先读）：
 * - **不许凭记忆猜**：每一轮都写明“只依据你实际查到的内容；打不开、搜不到、内容无关都不要猜，
 *   本轮照常返回 unclear”。这是这一层不会产出幻觉结论的唯一保证。
 * - **只发术语名**：提示词里只有查询词与该行的少量片段，不含整卷文本，也不含本机路径。
 * - 站点列表属于作品专有信息：由档案（`profiles/*.js` 的 `wikiSites`）声明，本模块不认识任何具体作品。
 */
const { stripInlineMarkup } = require("./term-table");

// 提示词段的段首标记（每轮共享同一前缀，只有轮次说明不同）：自定义提示词里若残留旧段，组装阶段按此前缀剥离。
const WEB_LOOKUP_PREFIX = "【线上查证（作品维基）】";
const DEFAULT_EXCERPT_RADIUS = 24;

/** 站点归一化：接受字符串数组或 `{ label, url }` 数组，统一成对象并保持**声明顺序**（顺序就是查询顺序）。 */
function webLookupSites(value) {
  const items = Array.isArray(value) ? value : [value];
  const sites = [];
  const seen = new Set();
  for (const item of items) {
    const raw = typeof item === "string" ? { url: item } : (item || {});
    const url = String(raw.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let label = String(raw.label || "").trim();
    if (!label) {
      try {
        label = new URL(url).hostname;
      } catch {
        label = url;
      }
    }
    sites.push({ label, url });
  }
  return sites;
}

/** 取术语附近的上下文片段，给模型看“这个词出现在什么句子里”。 */
function termExcerpt(text, term, radius = DEFAULT_EXCERPT_RADIUS) {
  const plain = stripInlineMarkup(String(text || "")).replace(/\s+/g, " ").trim();
  const name = String(term || "").replace(/[【】]/g, "").trim();
  if (!plain) return "";
  if (!name) return plain.slice(0, radius * 2);
  const at = plain.indexOf(name);
  if (at < 0) return plain.slice(0, radius * 2);
  const from = Math.max(0, at - radius);
  const to = Math.min(plain.length, at + name.length + radius);
  return `${from > 0 ? "…" : ""}${plain.slice(from, to)}${to < plain.length ? "…" : ""}`;
}

/**
 * 本行需要线上查证的条目：只认 `advisory` 命中（假名写法存疑）。
 * 每个条目给**要查的词条**（本项目译名优先，原文写法作备选——本机不预判哪个在站内存在），
 * 以及该行片段与译文，供模型判断“这里是不是指这个术语”。
 */
function webLookupEntries({ termGuidance = null, jp = "", targetText = "" } = {}) {
  const advisory = (termGuidance?.terms || []).filter((term) => term.advisory === true);
  if (!advisory.length) return [];
  const target = stripInlineMarkup(String(targetText || ""));
  return advisory.map((term) => {
    const terms = [...new Set([term.target, term.source].map((name) => String(name || "").trim()).filter(Boolean))];
    return {
      pair: `${term.source} → ${term.target}${term.type ? `（${term.type}）` : ""}`,
      source: term.source,
      target: term.target,
      type: term.type || "",
      terms,
      excerpt: termExcerpt(jp, term.alias || term.source),
      targetText: target,
    };
  }).filter((item) => item.terms.length);
}

/**
 * 一轮查证段：`round` 是**要用的站点序号**（0 起）；`round === sites.length` 表示
 * “官方站点都试过了，改为让模型自行检索”。段内自带“只依据实际查到的内容、拿到就停”的边界。
 */
function webLookupBlock({ sites = [], entries = [], round = 0 } = {}) {
  const rows = (entries || []).filter((item) => item.terms?.length);
  if (!rows.length) return "";
  const site = sites[round];
  const lines = [];
  if (site) {
    lines.push(`${WEB_LOOKUP_PREFIX} 第 ${round + 1}/${sites.length} 站：${site.label}`);
    lines.push("请到这个站点的入口**站内查找**下面的词条，并依据查到的内容回答后面的问题：");
    lines.push(`站点入口：${site.url}`);
  } else {
    lines.push(`${WEB_LOOKUP_PREFIX} 官方站点均未获得有效信息，改为自行检索`);
    lines.push("前面几个官方站点都没有查到能用的信息。请用你自己的能力（浏览器、搜索引擎，或你确实掌握的可信资料）再找一次，并据此回答下面的问题：");
  }
  for (const item of rows) {
    lines.push(`- 词条：${item.terms.join("、")}${item.type ? `（${item.type}）` : ""}`);
    lines.push(`  原文片段：${item.excerpt || "（无）"}`);
    lines.push(`  译文：${item.targetText || "（空）"}`);
  }
  lines.push(
    "问题：原文里这个词在本行**是不是**指该术语（例如这里的「グループ」是指那个组织，还是普通名词“集团”）？据此决定译文要不要改。",
    "要求：",
    site
      ? "1. 只依据你**实际在该站点查到**的内容判断；站点打不开、站内搜不到、查到的内容与问题无关时，都不要猜测，本轮照常返回 needsContext=true 或 decision=unclear（程序会接着给你下一个站点）。"
      : "1. 只依据你**实际取得**的内容判断；取不到内容时不要用训练记忆或常识顶替，照常返回 needsContext=true 或 decision=unclear。",
    "2. 一旦拿到足以定论的关键信息就**立即**给出结论，不要继续翻别的条目或别的来源。",
    "3. 站内资料只作参考：它不能改变原文语义，也不能作为改写译文的充分理由；与原文冲突时以原文为准。",
    "4. 在 summary 里写明依据来自哪个站点与哪条内容；没查到就写明“未查到有效内容”。",
  );
  return lines.join("\n");
}

/** 线上查证在结果备注里的那一行：人工只读结果，也要能看出结论依据、以及一共试了几处。 */
function webLookupNote({ concluded = false, siteLabel = "", triedLabels = [] } = {}) {
  if (concluded) {
    return siteLabel
      ? `线上查证：${siteLabel}查到依据（结论见上方分析）`
      : "线上查证：模型自行检索后得出结论（结论见上方分析）";
  }
  const tried = (triedLabels || []).filter(Boolean);
  return tried.length
    ? `线上查证：已依次尝试 ${tried.join(" → ")}${siteLabel ? ` → ${siteLabel}` : ""}，均未获得有效内容，转终审确认`
    : "线上查证：未获得有效内容，转终审确认";
}

module.exports = {
  DEFAULT_EXCERPT_RADIUS,
  WEB_LOOKUP_PREFIX,
  termExcerpt,
  webLookupBlock,
  webLookupEntries,
  webLookupNote,
  webLookupSites,
};
