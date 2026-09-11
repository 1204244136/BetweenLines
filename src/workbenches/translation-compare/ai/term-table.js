/**
 * 特化侧的辅助判断数据：术语/译名对照表。
 *
 * 与提示词的分工：提示词只放“判断规则”，动辄上千行的对照表不进提示词，
 * 而是先做确定性预处理——命中的行直接用表里的内容判定与给出最小替换，不再交给模型。
 *
 * 数据来源由特化档案声明（profile.termTables），也支持环境变量
 * `TRANSCOMPARATOR_TERM_TABLES` 追加；表本身属于本机数据，不写进仓库。
 *
 * 表结构（按表头识别，大小写与空格不敏感）：
 * - base_ori / original / 原文：日文原词（可含【】分段，如「【山田】【太郎】」）
 * - ruby_ori：假名或原文注音（如「やまだ,たろう」），作为别名参与匹配
 * - base_trans / target / 译名：本项目中文译名
 * - type：条目类型（人名/术语/地名…），只用于说明
 * - other_fandom / ruby_trans / memo1 / memo2：其他译法、英文、备注，用于冲突时给出线索
 */
const path = require("path");
const { toCn } = require("../../../ingest/text-utils");
const { readRecords } = require("../../../core/spreadsheet");

const COLUMN_CANDIDATES = {
  source: ["base_ori", "original", "source", "jp", "原文", "日文", "原词"],
  ruby: ["ruby_ori", "rubyoriginal", "ruby", "假名", "读音", "注音"],
  target: ["base_trans", "translation", "target", "cn", "译名", "译文", "中文"],
  rubyTarget: ["ruby_trans", "rubytranslation", "英文"],
  other: ["other_fandom", "other", "其他译法", "其他译名"],
  type: ["type", "类型", "分类"],
  memo: ["memo1", "memo2", "memo", "备注", "说明"],
};

const BRACKET_PAIRS = [
  ["【", "】"],
  ["〖", "〗"],
  ["［", "］"],
  ["[", "]"],
  ["（", "）"],
  ["(", ")"],
];

// 比对时忽略的装饰：括号、空白、各种分隔符与引号。
const DECORATION = /[【】〖〗［］[\]（）()「」『』\s,，、.。·・:：;；'"“”‘’]/g;
const KANA_ONLY = /^[\u3040-\u309f\u30a0-\u30ff\u30fc\u30fb]+$/;
const KATAKANA = /[\u30a0-\u30ff\u30fc]/;

// 行文本里带内联标记（ruby/rt/b/sup）：注音 rt 是读音，不算正文，先剥掉再匹配，
// 否则「ときわだい」这类读音会命中「ときわだいちゆうがく」之类的长读音串。
function stripInlineMarkup(text) {
  return String(text || "")
    .replace(/<rp[^>]*>[\s\S]*?<\/rp>/gi, "")
    .replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, "")
    .replace(/<[^>]*>/g, "");
}

// 纯假名别名只在足够长时才可用：短读法（イヴ、タク）会和普通词、长词片段撞车。
function isAliasUsable(alias) {
  if (alias.length < 2) return false;
  if (KANA_ONLY.test(alias)) return alias.length >= 4;
  return true;
}

// 片假名别名不能落在更长的片假名词内部（サンタクロース 里的「タク」不是「巧」）。
function hasUsableMatch(text, alias) {
  if (!KATAKANA.test(alias[0])) return text.includes(alias);
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(alias, from);
    if (at < 0) return false;
    const before = text[at - 1] || "";
    const after = text[at + alias.length] || "";
    if (!KATAKANA.test(before) && !KATAKANA.test(after)) return true;
    from = at + 1;
  }
  return false;
}

function firstColumn(record, keys) {
  for (const key of keys) {
    if (record[key]) return record[key];
  }
  return "";
}

function splitBracketed(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const parts = [];
  let plain = "";
  let index = 0;
  while (index < text.length) {
    const pair = BRACKET_PAIRS.find(([open]) => text.startsWith(open, index));
    if (!pair) {
      plain += text[index];
      index += 1;
      continue;
    }
    const [open, close] = pair;
    const end = text.indexOf(close, index + open.length);
    if (end === -1) {
      plain += text[index];
      index += 1;
      continue;
    }
    const inner = text.slice(index + open.length, end).trim();
    if (inner) parts.push(inner);
    index = end + close.length;
  }
  if (plain.trim()) parts.unshift(plain.trim());
  return parts.length ? parts : [text];
}

function stripMarks(value) {
  return String(value || "").replace(DECORATION, "");
}

function normalizeForCompare(value) {
  return toCn(stripMarks(value)).toLowerCase();
}

function termAliases(entry) {
  const aliases = new Map();
  // scope 说明这个别名能用来做什么：
  // - term：别名就是术语本身（基文/写法），可以用整条译名判定一致性；
  // - part：只是术语的一个分段（姓、名），译文里对应的中文无法可靠切分，只记录不判定；
  // - ruby：只是读音（基文与读音可能对应不同中文，例如「【発信機】」读作「はっしんき」），
  //         拿基文译名去判定会误报，因此同样只记录不判定。
  const add = (alias, scope, weight) => {
    const value = String(alias || "").trim();
    if (!isAliasUsable(value)) return;
    if (/^[\s\p{P}\p{S}]+$/u.test(value)) return;
    const existing = aliases.get(value);
    if (!existing || existing.weight < weight) {
      // strong：3 字及以上的基文别名才够格判定“不一致”。2 字词（時代、部屋、階層）在
      // 正文里常以普通词义出现，只能用来确认一致，不能用来指控译名错误。
      aliases.set(value, { alias: value, scope, weight, strong: scope === "term" && value.replace(/[【】]/g, "").length >= 3 });
    }
  };

  add(stripMarks(entry.source), "term", 5);
  add(entry.source, "term", 4);
  const sourceParts = entry.sourceParts || [];
  if (sourceParts.length === 1) {
    add(sourceParts[0], "term", 4);
  } else {
    for (const part of sourceParts) add(part, "part", 3);
  }
  const ruby = String(entry.ruby || "").trim();
  if (ruby) {
    const rubyParts = ruby.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
    add(stripMarks(ruby), "ruby", 2);
    if (rubyParts.length > 1) {
      for (const part of rubyParts) add(part, "ruby", 2);
    } else if (rubyParts.length === 1) {
      add(rubyParts[0], "ruby", 2);
    }
  }
  return [...aliases.values()];
}

/**
 * 把译名与原文分段对齐：中文里只写姓或名是常规做法，不能因为没写全名就判成译名错误。
 * 目标自带【】时按括号分段；未分段时按原文各段字数比例切分（日文名的中译通常保持字数）。
 */
function alignTargetParts(target, sourceParts) {
  const text = stripMarks(target);
  const parts = splitBracketed(target).map((part) => stripMarks(part)).filter(Boolean);
  if (parts.length > 1 && parts.length === sourceParts.length) return parts;
  if (sourceParts.length <= 1) return [text];
  const lengths = sourceParts.map((part) => part.length);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total !== text.length) return [text];
  const result = [];
  let cursor = 0;
  for (const length of lengths) {
    result.push(text.slice(cursor, cursor + length));
    cursor += length;
  }
  return result;
}

function normalizeTermEntry(record) {
  const source = firstColumn(record, COLUMN_CANDIDATES.source);
  const target = firstColumn(record, COLUMN_CANDIDATES.target);
  if (!source || !target) return null;
  const entry = {
    source: source.trim(),
    sourceParts: splitBracketed(source),
    ruby: firstColumn(record, COLUMN_CANDIDATES.ruby).trim(),
    target: target.trim(),
    targetText: stripMarks(target),
    rubyTarget: firstColumn(record, COLUMN_CANDIDATES.rubyTarget).trim(),
    other: firstColumn(record, COLUMN_CANDIDATES.other).trim(),
    type: firstColumn(record, COLUMN_CANDIDATES.type).trim(),
    memos: COLUMN_CANDIDATES.memo.map((key) => record[key]).filter(Boolean),
  };
  entry.aliases = termAliases(entry);
  entry.compareKey = normalizeForCompare(entry.target);
  entry.targetParts = alignTargetParts(entry.target, entry.sourceParts)
    .map((part) => ({ text: part, key: normalizeForCompare(part) }))
    .filter((part) => part.key.length >= 2);
  return entry.aliases.length ? entry : null;
}

/**
 * 一致性的三级判定：整条译名 → 对齐后的分段译名（只写姓或名）→ 都不成立才算冲突。
 */
function checkTargetConsistency(entry, targetKey) {
  if (entry.compareKey && targetKey.includes(entry.compareKey)) return "full";
  if (entry.targetParts.length > 1 && entry.targetParts.some((part) => targetKey.includes(part.key))) return "part";
  return "";
}

function loadTermTable(file, options = {}) {
  const { sheet, headers, records } = readRecords(file, options);
  const entries = records.map(normalizeTermEntry).filter(Boolean);
  if (!entries.length) {
    throw new Error(`对照表没有可用条目（需要原文列与译名列）：${file}`);
  }
  return { file, sheet, headers, entries };
}

/**
 * 载入多张表并建立按首字分桶的匹配索引。
 * @returns {{ files: string[], sheetNames: string[], entries: object[], buckets: Map<string, object[]>, errors: string[] }}
 */
function loadTermTables(files = []) {
  const unique = normalizeTermTablePaths(files);
  const entries = [];
  const sheetNames = [];
  const errors = [];
  for (const file of unique) {
    try {
      const table = loadTermTable(file);
      entries.push(...table.entries);
      sheetNames.push(table.sheet || path.basename(file));
    } catch (error) {
      errors.push(`${file}：${error.message}`);
    }
  }
  return { files: unique, sheetNames, entries, buckets: buildTermBuckets(entries), errors };
}

function buildTermBuckets(entries) {
  const buckets = new Map();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const key = alias.alias[0];
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ ...alias, entry });
    }
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => b.alias.length - a.alias.length);
  }
  return buckets;
}

/**
 * 在原文里找命中的术语：按行内出现过的字符取桶，长别名优先，同一条目只算一次，
 * 且整条命中优先于分段命中。
 */
function findTermHits(sourceText, tables) {
  const text = String(sourceText || "");
  if (!text || !tables || !tables.entries || !tables.entries.length) return [];
  const hits = new Map();
  const tried = new Set();
  for (const char of new Set(Array.from(text))) {
    const bucket = tables.buckets.get(char);
    if (!bucket) continue;
    for (const candidate of bucket) {
      const { alias, entry, scope, strong } = candidate;
      const key = `${entry.source}\u0000${alias}`;
      if (tried.has(key)) continue;
      tried.add(key);
      if (!hasUsableMatch(text, alias)) continue;
      const current = hits.get(entry.source);
      const better = !current
        || (!current.strong && strong)
        || (current.scope !== "term" && scope === "term")
        || (current.scope === scope && current.strong === strong && alias.length > current.alias.length);
      if (better) hits.set(entry.source, { entry, alias, scope, strong });
    }
  }
  return [...hits.values()];
}

function findWrongVariant(targetText, entry) {
  const target = String(targetText || "");
  const candidates = [];
  if (entry.other) candidates.push({ from: entry.other, kind: "其他译法" });
  const traditional = toCn(entry.target);
  const converted = entry.target === traditional ? "" : traditional;
  if (converted && converted !== entry.target && target.includes(converted)) {
    candidates.push({ from: converted, kind: "字形差异" });
  }
  if (entry.rubyTarget && target.toLowerCase().includes(entry.rubyTarget.toLowerCase())) {
    candidates.push({ from: entry.rubyTarget, kind: "英文写法" });
  }
  return candidates.find((candidate) => candidate.from && target.includes(candidate.from)) || null;
}

/**
 * 判定一行：命中对照表则返回 { kind, hits, revisedText? }；证据不足时返回 null（交回后续流程）。
 *
 * 保守判定规则：
 * 1. 只有“强证据”（3 字及以上的基文别名）才能判“译名不一致”，并给出最小替换；
 * 2. 2 字词、读音别名、分段别名只能“确认一致”，不能指控译名错误——它们常以普通词义出现；
 * 3. 一行若既没有强证据、也没被确认一致，就不由对照表处理，继续走 AI。
 */
function evaluateTermRow({ source, target, tables }) {
  const plainSource = stripInlineMarkup(source);
  const plainTarget = stripInlineMarkup(target);
  const hits = findTermHits(plainSource, tables);
  if (!hits.length) return null;
  const targetKey = normalizeForCompare(plainTarget);
  const results = hits.map(({ entry, alias, scope, strong }) => {
    const decidable = scope === "term" && strong;
    const via = checkTargetConsistency(entry, targetKey);
    if (!decidable) {
      return { entry, alias, scope, strong, consistent: via ? true : null, via, variant: null };
    }
    const variant = via ? null : findWrongVariant(plainTarget, entry);
    return { entry, alias, scope, strong, consistent: Boolean(via), via, variant };
  });
  const conflicts = results.filter((result) => result.consistent === false);
  if (!conflicts.length) {
    const confirmed = results.some((result) => result.consistent === true);
    return confirmed ? { kind: "consistent", hits: results, revisedText: "" } : null;
  }

  let revisedText = "";
  const replacements = conflicts.filter((result) => result.variant);
  if (replacements.length) {
    let text = plainTarget;
    for (const result of replacements) {
      text = text.split(result.variant.from).join(result.entry.target);
    }
    revisedText = text.trim();
  }
  return { kind: "conflict", hits: results, revisedText };
}

function describeTermHit(result) {
  const { entry, consistent, variant, scope, via, strong } = result;
  const type = entry.type ? `（${entry.type}）` : "";
  if (scope === "part") {
    return `${entry.source} → ${entry.target}${type}：原文只出现了分段写法，未参与译名一致性判定。`;
  }
  if (scope === "ruby") {
    return `${entry.source} → ${entry.target}${type}：原文只出现了读音写法，基文与读音可能对应不同中文，未参与判定。`;
  }
  if (!strong) {
    return consistent
      ? `${entry.source} → ${entry.target}${type}：译文已使用该译名（短词，只作为一致性证据）。`
      : `${entry.source} → ${entry.target}${type}：原文命中的是短词，不足以判定译名错误，交由后续判断。`;
  }
  if (consistent === true) {
    return via === "part"
      ? `${entry.source} → ${entry.target}${type}：译文使用了该译名的分段写法（如只写姓或名）。`
      : `${entry.source} → ${entry.target}${type}：译文已使用该译名。`;
  }
  if (variant) return `${entry.source} → ${entry.target}${type}：译文里的「${variant.from}」属${variant.kind}，应替换为本项目译名。`;
  return `${entry.source} → ${entry.target}${type}：译文未出现该译名，请人工确认是否需要替换。`;
}

/**
 * 「译名一致」这一类命中的分组说明：一行常命中好几条术语，逐条写成整句会让备注膨胀
 * （实测一致行平均 499 字节、最长 2529 字节，而它们都不需要任何操作）。
 * 分组只丢掉措辞，不丢掉信息：哪几条术语命中、各自属于哪种证据都还在。
 */
function termHitGroupLabel(result) {
  const { consistent, scope, via, strong } = result;
  if (scope === "part") return "原文为分段写法";
  if (scope === "ruby") return "原文为读音写法";
  if (!strong) return "短词证据";
  if (consistent === true) return via === "part" ? "译文用分段写法" : "译文已用译名";
  return "未确认";
}

function formatTermHitGroups(hits = []) {
  const groups = new Map();
  for (const hit of hits) {
    const label = termHitGroupLabel(hit);
    if (!groups.has(label)) groups.set(label, []);
    const type = hit.entry.type ? `（${hit.entry.type}）` : "";
    groups.get(label).push(`${hit.entry.source}→${hit.entry.target}${type}`);
  }
  return [...groups.entries()]
    .map(([label, items]) => `${label} ${items.join("、")}`)
    .join("；");
}

function termTableSummary(tables) {
  return `对照表：${tables.files.length} 张表 / ${tables.entries.length} 条术语`;
}

/**
 * 归一化对照表路径并去重：同一张表可能同时由特化档案、环境变量和命令行给出，
 * 路径写法（相对路径、重复分隔符、大小写）不同也必须只加载一次。
 */
function normalizeTermTablePaths(paths = []) {
  const result = [];
  const seen = new Set();
  for (const item of paths) {
    const value = String(item || "").trim();
    if (!value) continue;
    const resolved = path.resolve(value);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

module.exports = {
  COLUMN_CANDIDATES,
  describeTermHit,
  evaluateTermRow,
  findTermHits,
  findWrongVariant,
  formatTermHitGroups,
  hasUsableMatch,
  isAliasUsable,
  loadTermTable,
  loadTermTables,
  normalizeForCompare,
  normalizeTermEntry,
  normalizeTermTablePaths,
  splitBracketed,
  stripInlineMarkup,
  stripMarks,
  termAliases,
  termTableSummary,
};
