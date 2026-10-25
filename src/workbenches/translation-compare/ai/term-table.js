/**
 * 特化侧的辅助判断数据：术语/译名表。
 *
 * 与提示词的分工：提示词只放“判断规则”，动辄上千行的译名表不进提示词，
 * 而是先做确定性预处理——整行有效内容都是术语时直接出结论（跳过模型），其余命中行把术语与
 * 冲突线索注入提示词后**照常交给模型**：术语判断是模型分析里的一个环节，不是面向人工的终局结果。
 *
 * 数据来源由特化档案声明（profile.termTables），也支持环境变量
 * `TRANSCOMPARATOR_TERM_TABLES` 追加；表本身属于本机数据，不写进仓库。
 *
 * 表结构（按表头识别，大小写与空格不敏感）：
 * - base_ori / original / 原文：日文原词。原文里的【】只是**给注音标记位置**（注音按逗号顺序
 *   加进各个方括号里的文本），正文里几乎不会出现方括号，所以匹配一律用去掉方括号后的原文；
 *   形如「【山田】【太郎】」表示该词由两段组成，注音列写「やまだ,たろう」按顺序与它们对应。
 * - ruby_ori：假名或原文注音（如「やまだ,たろう」），作为别名参与匹配
 * - base_trans / target / 译名：本项目中文译名
 * - type：条目类型（人名/术语/地名…），判定时只用于一件事：区分人名与非人名（见下）
 * - other_fandom / ruby_trans / memo1 / memo2：其他译法、英文、备注，用于冲突时给出线索
 *
 * **注音条目的匹配口径（非人名）：中日两侧都注音，才当作「表里那个专有名词」**。
 * `ruby_ori` 这一列混着两类写法：
 * - ① 特殊别名读音：「【発信機】」注「ナノデバイス」、「【表層融解】」注「フラックスコート」；
 * - ② 这个词本身的普通读音：「【魔術】」注「まじゅつ」、「【学園都市】」注「がくえんとし」。
 * ②类在正文里**永远不带注音**（没有作者会给普通词标读音），所以单看原文的“基文 + 注文必须一起出现”
 * 会把它们整体排除：实测整卷 3119 行里光「魔術」就有 42 处候选被挡掉，那些行被裸着交给模型，
 * 模型只能按通用词典把 魔術 判成「魔术」（`【魔術】→魔法` 本来就写在表里，却没能注入）。
 * 反过来，只对上基文的「ＧＰＳ発信機」是普通词义（发射机），与表里那件装备不是一回事，又不能一律放行。
 * 因此改成**双侧证据**：真正带特殊注音的专有名词在中日两侧都会注音
 * （`<ruby>心理掌握<rt>メンタルアウト</rt></ruby>` ↔ `<ruby>心理掌握<rt>Mental Out</rt></ruby>`），
 * 于是把「译文里对应的中文译名也被注音」当作第二个证据，候选因此有三种出口：
 * - `full`：原文侧对上（基文 + 注文，或注文以正文形式出现）**且**译文侧的中文译名也带注音
 *   → 按完整口径判定：可确认一致、可指控译名差异、可计入覆盖率；
 * - `demoted`：只有一侧对上、或两侧都没有 → **降级为「只作一致性证据」**：译文确实用了该译名时
 *   照常算命中（一致 → 可注入提示词、可判「整行只有术语」），译文没用该译名时**不算命中**
 *   （不判定、不计入覆盖率、不进提示词）——宁可不判，也不凭一次字面命中去指控译名错误；
 * - `excluded`：降级且译文也没用该译名，通过 `rejected` 回传计数；降级命中的候选通过 `demoted`
 *   回传，便于日志与页面区分「表里没这条」与「注音没双侧对上、只作一致性证据」。
 * `ruby` 别名（原文只写了读音）不设这道门槛：它本来就只能确认一致、不能指控，与降级后的效果一致。
 *
 * **人名条目豁免**：原文里的人名只在首次出现时注音，之后一律不带注音，若也要求注音对上，
 * 人名条目会在绝大多数行里失效。因此人名（`type` 含人名/角色/姓名/名字/character/person 等）
 * 仍按基文（含分段写法）判定，注音只作为别名参与匹配。`type` 为空按非人名处理（保守：宁可不判）。
 */
const path = require("path");
const { toCn } = require("../../../ingest/text-utils");
const { readRecords, requireColumns } = require("../../../core/spreadsheet");
const { firstColumn, stripInlineMarkup } = require("../../../core/text-helpers");

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
// 「有效字符」= 既不是空白也不是标点/符号的字符：残留判定只看它，
// 这样「…を外す。」这类句读与助词之外的差异不会被算成“术语之外的内容”。
const EFFECTIVE_CHAR = /[^\s\p{P}\p{S}]/u;
const HAS_EFFECTIVE_CHAR = /[^\p{P}\p{S}]/u;

/**
 * 纯术语行的判定阈值。
 *
 * 译名表只能证明「术语用对了」，证明不了「整行的其余部分翻译没问题」。所以一行只有在
 * **有效内容本身就是术语**（术语之外只剩句读之类的一两个字符）时才允许跳过模型；
 * 只要句中还有别的词，就必须把术语当提示词注入、照常交给模型。
 */
const TERM_ONLY_FREE_CHARS = 2;
const TERM_ONLY_FREE_RATIO = 0.2;

/**
 * 判定门槛：够长的**基文别名**才允许由译名表指控“译名不一致”（`strong`）。
 *
 * 2 字词（時代、部屋、階層）在正文里常以普通词义出现，只能用来确认一致、不能指控译名错误；
 * 1 字别名在 `isAliasUsable` 阶段就被排除（会和长词片段撞车）。
 *
 * 曾试过放宽到 2 字（当时等于“所有可用基文别名都能指控”），实测代价偏大，已回到 3 字：整卷
 * 3350 行里新增 8 行冲突，多数是「短词与专有名词同名」的假差异——`薔薇 → 蔷薇（组织/结社）`
 * 撞上花名的「玫瑰」、`白鳥 → 白鸟（科技/载具）` 撞上「天鹅」、`健康（组织）` 撞上普通词。
 * 这些行会带冲突徽标、豁免相似度预筛，还会给模型递一条「译文未出现该译名」的误导线索，所以
 * 宁可不判。要再调就改这里（这是唯一门槛），并同步递增 `term-layer.js` 的 TERM_LAYER_VERSION。
 * 读音别名与分段别名不看这个门槛：它们本来就只能确认一致，分别由 `scope === "ruby"` / `"part"` 处理。
 */
const TERM_STRONG_MIN_LENGTH = 3;

// 行文本里带内联标记（ruby/rt/b/sup）：注音 rt 是读音，不算正文，先剥掉再匹配，
// 否则「ときわだい」这类读音会命中「ときわだいちゆうがく」之类的长读音串。
// 实现在 src/core/text-helpers.js（stripInlineMarkup）。

// 纯假名别名只在足够长时才可用：短读法（イヴ、タク）会和普通词、长词片段撞车。
function isAliasUsable(alias) {
  if (alias.length < 2) return false;
  if (KANA_ONLY.test(alias)) return alias.length >= 4;
  return true;
}

// 人名类型：人名条目豁免「注音必须对上」（原文里的人名只在首次出现时注音）。
// type 为空按非人名处理——宁可少判一条，也不要因为认不出人名而把普通词误判成译名差异。
const PERSON_TYPE = /人名|名字|姓名|人物|角色|登場人物|登场人物|character|person|name/i;

/**
 * 原文里的注音对（基文 → 读音）。两种形态都认：
 * - 成品的 `<ruby>基文<rt>读音</rt></ruby>`（基文可能还带 `<rb>`/`<rp>`，先剥掉）；
 * - 稿件的 `|基文[读音]`。
 */
const RUBY_PAIR_PATTERN = /<ruby[^>]*>([\s\S]*?)<rt[^>]*>([\s\S]*?)<\/rt>/gi;
const DRAFT_RUBY_PAIR_PATTERN = /\|([^|\s[\]]{1,30})\[([^\]\n]{1,40})\]/g;

function rubyPairs(text) {
  const raw = String(text || "");
  const pairs = [];
  const collect = (base, ruby) => {
    const plainBase = stripMarks(stripInlineMarkup(base));
    const plainRuby = stripMarks(ruby);
    if (plainBase && plainRuby) pairs.push({ base: plainBase, ruby: plainRuby });
  };
  let match;
  RUBY_PAIR_PATTERN.lastIndex = 0;
  while ((match = RUBY_PAIR_PATTERN.exec(raw))) collect(match[1], match[2]);
  DRAFT_RUBY_PAIR_PATTERN.lastIndex = 0;
  while ((match = DRAFT_RUBY_PAIR_PATTERN.exec(raw))) collect(match[1], match[2]);
  return pairs;
}

// 注音比对的归一：全角/半角（NFKC）、大小写、装饰符，以及**小写假名**。
// 实测原文把「しょ」写成全尺寸的「しよ」（「しよくほう」＝しょくほう），
// 所以 ぁぃぅぇぉゃゅょっ 一律折叠到对应的大写假名后比较，两种写法算同一个读音。
const KANA_FOLD = {
  "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お",
  "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "っ": "つ", "ゎ": "わ", "ゕ": "か", "ゖ": "け",
};

function foldKana(value) {
  return String(value || "").replace(/[\u3041-\u3096\u30a1-\u30f6]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const hira = code >= 0x30a1 ? String.fromCharCode(code - 0x60) : ch;
    return KANA_FOLD[hira] || hira;
  });
}

function normalizeRubyText(value) {
  return foldKana(stripMarks(String(value == null ? "" : value).normalize("NFKC"))).toLowerCase();
}

/** 开关：`TRANSCOMPARATOR_TERM_RUBY=0` 关闭「注音条目必须基文+注文对上」（仅用于对比排查）。 */
function rubyStrictDefault(env = process.env) {
  return String((env && env.TRANSCOMPARATOR_TERM_RUBY) ?? "1") !== "0";
}

/** 该条目是否受注音口径约束：非人名 + 声明了注音 + 注音能归一成可比对的读音。 */
function entryNeedsRuby(entry) {
  return Boolean(entry && entry.ruby && entry.rubyKeys && entry.rubyKeys.length
    && !PERSON_TYPE.test(String(entry.type || "")));
}

/**
 * 注文有没有在本行对上：
 * 1. 本行存在注音对，其基文与该条目写法互相包含（原文常把长条目拆成「注音段 + 明文段」），
 *    且读音等于该条目的注文（整串或其中一段）；
 * 2. 或注文本身以正文形式出现在本行（原文直接写出了那个别名，不是用注音标注）。
 * 两者都不成立时，这个候选**不算命中**：正文里的同一个汉字词可能只是普通词义。
 */
function rubyEvidenceMatches(entry, alias, pairs = [], plain = "") {
  const expected = entry.rubyKeys || [];
  if (!expected.length) return false;
  const aliasKey = normalizeRubyText(alias);
  if (!aliasKey) return false;
  const matched = pairs.some((pair) => {
    const base = normalizeRubyText(pair.base);
    if (base.length < 2) return false;
    if (!base.includes(aliasKey) && !aliasKey.includes(base)) return false;
    return expected.includes(normalizeRubyText(pair.ruby));
  });
  if (matched) return true;
  const plainKey = normalizeRubyText(plain);
  return expected.some((key) => key.length >= 2 && plainKey.includes(key));
}

/**
 * 译文侧的注音证据：本行译文里出现了该条目的**中文注音形态**（成品 `<ruby>基文<rt>注音</rt></ruby>`
 * 与稿件 `|基文[注音]` 两种形态都认，由 `rubyPairs` 解析）。满足任一条即算对上：
 * 1. 注音落在该条目的**中文译名**上（基文互相包含，容忍方括号/字形/简繁差异）；
 * 2. 注音内容就是表里那条读音（`ruby_ori` 归一后的假名，或 `ruby_trans` 英文列）——译文用了
 *    别的中文写法但注音指的还是同一个词，这正是「译名不一致」的典型形态：
 *    表里 `【念動能力】/テレキネシス`，译文写「念动力`<Telekinesis>`」。
 *
 * 为什么需要译文侧证据：见文件头——`ruby_ori` 一列同时装着“特殊别名读音”和“这个词本身的普通读音”，
 * 前者（発信機/ナノデバイス）只对上基文会误判，后者（魔術/まじゅつ）却永远不会带注音。
 * 真正的注音专有名词在中日两侧都注音，所以「译文也注了这个词」能把两者分开：
 * 有它才按完整口径判定，没有它降级为只作一致性证据。
 *
 * 第 1 条不校验注音内容（中文侧注音多是拉丁原名 Level 5/Mental Out，与表里的注文并不总一致）；
 * 第 2 条反过来只认注音内容。两条都不要求基文与表里译名一致——否则“译文没按表里译名写”
 * 这件事本身就会让证据消失，指控永远无从谈起。
 */
function targetRubyEvidenceMatches(entry, pairs = []) {
  const key = entry && entry.compareKey;
  const expected = (entry && entry.rubyKeys) || [];
  const latin = normalizeRubyText((entry && entry.rubyTarget) || "");
  if (!latin && !expected.length && (!key || key.length < 2)) return false;
  return pairs.some((pair) => {
    const base = normalizeForCompare(pair.base);
    if (base.length < 2) return false;
    if (key && key.length >= 2 && (base.includes(key) || key.includes(base))) return true;
    const ruby = normalizeRubyText(pair.ruby);
    if (!ruby) return false;
    if (latin && ruby === latin) return true;
    return expected.includes(ruby);
  });
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

/**
 * 展示/注入用的去方括号：只拿掉表格用来标记注音位置的括号，保留术语本身的标点。
 *
 * 不能复用 stripMarks：它为了让 `伊斯瑞·雷加第` 与 `伊斯瑞雷加第` 命中同一个术语，会删掉
 * 姓名间隔号等装饰符。若把同一结果拿去给模型看，标准译名会被改写成错的（真实回归：
 * `伊斯瑞·雷加第` 在提示词里变成 `伊斯瑞雷加第`，模型据此写回了无间隔号的修订结果）。
 */
function stripBracketMarks(value) {
  return BRACKET_PAIRS.reduce(
    (text, [open, close]) => text.split(open).join("").split(close).join(""),
    String(value || ""),
  ).trim();
}

function normalizeForCompare(value) {
  return toCn(stripMarks(value)).toLowerCase();
}

function termAliases(entry) {
  const aliases = new Map();
  // scope 说明这个别名能用来做什么：
  // - term：别名就是术语本身（基文/写法），可以用整条译名判定一致性；
  // - part：只是术语的一个分段（姓、名），译文里对应的中文无法可靠切分，只记录不判定；
  // - ruby：只是读音（基文与读音可能对应不同中文，例如「【発信器】」读作「はっしんき」），
  //         拿基文译名去判定会误报，因此同样只记录不判定。
  const add = (alias, scope, weight) => {
    const value = String(alias || "").trim();
    if (!isAliasUsable(value)) return;
    if (/^[\s\p{P}\p{S}]+$/u.test(value)) return;
    const existing = aliases.get(value);
    if (!existing || existing.weight < weight) {
      // strong：基文别名达到门槛（见 TERM_STRONG_MIN_LENGTH）才够格判定“不一致”。
      // 读音别名永不算 strong：它只是发音证据。
      aliases.set(value, { alias: value, scope, weight, strong: scope === "term" && value.length >= TERM_STRONG_MIN_LENGTH });
    }
  };

  // 原文去方括号后的整条写法才是正文里真正会出现的形态（方括号只标记注音位置），权重最高。
  add(stripMarks(entry.source), "term", 5);
  const sourceParts = entry.sourceParts || [];
  if (sourceParts.length === 1) {
    // 单段条目：方括号只是包裹，去掉后与整体一致。
    add(sourceParts[0], "term", 4);
  } else {
    for (const part of sourceParts) add(part, "part", 3);
  }

  // 注音：逗号分隔的多段读音**按顺序**对应原文的各个方括号分段（「【御坂】【美琴】」+「みさか,みこと」）。
  // 因此不能把各段读音当成互相独立的别名（那会把「美琴」的读音挂到别的名字上），
  // 而是整串读音连同每个分段各自的读音一起收录。
  const ruby = String(entry.ruby || "").trim();
  if (ruby) {
    const plainRuby = stripMarks(ruby);
    const rubyParts = ruby.split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
    add(plainRuby, "ruby", 2);
    if (rubyParts.length === 1) {
      add(rubyParts[0], "ruby", 2);
    } else if (rubyParts.length === sourceParts.length) {
      sourceParts.forEach((part, index) => {
        add(rubyParts[index], "ruby", 2);
        // 「御坂（みさか）」这种“分段基文 + 它的读音”组合写法，比只写假名更不容易撞车。
        add(`${stripMarks(part)}（${rubyParts[index]}）`, "ruby", 2);
      });
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
    // 展示与注入只去掉标记注音位置的方括号，保留术语表里的间隔号/连字符等标点；
    // 真正匹配仍走 aliases 与 compareKey 的无装饰归一形式。
    plainSource: stripBracketMarks(source) || source.trim(),
    plainTarget: stripBracketMarks(target) || target.trim(),
    ruby: firstColumn(record, COLUMN_CANDIDATES.ruby).trim(),
    target: target.trim(),
    targetText: stripBracketMarks(target) || target.trim(),
    rubyTarget: firstColumn(record, COLUMN_CANDIDATES.rubyTarget).trim(),
    other: firstColumn(record, COLUMN_CANDIDATES.other).trim(),
    type: firstColumn(record, COLUMN_CANDIDATES.type).trim(),
    memos: COLUMN_CANDIDATES.memo.map((key) => record[key]).filter(Boolean),
  };
  entry.aliases = termAliases(entry);
  // 注文的可比对形态（整串 + 各段）：非人名条目要用它校验「注文有没有在原文里对上」。
  const rubyParts = entry.ruby ? entry.ruby.split(/[,，、]/).map((item) => item.trim()).filter(Boolean) : [];
  const rubyKeys = [];
  if (entry.ruby) {
    for (const value of [stripMarks(entry.ruby), rubyParts.join("")]) {
      const key = normalizeRubyText(value);
      if (key && !rubyKeys.includes(key)) rubyKeys.push(key);
    }
    for (const part of rubyParts) {
      const key = normalizeRubyText(part);
      if (key.length >= 2 && !rubyKeys.includes(key)) rubyKeys.push(key);
    }
  }
  entry.rubyParts = rubyParts;
  entry.rubyKeys = rubyKeys;
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
  requireColumns(headers, { 原文: COLUMN_CANDIDATES.source, 译名: COLUMN_CANDIDATES.target }, "译名表");
  const entries = records.map(normalizeTermEntry).filter(Boolean);
  if (!entries.length) {
    throw new Error(`译名表没有可用条目（需要原文列与译名列）：${file}`);
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
 *
 * @param {string} sourceText 原文（**带内联标记的原始文本**：注音校验要看 `<ruby>/<rt>`，
 *   调用方不要预先 strip——内部自己剥掉注音内容做字面匹配，再单独解析注音对）。
 * @param {object} tables loadTermTables 的结果。
 * @param {object} [options] `rubyStrict` 覆盖开关；`target` 本行译文（带内联标记的原始文本，
 *   用于「中文译名也被注音」这第二个证据；**不提供时退回只看原文侧口径**，调用方应尽量提供）；
 *   `rejected` 收集因注音证据不足而未算命中的候选；`demoted` 收集降级为「只作一致性证据」的候选。
 */
function findTermHits(sourceText, tables, options = {}) {
  const raw = String(sourceText || "");
  const text = stripInlineMarkup(raw);
  if (!text || !tables || !tables.entries || !tables.entries.length) return [];
  const rubyStrict = options.rubyStrict === undefined ? rubyStrictDefault() : Boolean(options.rubyStrict);
  const rejected = options.rejected || null;
  const demoted = options.demoted || null;
  // 译文侧证据只在调用方给了译文时启用：没给（例如只做原文侧的离线排查）就退回旧口径，
  // 不能因为“拿不到译文”把带特殊注音的专有名词整批当成降级。
  const hasTarget = options.target !== undefined && options.target !== null;
  const pairs = rubyStrict ? rubyPairs(raw) : [];
  const targetPairs = rubyStrict && hasTarget ? rubyPairs(String(options.target)) : [];
  const targetKey = rubyStrict && hasTarget ? normalizeForCompare(stripInlineMarkup(String(options.target))) : "";
  const hits = new Map();
  const tried = new Set();
  const rejectedEntries = new Set();
  const demotedEntries = new Set();
  for (const char of new Set(Array.from(text))) {
    const bucket = tables.buckets.get(char);
    if (!bucket) continue;
    for (const candidate of bucket) {
      const { alias, entry, scope, strong } = candidate;
      const key = `${entry.source}\u0000${alias}`;
      if (tried.has(key)) continue;
      tried.add(key);
      if (!hasUsableMatch(text, alias)) continue;
      // 读音别名（原文只写了读音）不设这道门槛：它只能确认一致、不能指控译名错误（strong 恒为 false），
      // 与「降级为只作一致性证据」等价。基文/分段别名则要在带注音的条目上过「双侧注音」这一关。
      let demotedHit = false;
      if (rubyStrict && scope !== "ruby" && entryNeedsRuby(entry)) {
        const sourceOk = rubyEvidenceMatches(entry, alias, pairs, text);
        const full = hasTarget ? (sourceOk && targetRubyEvidenceMatches(entry, targetPairs)) : sourceOk;
        if (!full) {
          // 降级：只有译文确实用了该译名时才算命中（只作一致性证据），否则整条不算命中。
          if (!checkTargetConsistency(entry, targetKey)) {
            if (rejected && !rejectedEntries.has(entry.source)) {
              rejectedEntries.add(entry.source);
              rejected.push({ entry, alias, scope });
            }
            continue;
          }
          demotedHit = true;
          if (demoted && !demotedEntries.has(entry.source)) {
            demotedEntries.add(entry.source);
            demoted.push({ entry, alias, scope });
          }
        }
      }
      const current = hits.get(entry.source);
      const incoming = {
        entry,
        alias,
        scope,
        // 降级命中只作一致性证据：永远不是强证据，因此不会被判成译名差异。
        strong: demotedHit ? false : strong,
        demoted: demotedHit,
      };
      // 同一条目上的择优顺序（前一条成立就不再往后看）：
      // ① 强证据 > 弱证据；② 整条术语 > 分段/读音别名（读音别名不走注音门槛，别抢占整条命中）；
      // ③ 同档内 完整口径 > 降级口径；④ 别名更长。
      const better = !current
        || (!current.strong && incoming.strong)
        || (current.scope !== "term" && scope === "term")
        || (current.scope === scope && current.demoted && !incoming.demoted)
        || (current.scope === scope && current.demoted === incoming.demoted
          && current.strong === incoming.strong && alias.length > current.alias.length);
      if (better) hits.set(entry.source, incoming);
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
 * 把一组别名在正文里**真正用到的那些**标出来（长别名优先、互不重叠），返回实际标出的别名。
 *
 * 匹配口径与 findTermHits 一致（去方括号、片假名不落在更长片假名词内部），只是这里要一并处理
 * 同一条目的多种写法（「東雲太郎」与读音「しののめ」）。语料级保守：短假名的字面包含不算使用，
 * 否则「みさか」会因为在「みさかみこと」里出现，把无关的名字也算成命中。
 *
 * 覆盖率与提示词共用这一个函数，避免两处对“这个别名算不算被用到”给出不同答案。
 */
function markUsedTermAliases(plainText, aliases = [], { includeParts = true } = {}) {
  const plain = String(plainText || "");
  const occupied = new Array(plain.length).fill(false);
  const used = [];
  // 调用方可能直接给别名对象（`entry.aliases` 的元素），也可能给字符串：两种都接受。
  // `includeParts: false` 时忽略分段别名（只写姓或名）：分段写法能“确认一致”，但不能反过来说明
  // 本行用的是这个整条术语——「御坂」单独出现时既可能指美琴，也可能指美铃或旅挂。
  const candidates = [...new Set((aliases || [])
    .filter((item) => includeParts || !(item && typeof item === "object" && item.scope === "part"))
    .map((item) => stripMarks(item && typeof item === "object" ? item.alias : item))
    .filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const alias of candidates) {
    const starts = [];
    let from = 0;
    while (from <= plain.length) {
      const at = plain.indexOf(alias, from);
      if (at < 0) break;
      from = at + 1;
      const end = at + alias.length;
      // 与已占用区间重叠（例如「東雲寺」占掉后，其中的「東雲」不再计入）：跳过这一次出现。
      if (occupied.slice(at, end).some(Boolean)) continue;
      if (!hasUsableMatch(plain, alias)) continue;
      starts.push(at);
    }
    let usedHere = false;
    for (const at of starts) {
      const end = at + alias.length;
      if (occupied.slice(at, end).some(Boolean)) continue;
      occupied.fill(true, at, end);
      usedHere = true;
    }
    // 该别名的每次出现都被更长的别名占掉了（例如「太郎」落在「東雲太郎」里）：不算它被用到。
    if (usedHere) used.push({ alias, length: alias.length });
  }
  return { plain, occupied, used };
}

/** 有效字符统计：既不是空白也不是标点/符号的字符才算内容，句读不参与残留判定。 */
function countEffectiveChars(plain, occupied = []) {
  let chars = 0;
  let residue = 0;
  let residueText = "";
  for (let index = 0; index < plain.length; index += 1) {
    if (!EFFECTIVE_CHAR.test(plain[index])) continue;
    chars += 1;
    if (!occupied[index]) {
      residue += 1;
      residueText += plain[index];
    }
  }
  return { chars, residue, residueText };
}

/**
 * 术语覆盖率：把条目可用别名（长别名优先、互不重叠）从原文里划掉，看还剩多少有效内容。
 *
 * 这是「整句话是否只有术语」的唯一度量，只测原文侧——译文侧的一致性由 checkTargetConsistency 判定。
 * 同一条目可能有多条可用别名（「東雲太郎」与读音「しののめ」），都要参与划除：
 * 只按命中时选中的那一条算，会把同一行里另一种写法算成“术语之外的内容”。
 * @returns {{ chars: number, matched: number, residue: number, residueText: string, ratio: number, skip: boolean }}
 */
function measureTermCoverage(sourceText, hits) {
  const plain = stripInlineMarkup(sourceText);
  const aliases = [];
  for (const hit of hits || []) {
    // 同一别名可能由多个条目共有（例如两个同姓角色）：只要有一个条目也算命中，就按占用算。
    for (const alias of (hit.aliases && hit.aliases.length ? hit.aliases : [{ alias: hit.alias }])) {
      aliases.push(alias);
    }
  }
  const { occupied, used } = markUsedTermAliases(plain, aliases, { includeParts: false });
  const matched = used.reduce((sum, item) => sum + item.length, 0);
  const { chars, residue, residueText } = countEffectiveChars(plain, occupied);
  const ratio = chars ? residue / chars : 1;
  const skip = HAS_EFFECTIVE_CHAR.test(plain)
    && Boolean(hits && hits.length)
    && residue <= TERM_ONLY_FREE_CHARS
    && ratio <= TERM_ONLY_FREE_RATIO;
  return { chars, matched, residue, residueText, ratio, skip };
}

/**
 * 判定一行：命中译名表则返回 { kind, hits, revisedText? }；证据不足时返回 null（交回后续流程）。
 *
 * kind 的三种取值说明这行接下来怎么走：
 * - `term-only`：命中一致，且原文的有效内容本身就是这些术语（术语之外只剩句读），
 *   整行没有别的可校内容，可以直接出结论、不调用模型；
 * - `consistent`：命中一致，但句中还有术语之外的内容——一致性只覆盖术语，
 *   这一行必须照常交给模型，术语只作为提示词注入；
 * - `conflict`：命中强证据的译名不一致——**同样交给模型**（`applyTermTable` 把冲突线索写进提示词，
 *   并让这些行豁免预筛）；这里算出的 `revisedText`（若只替换术语会是什么样）只作离线审计参考。
 *
 * 覆盖率与“确认一致”的证据都要求**整条术语或它的读音**在本行出现：只命中分段（只写姓或名，
 * 例如单独一个「御坂」）不足以说明本行用的是这个术语——同姓的其他角色同样会被它命中——
 * 所以分段命中只被记录、不参与判定，也不参与覆盖率。
 *
 * 保守判定规则：
 * 1. 只有“强证据”（达到 `TERM_STRONG_MIN_LENGTH` 的基文别名，现为 3 字）才能判“译名不一致”，
 *    并把线索写进提示词交给模型；
 * 2. 2 字词、读音别名、分段别名只能“确认一致”，不能指控译名错误——2 字词常以普通词义出现，
 *    读音与基文可能对应不同中文，分段写法（只写姓或名）也说不清本行用的是哪一条；
 * 3. 一行若既没有强证据、也没被确认一致，就不由译名表处理，继续走 AI；
 * 4. 非人名条目声明了注音时，还要**中日两侧都注音**才算“表里那个专有名词”（见文件头）：
 *    只对上原文侧的候选**降级为只作一致性证据**——译文用了该译名才算命中，否则不算命中；
 *    `rubySkipped` 报出被排除的候选条数，`rubyDemoted` 报出降级命中的候选条数。
 */
function evaluateTermRow({ source, target, tables, rejected = null, demoted = null }) {
  const plainSource = stripInlineMarkup(source);
  const plainTarget = stripInlineMarkup(target);
  const collected = [];
  const demotedHits = [];
  const hits = findTermHits(source, tables, { rejected: collected, demoted: demotedHits, target });
  const rubySkipped = collected.length;
  const rubyDemoted = demotedHits.length;
  if (rejected && collected.length) rejected.push(...collected);
  if (demoted && demotedHits.length) demoted.push(...demotedHits);
  if (!hits.length) return null;
  const targetKey = normalizeForCompare(plainTarget);
  // 每条命中都带上该条目**全部**可用别名：覆盖率要按全部写法划除，提示词也要据此判断
  // “这个术语本行到底用到了没有”（只留命中时选中的那一条会漏掉同一术语的另一种写法）。
  const usableAliases = (entry) => entry.aliases || [];
  const results = hits.map(({ entry, alias, scope, strong, demoted: isDemoted }) => {
    const decidable = scope === "term" && strong;
    const via = checkTargetConsistency(entry, targetKey);
    if (!decidable) {
      return {
        entry,
        alias,
        aliases: usableAliases(entry),
        scope,
        strong,
        // 降级命中：原文/译文没有同时注音，只作一致性证据（译文确实用了该译名才留在这里）。
        demoted: isDemoted === true,
        consistent: via ? true : null,
        via,
        variant: null,
        advisory: false,
      };
    }
    const variant = via ? null : findWrongVariant(plainTarget, entry);
    // **存疑（advisory）**：命中的基文别名全是假名（グループ、メンバー、トリック…）时，译名表不足以定论。
    // 这类写法在正文里常常就是普通词，而术语表里它可能只是某个组织名/招式名的写法之一；译文没用该译名，
    // 既可能是译名没统一，也可能这里本来就是普通词义——只有结合上下文的模型（与最终的人工）能判断。
    // 因此标为 advisory：不写译名表结论、不跳过模型，改为把该术语注入提示词后照常交给模型判断。
    const advisory = Boolean(variant === null && !via && KANA_ONLY_BASE.test(String(alias || "")));
    return { entry, alias, aliases: usableAliases(entry), scope, strong, demoted: false, consistent: via ? true : false, via, variant, advisory };
  });
  const advisory = results.filter((result) => result.advisory === true);
  const conflicts = results.filter((result) => result.consistent === false && !result.advisory);
  // 只命中分段写法的行不算「确认一致」：分段别名只能记录，不能证明本行用的是这个术语。
  const confirmed = results.some((result) => result.scope !== "part" && result.consistent === true);
  if (!conflicts.length && !advisory.length && !confirmed) return null;
  if (!conflicts.length) {
    // 覆盖率只在“术语都一致”的前提下有意义：有冲突时整行本来就要处理，不必再算。
    const coverage = measureTermCoverage(plainSource, results);
    return {
      // 有存疑命中时不能判 term-only：这一行还要由模型看“这个术语到底适不适用”，跳过模型就没机会看。
      kind: advisory.length ? "advisory" : (coverage.skip ? "term-only" : "consistent"),
      hits: results,
      coverage,
      advisory,
      revisedText: "",
      rubySkipped,
      rubyDemoted,
    };
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
  return { kind: "conflict", hits: results, advisory, revisedText, rubySkipped, rubyDemoted };
}

/**
 * 备注与提示词里显示的术语形态：一律用**去方括号**的原文与译名。
 * 表里的【】只是给注音标记位置，正文与成品里都不出现，显示成「【山田】【太郎】」会让人
 * 以为正文里真的有这些方括号。
 */
function displayTermPair(entry = {}) {
  const source = entry.plainSource || stripBracketMarks(entry.source) || String(entry.source || "");
  const target = entry.plainTarget || stripBracketMarks(entry.target) || String(entry.target || "");
  return `${source} → ${target}${entry.type ? `（${entry.type}）` : ""}`;
}

/**
 * 基文别名全是假名（グループ、メンバー、トリック、チャネル…）的情形：这类别名常常只是普通词或
 * 音译名，而术语表里它可能只是某个组织名/招式名的写法之一。判定仍在（strong 由基文别名的
 * 长度门槛决定，见 `TERM_STRONG_MIN_LENGTH`），但措辞不能写成“请确认是否需要替换”那种指令口吻
 * ——没有证据表明这处不是普通词义。
 */
const KANA_ONLY_BASE = /^[\u3041-\u3096\u30a1-\u30f6\u30fc\u30fb]+$/u;

function describeTermHit(result) {
  const { entry, alias, consistent, variant, scope, via, strong } = result;
  const pair = displayTermPair(entry);
  if (scope === "part") {
    return `${pair}：原文只出现了分段写法，未参与译名一致性判定。`;
  }
  if (scope === "ruby") {
    return `${pair}：原文只出现了读音写法，基文与读音可能对应不同中文，未参与判定。`;
  }
  if (result.demoted) {
    // 降级命中：本条目的注音没有在中日两侧同时出现，只能当“译文确实用了该项目译名”的证据
    // （降级命中必然是「译文已使用该译名」），不能反过来指控译名错误——那是完整口径才有的结论。
    return `${pair}：原文与译文没有同时注音，只作一致性证据（译文已使用该译名，不据此判定译名对错）。`;
  }
  if (!strong) {
    // 兜底分支：门槛以下的基文写法（1 字，`isAliasUsable` 已经排除，正常走不到这里）不指控译名对错。
    return consistent
      ? `${pair}：译文已使用该译名（写法未达指控门槛，只作为一致性证据）。`
      : `${pair}：原文命中的写法未达指控门槛，不足以判定译名错误，交由后续判断。`;
  }
  if (consistent === true) {
    return via === "part"
      ? `${pair}：译文使用了该译名的分段写法（如只写姓或名）。`
      : `${pair}：译文已使用该译名。`;
  }
  if (variant) return `${pair}：译文里的「${variant.from}」属${variant.kind}，应替换为本项目译名。`;
  if (KANA_ONLY_BASE.test(String(alias || entry.plainSource || entry.source || ""))) {
    // 存疑项：不写成“必须替换”的指控，而是把判断权交回上下文（模型负责判断，人工核对结论）。
    return `${pair}：原文命中的是假名写法（可能是普通词或音译名），译文未使用该译名——请结合上下文判断：此处确指该术语时改用该译名，只是普通词义时按普通词处理，不要强改。`;
  }
  return `${pair}：译文未出现该译名，请人工确认是否需要替换。`;
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
  // 降级命中（原文/译文没有同时注音）单独成群：它只是“译文用了该项目译名”的证据。
  if (result.demoted) return "未双侧注音，只作一致性证据";
  if (!strong) return "未达指控门槛";
  if (consistent === true) return via === "part" ? "译文用分段写法" : "译文已用译名";
  return "未确认";
}

function formatTermHitGroups(hits = []) {
  const groups = new Map();
  for (const hit of hits) {
    const label = termHitGroupLabel(hit);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(displayTermPair(hit.entry));
  }
  return [...groups.entries()]
    .map(([label, items]) => `${label} ${items.join("、")}`)
    .join("；");
}

function termTableSummary(tables) {
  return `译名表：${tables.files.length} 张表 / ${tables.entries.length} 条术语`;
}

/**
 * 归一化译名表路径并去重：同一张表可能同时由特化档案、环境变量和命令行给出，
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
  PERSON_TYPE,
  TERM_STRONG_MIN_LENGTH,
  TERM_ONLY_FREE_CHARS,
  TERM_ONLY_FREE_RATIO,
  describeTermHit,
  displayTermPair,
  entryNeedsRuby,
  evaluateTermRow,
  findTermHits,
  findWrongVariant,
  formatTermHitGroups,
  hasUsableMatch,
  isAliasUsable,
  loadTermTable,
  loadTermTables,
  markUsedTermAliases,
  measureTermCoverage,
  normalizeForCompare,
  normalizeRubyText,
  normalizeTermEntry,
  normalizeTermTablePaths,
  rubyEvidenceMatches,
  rubyPairs,
  rubyStrictDefault,
  splitBracketed,
  stripBracketMarks,
  stripInlineMarkup,
  stripMarks,
  targetRubyEvidenceMatches,
  termAliases,
  termTableSummary,
};
