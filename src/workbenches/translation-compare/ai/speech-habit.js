/**
 * 特化侧的第三类内容：说话习惯层（角色口癖与说话特色）。
 *
 * 为什么不做逐行判断：一行台词往往看不出说话人，而说话特色（第一人称、句尾语气词、
 * 句式、称谓）是“整章/整卷”的属性。因此这一层按 **章**（行数据的 chapter 字段）
 * 判断——先在该章全文里用说话人关键词确定出现的角色，再据此给模型规则与补回线索。
 *
 * 表结构（按表头识别，大小写与空白不敏感）：
 * - 角色：人物名（必填）
 * - 口癖：日文原词（如「オレ」「なの」），可为空（此时只有备注描述，如“句尾最后一个假名变为片假名”）
 * - 类型：第一人称 / 句末语气词 / 句首语气词 / 接续词 / 谓语形式 / 句式 / 称谓 / 名词前缀 / 名词后缀 / 短句
 * - x版：本项目（成品）的写法，是“补回”的唯一标准；`-` 表示本项目明确不作特殊处理
 * - 网翻 / 台版（转简中）：其他版本写法；固定写法条目用它提醒模型不要回改，
 *   明确不作特殊处理的条目用它提醒模型不要套用旧译法
 * - 备注：说明
 * - 小说首次出现：该角色首次登场的卷号（如 S1_01），用于按卷过滤不可能出现的角色
 */
const path = require("path");
const { readRecords } = require("../../../core/spreadsheet");

const COLUMN_CANDIDATES = {
  character: ["角色", "人物", "character", "name"],
  habit: ["口癖", "habit", "特徴", "特征"],
  type: ["类型", "type"],
  xVersion: ["x版", "x版本", "本项目", "成品"],
  netVersion: ["网翻", "网络翻译", "网译"],
  twVersion: ["台版（转简中）", "台版", "繁中"],
  memo: ["备注", "说明", "memo"],
  firstWork: ["小说首次出现", "首次出现", "登场", "初登场"],
};

const EMPTY_VALUES = new Set(["", "-", "—", "－", "/", "无", "n/a", "na", "none"]);
const NO_SPECIAL_MARKERS = new Set(["-", "—", "－"]);
const NAME_SEPARATORS = /[·・\s]/;
// 只有这些类型的口癖适合做字面“流失”检测：它们是与具体词绑定的用法。
// 句式、称谓、名词前缀/后缀等是结构性特征（如「〜然」「ちゃん」「XX力」），只能靠提示词说明，
// 逐字比对会大量误报。
const DETECTABLE_TYPES = new Set(["第一人称", "接续词", "句首语气词", "句末语气词", "谓语形式"]);
const KANA = /[\u3040-\u309f\u30a0-\u30ff\u30fc]/;
// 汉字（含 CJK 扩展 A 与兼容区）：单字汉字口癖（「力」这类名词后缀）的定位判据要用它。
const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// 「词首」的判据：行首、空白、中日文标点与成对标记（「」『』（）《》【】〔〕…—～・等）。
// 反过来，前一个字是汉字/假名/字母数字时都算“落在更长的词里”，不算该用法的出现。
const WORD_BOUNDARY = /[\s\u3000、。，．！？：；「」『』（）〈〉《》【】〔〕・…—～＝＠＃＄％＆＊＋／]/;
// 第一人称常直接接格助词或系助词（わらわから、オレは、あたしの）；不能只按前一个字判词界，
// 否则「知っているわらわからすれば」会被前面的「る」挡住。
const FIRST_PERSON_AFTER_PARTICLE = /^[はがをにへとでやのかもばねよぞさえこそまで]/;
const SENTENCE_END_CHARS = "」』）)。．.!！？?…—～~、,，:：;； \t☆★♪♡♥";

function firstColumn(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

/**
 * 角色条目的两种包装形态统一取值：现算路径给 `{ entry, activated }`，落盘块还原路径给
 * `{ ...entry 字段..., activated }`（见 `speech-habit-layer.js` 的 `characterDescriptor`）。
 * 行级判据（候选、行级收窄）两条路径都用同一份实现，所以这一步必须只在这里做一次。
 */
function entryOf(item) {
  return item?.entry || item || {};
}

function isPlaceholder(value) {
  return EMPTY_VALUES.has(String(value || "").trim().toLowerCase());
}

function isNoSpecialMarker(value) {
  return NO_SPECIAL_MARKERS.has(String(value || "").trim());
}

function cleanVersion(value) {
  return isPlaceholder(value) ? "" : String(value).trim();
}

/** 卷号（如 S3_01）→ 可比较的序号；只认 S<系列>_<卷序> 形式。 */
function volumeKey(code) {
  const match = String(code || "").match(/S(\d+)_(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  return { series: Number(match[1]), volume: Number(match[2]), code: `S${match[1]}_${match[2]}` };
}

function compareVolume(left, right) {
  if (!left || !right) return 0;
  if (left.series !== right.series) return left.series - right.series;
  return left.volume - right.volume;
}

/** 从输入文件路径里提取当前卷号：`[S3_01]創約 …` → S3_01。 */
function volumeKeyFromFiles(files = {}) {
  for (const value of Object.values(files || {})) {
    const match = String(value || "").match(/\[(S\d+_\d+(?:\.\d+)?)\]/i);
    if (match) return volumeKey(match[1]);
  }
  return null;
}

/**
 * 说话人关键词：全名（强证据）+ 名字片段（弱证据）。
 * 片段只用于“补强”，不能单独判定角色出现——否则「佐藤」会命中任何提到该姓氏的章。
 */
function characterAliases(character) {
  const name = String(character || "").trim();
  const strong = new Set([name]);
  const withoutSeparator = name.replace(/[·・\s]/g, "");
  if (withoutSeparator !== name) strong.add(withoutSeparator);

  const weak = new Set();
  const parts = name.split(NAME_SEPARATORS).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    for (const part of parts) if (part.length >= 2) weak.add(part);
  } else if (name.length >= 3) {
    // 中文名：姓氏与名字部分各取 2 字，仅作弱证据。
    weak.add(name.slice(0, 2));
    weak.add(name.slice(-2));
  }
  for (const value of strong) weak.delete(value);
  return { strong: [...strong], weak: [...weak] };
}

function normalizeSpeechEntry(record) {
  const character = firstColumn(record, COLUMN_CANDIDATES.character);
  if (!character) return null;
  const habit = cleanVersion(firstColumn(record, COLUMN_CANDIDATES.habit));
  const xVersion = firstColumn(record, COLUMN_CANDIDATES.xVersion);
  const entry = {
    character,
    habit,
    type: firstColumn(record, COLUMN_CANDIDATES.type),
    versions: {
      x: cleanVersion(xVersion),
      net: cleanVersion(firstColumn(record, COLUMN_CANDIDATES.netVersion)),
      tw: cleanVersion(firstColumn(record, COLUMN_CANDIDATES.twVersion)),
    },
    // `-` 是明确口径，不是空值/忽略；必须保留状态，才能把它作为硬规则注入提示词。
    noSpecialHandling: isNoSpecialMarker(xVersion),
    memo: firstColumn(record, COLUMN_CANDIDATES.memo),
    firstWork: firstColumn(record, COLUMN_CANDIDATES.firstWork),
  };
  entry.firstWorkKey = volumeKey(entry.firstWork);
  entry.aliases = characterAliases(character);
  // 只有实际登记的 x版 才能作为“特色流失”的判定基准。
  // `-` 表示明确不特殊处理，版本列只用于提示模型不要套用那些写法，不参与补回。
  entry.expectedWritings = entry.versions.x ? [entry.versions.x] : [];
  entry.hasLiteralHabit = Boolean(entry.habit) && !isPlaceholder(entry.habit);
  return entry;
}

/**
 * 内化的说话习惯表：一个被 require 的模块，直接给出条目数组。
 * 表可以长在自己的档案文件里（示范档案就是这么做的：`speechTables: [require.resolve(__filename)]`
 * ——角色数据与规范正文收在同一个文件，不再为数据另开文件），也可以是仓库内单独的数据模块。
 * 与表格路径共用同一条消费链——指纹照旧按该文件的 mtime/size 算，因此改条目后运行期会判过期并提示重建。
 * 形态判定：导出对象带 `entries` 数组即视为内化表；带路径的表格仍走 `readRecords`。
 */
function loadSpeechModule(file) {
  const resolved = path.resolve(file);
  // 先清掉本模块的缓存再 require：同一进程里表被改过时（运行期按指纹发现过期后重算）能读到新内容。
  delete require.cache[resolved];
  const module = require(resolved);
  if (!module || !Array.isArray(module.entries)) {
    throw new Error(`内化的说话习惯表必须导出 { entries: [...] }：${file}`);
  }
  const entries = module.entries.map((item) => normalizeSpeechEntry({
    ...item,
    // 内化表用的是字段名而不是表头，这里转成 readRecords 的记录形态，保证两条路径的归一化只有一份实现。
    角色: item.character,
    口癖: item.habit,
    类型: item.type,
    x版: item.versions?.x,
    网翻: item.versions?.net,
    "台版（转简中）": item.versions?.tw,
    备注: item.memo,
    小说首次出现: item.firstWork,
  })).filter(Boolean);
  if (!entries.length) throw new Error(`内化的说话习惯表没有可用条目（需要 entries[].character）：${file}`);
  // 内化表可以直接长在档案文件里（示范档案就是这么做的：`speechTables: [require.resolve(__filename)]`），
  // 那种情况下没有 `sheet`/`name` 可借，退回文件名——它只用于状态显示与日志，不参与判定。
  const sheet = module.sheet || module.tableName || path.basename(resolved);
  return { file: resolved, sheet, entries };
}

function loadSpeechTable(file) {
  const text = String(file || "").trim();
  if (!text) throw new Error("说话习惯表路径为空。");
  if (/\.(js|cjs|mjs)$/i.test(text)) return loadSpeechModule(text);
  const { sheet, records } = readRecords(text);
  const entries = records.map(normalizeSpeechEntry).filter(Boolean);
  if (!entries.length) throw new Error(`说话习惯表没有可用条目（需要“角色”列）：${file}`);
  return { file, sheet, entries };
}

function normalizeSpeechTablePaths(paths = []) {
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

function loadSpeechTables(files = []) {
  const unique = normalizeSpeechTablePaths(files);
  const entries = [];
  const sheetNames = [];
  const errors = [];
  for (const file of unique) {
    try {
      const table = loadSpeechTable(file);
      entries.push(...table.entries);
      sheetNames.push(table.sheet || path.basename(file));
    } catch (error) {
      errors.push(`${file}：${error.message}`);
    }
  }
  return { files: unique, sheetNames, entries, errors };
}

function speechTableSummary(tables) {
  return `说话习惯：${tables.files.length} 张表 / ${tables.entries.length} 条`;
}

/**
 * 按章分组：行数据自带 chapter，按内容顺序切段，章名相同的连续行归为一章。
 * 没有 chapter（或为空）时整卷视作一章。
 */
function groupRowsByChapter(rows = []) {
  const groups = [];
  for (const row of rows) {
    const chapter = String(row.chapter || "").trim() || "（未标注章节）";
    const last = groups.at(-1);
    if (last && last.chapter === chapter) {
      last.rows.push(row);
    } else {
      groups.push({ chapter, rows: [row] });
    }
  }
  return groups;
}

/**
 * 章/卷内的角色判定：**名字命中**才算启用该角色的说话习惯（全名或去分隔符全名）。
 * 名字片段（姓、名、西式名的局部）只作为“可能提及”的线索进报告，不启用习惯规则——
 * 否则「佐藤」会因为「佐藤一郎」登场而把「佐藤花子」也算成本章登场。
 * 先按卷过滤：卷号晚于当前卷的“首次出现”角色不可能在本卷登场。
 */
function detectCharacters({ rows = [], tables, volume = null, weakThreshold = 3 } = {}) {
  const detected = [];
  for (const entry of tables?.entries || []) {
    if (volume && entry.firstWorkKey && compareVolume(entry.firstWorkKey, volume) > 0) continue;
    let strongRows = 0;
    let weakRows = 0;
    const rowsHit = [];
    for (const row of rows) {
      const text = `${row.jp || ""}\n${row.cn || ""}`;
      const strong = entry.aliases.strong.some((alias) => text.includes(alias));
      const weak = !strong && entry.aliases.weak.some((alias) => text.includes(alias));
      if (!strong && !weak) continue;
      if (strong) strongRows += 1;
      else weakRows += 1;
      if (!rowsHit.includes(row.index)) rowsHit.push(row.index);
    }
    if (!strongRows && weakRows < weakThreshold) continue;
    detected.push({
      entry,
      strongRows,
      weakRows,
      rows: rowsHit,
      // 只有名字命中才启用该角色的习惯规则；纯片段命中只报告。
      activated: strongRows > 0,
      detectedBy: strongRows ? "名字命中" : "名字片段",
    });
  }
  return detected.sort((a, b) => Number(b.activated) - Number(a.activated) || b.strongRows - a.strongRows || b.weakRows - a.weakRows);
}

function describeHabit(entry) {
  const parts = [];
  if (entry.type) parts.push(entry.type);
  if (entry.habit) parts.push(`「${entry.habit}」`);
  const head = parts.length ? parts.join(" ") : "说话特色";
  const writings = [];
  if (entry.versions.x) {
    writings.push(`本项目写作「${entry.versions.x}」`);
    const legacy = [entry.versions.net, entry.versions.tw].filter((value) => value && value !== entry.versions.x);
    if (legacy.length) writings.push(`${legacy.map((value) => `「${value}」`).join("、")}（旧写法，不要回改）`);
  } else if (entry.noSpecialHandling) {
    const forbidden = [
      entry.versions.net ? `网翻「${entry.versions.net}」` : "",
      entry.versions.tw ? `台版「${entry.versions.tw}」` : "",
    ].filter(Boolean);
    writings.push(forbidden.length
      ? `不作特殊翻译处理，不得采用网翻版或台版写法（${forbidden.join("；")}）`
      : "不作特殊翻译处理，不得采用网翻版或台版写法");
  }
  if (!writings.length && entry.memo) writings.push(`备注：${entry.memo}`);
  return `${entry.character}：${head}${writings.length ? ` → ${writings.join("；")}` : ""}`;
}

/**
 * 已启用角色的名字（按角色去重）。
 *
 * 一个角色可能有多条习惯（如「力」与「ダゾ」各一条），逐条取名字会让提示词载荷里的
 * characters 出现同一个名字两次，看名字像本章登场了两个角色。规则本身在提示词里逐条列出，
 * 这里只负责“本章有哪些角色”。
 *
 * 兼容两种条目形态：现算路径给 `{ entry, activated }`，落盘块还原路径给 `{ character, activated }`。
 */
function activatedCharacterNames(items = []) {
  const names = [];
  for (const item of items) {
    if (item.activated === false) continue;
    const name = item.character || item.entry?.character || "";
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 注入提示词的角色行：只保留系统真正会用它们做判断的条目。
 * `fixed` 用于补回特色，`no-special` 用于明确禁止套用旧版写法；
 * `locked` 用于中日同形的既有写法（如食蜂操祈的「XX力」），它不参与流失检测，
 * 但必须随角色一起注入，否则模型会把刻意保留的「问题力」当作错字或 OCR 瑕疵删掉。
 */
function habitBlockLines(characters = []) {
  return characters
    .filter((item) => item.activated !== false && isHabitInjectable(item.entry))
    .map((item) => `- ${describeHabit(item.entry)}`);
}

/**
 * 章级提示块：只含本章“名字命中”的角色，作为“刻意特色”的判据注入提示词。
 */
function chapterHabitBlock({ chapter, characters = [] } = {}) {
  const lines = habitBlockLines(characters);
  if (!lines.length) return "";
  return [
    `【说话习惯（本章）】本章「${chapter}」出现了以下角色（按人名命中判定）：角色口癖、第一人称、句尾语气词、称谓与特殊句式是刻意特征；保留它们不算翻译腔、病句、错字或 OCR 瑕疵，不得按“通顺中文”改写或建议删除，网翻/台版旧写法不要回改。`,
    "对已登记本项目写法的条目，原文有该角色的口癖而译文完全没有对应写法时，属于说话特色流失，可给补回特色的最小 revisedText，并在 summary 说明依据；标为“不作特殊翻译处理”的条目不适用这一步。译文多出原文没有的口癖或语气词按增译处理。先确认本行确是该角色在说话且原文有该表达，拿不准就转人工，不凭空加语气。",
    ...lines,
  ].join("\n");
}

/**
 * 卷级提示块：整卷命中人名的角色（章级没命中时的兜底，规则集更宽、token 更多）。
 */
function volumeHabitBlock({ volume, characters = [] } = {}) {
  const lines = habitBlockLines(characters);
  if (!lines.length) return "";
  const label = volume?.code ? `本卷 ${volume.code}` : "本卷";
  return [
    `【说话习惯（${label}）】${label}出现了以下角色（按人名命中判定）：角色口癖、第一人称、句尾语气词、称谓与特殊句式是刻意特征；保留它们不算翻译腔、病句、错字或 OCR 瑕疵，不得按“通顺中文”改写或建议删除，网翻/台版旧写法不要回改。`,
    "对已登记本项目写法的条目，原文有该角色的口癖而译文完全没有对应写法时，属于说话特色流失，可给补回特色的最小 revisedText，并在 summary 说明依据；标为“不作特殊翻译处理”的条目不适用这一步。译文多出原文没有的口癖或语气词按增译处理。先确认本行确是该角色在说话且原文有该表达，拿不准就转人工，不凭空加语气。",
    ...lines,
  ].join("\n");
}

/**
 * 行级说话人候选：本行原文里出现了哪些「说话习惯特征」。
 *
 * 用途是“先让模型判断说话人，再据此处理”：只有命中特征的行才需要判断说话人，
 * 且候选来自本章/本卷已按人名命中的角色（activated），避免把习惯按到没登场的角色身上。
 * 弱证据（只命中名字片段）的角色只作为低置信候选附带给出。
 */
function habitCandidatesForRow({ row, characters = [] } = {}) {
  const jp = String(row?.jp || "");
  if (!jp) return [];
  const candidates = [];
  for (const item of characters) {
    const entry = entryOf(item);
    if (!entry.hasLiteralHabit) continue;
    if (!hasHabitOccurrence(jp, entry)) continue;
    const noSpecialHandling = habitRuleMode(entry) === "no-special";
    candidates.push({
      character: entry.character,
      type: entry.type,
      habit: entry.habit,
      expected: entry.versions.x || "",
      noSpecialHandling,
      forbiddenWritings: noSpecialHandling
        ? [
          entry.versions.net ? { version: "网翻", value: entry.versions.net } : null,
          entry.versions.tw ? { version: "台版", value: entry.versions.tw } : null,
        ].filter(Boolean)
        : [],
      confidence: item.activated === false ? "low" : "high",
      detectable: isHabitDetectable(entry),
    });
  }
  return candidates;
}

/**
 * 本行该拿到哪些角色的说话习惯规则（**按角色收窄**）。
 *
 * 章级判定回答的是“这一章出现了哪些角色”，但一行台词里通常只有一个角色在场：把整章的规则
 * 全塞进每一行，等于让 90% 的行背着与它无关的角色规则（本层是第 3 层之外唯一按章注入的段，
 * 也正是“无脑加进每一个句子”的第二个来源）。收窄判据两条，满足任一即保留：
 * 1. **本行文本提到了该角色**——原文或译文里出现该角色的全名别名（与对照表/译名表口径一致）；
 * 2. **本行原文出现了该角色的任一口癖**——说话人可能没被点名，规则必须留着，否则“特色流失”判不出来。
 *
 * 收窄单位是**角色，不是单条口癖**。一旦某条口癖或名字把角色定出来，该角色的全部可注入规则都要带上：
 * 食蜂操祈的「ダゾ」可能确认了说话人，但这一行真正需要保护的是同形写法「問題力」；若只保留命中的
 * 「ダゾ」条目，模型仍会把「力」当错字删掉。
 *
 * 兜底与其它裁剪同口径：**本行两侧都没有文本时全部保留**（判断不了就不裁剪）。
 * 收窄只影响这一行的注入内容：章级判定、页面徽标与落盘块（`speechHabits`）都不受影响，
 * 因此人工从页面上看到的“本章命中了哪些角色”与收窄前完全一致。
 */
function habitCharactersForRow({ row, characters = [] } = {}) {
  const list = Array.isArray(characters) ? characters : [];
  if (!list.length) return list;
  const jp = String(row?.jp || "");
  const cn = String(row?.cn || row?.target || "");
  if (!jp.trim() && !cn.trim()) return list;
  const text = `${jp}\n${cn}`;
  const byCharacter = new Map();
  for (const item of list) {
    const entry = entryOf(item);
    const character = entry.character || "";
    if (!character) continue;
    if (!byCharacter.has(character)) byCharacter.set(character, []);
    byCharacter.get(character).push(item);
  }
  const matched = [];
  for (const items of byCharacter.values()) {
    const named = items.some((item) => {
      const entry = entryOf(item);
      const aliases = entry.aliases?.strong || characterAliases(entry.character).strong;
      return aliases.some((alias) => alias && text.includes(alias));
    });
    const habitHit = items.some((item) => hasHabitOccurrence(jp, entryOf(item)));
    if (named || habitHit) matched.push(...items);
  }
  return matched;
}

/**
 * 中日文写法相同、但不适合拿来做“补回”检测的既有口癖（如「力」→「力」）。
 * 它们仍必须进入提示词充当锁定写法，防止模型按普通中文习惯删掉刻意后缀。
 */
function isSameShapeWriting(entry) {
  const x = String(entry?.versions?.x || "");
  return Boolean(
    entry?.hasLiteralHabit
    && x
    && x === entry.habit
    && (entry.expectedWritings || []).length,
  );
}

/**
 * 说话习惯条目的提示词处置方式：
 * - fixed：登记了不同的本项目写法，可做“特色流失”检测；
 * - locked：本项目写法与日文同形，不参与流失检测，但必须注入锁定写法；
 * - no-special：X版为 `-`，是明确的不特殊处理，必须注入反回改约束，但不做流失检测；
 * - clue-only：没有本项目写法，也只作为说话人线索；
 * - none：缺少字面口癖或类型不可靠，不进提示词。
 */
function habitRuleMode(entry) {
  if (!entry || !entry.hasLiteralHabit) return "none";
  if (isSameShapeWriting(entry)) return "locked";
  if (!DETECTABLE_TYPES.has(entry.type)) return "none";
  if (String(entry.habit).length < 2) return "none";
  if (entry.noSpecialHandling) return "no-special";
  if (!entry.versions?.x) return "clue-only";
  if (!(entry.expectedWritings || []).length) return "clue-only";
  return "fixed";
}

function isHabitInjectable(entry) {
  const mode = habitRuleMode(entry);
  return mode === "fixed" || mode === "locked" || mode === "no-special";
}

/**
 * 该条目是否适合做字面“流失”检测：
 * - 必须有字面口癖，且类型属于 DETECTABLE_TYPES；
 * - 单字口癖（力、超、訳）会撞普通词，不检测；
 * - 本项目写法与日文原词同形时（力→力、少女→少女）没有“补回”可言，也不检测；
 * - X版为 `-` 时是明确的不特殊处理；没有 X版写法时“译文少了这个特色”也无从判定。
 */
function isHabitDetectable(entry) {
  return habitRuleMode(entry) === "fixed";
}

/**
 * 行级说话习惯块：先按章定位（章级判定不变），再把角色收窄到本行（`habitCharactersForRow`），
 * 最后用与章级同一个 `chapterHabitBlock` 拼块——两条路径（落盘块还原 / 现算）都走这里，
 * 因此产出的提示词必然逐字一致（`scripts/speech-habit-layer.test.js` 有等价性断言）。
 */
function speechHabitBlockForRow({ chapter = "", row = null, characters = [], volume = null, fallbackBlock = "" } = {}) {
  const matched = habitCharactersForRow({ row, characters });
  if (!matched.length) return "";
  const block = volume
    ? volumeHabitBlock({ volume, characters: matched })
    : chapterHabitBlock({ chapter, characters: matched });
  return block || fallbackBlock;
}

/**
 * 说话人判断与习惯处理的提示块：附在章级习惯之后，只在有候选时出现。
 *
 * 候选分两类，口径必须写清：表里已经登记「本项目写法」的口癖才拿来判断译文是否流失这个特色；
 * 没有写法的条目（例如只填了备注“通常放在句尾”）只说明“这句可能是谁在说”，**不能**用来判
 * 译文遗漏——没有比对基准，模型只能凭感觉补一句，那是误报的源头。两类都保留，但要求分开处理。
 */
function speakerCheckBlock({ chapter, candidates = [] } = {}) {
  if (!candidates.length) return "";
  const names = [...new Set(candidates.map((candidate) => candidate.character))];
  const writable = candidates.filter((candidate) => candidate.detectable);
  const noSpecial = candidates.filter((candidate) => candidate.noSpecialHandling);
  const clueOnly = candidates.filter((candidate) => !candidate.detectable && !candidate.noSpecialHandling);
  const list = (items) => items.map((candidate) => `${candidate.character}「${candidate.habit}」`).join("、");
  const lines = [
    `【说话人判断（本章）】本行原文出现了说话习惯特征，候选说话人：${names.join("、")}（本章/本卷出现过该角色）。`,
    "先判断这一行到底是谁在说话，再据此处理：确认是某个候选角色时，按他的说话习惯判断译文是否流失了特色；确认不了或明显是别人时，不要以说话习惯为由判定缺陷，也不要按候选角色的口癖去改写。",
    "译文多出原文没有的口癖或语气词按增译处理；只有当原文确有该习惯表达时才据此判断特色流失。",
    "判断结果填在 speaker 字段（填角色名；确认不了留空字符串）。",
  ];
  if (writable.length) {
    lines.push(`可按本项目写法判断的口癖：${list(writable)}（只有译文完全没有该写法时才算说话特色流失，并按最小改动补回）。`);
  }
  if (noSpecial.length) {
    const noSpecialList = noSpecial.map((candidate) => {
      const forbidden = candidate.forbiddenWritings || [];
      const suffix = forbidden.length
        ? `（不得采用网翻版或台版写法：${forbidden.map((item) => `${item.version}「${item.value}」`).join("；")}）`
        : "（不得采用网翻版或台版写法）";
      return `${candidate.character}「${candidate.habit}」${suffix}`;
    }).join("、");
    lines.push(`本项目明确不作特殊翻译处理的口癖：${noSpecialList}；不得据此判译文缺漏、扣分或要求补写。`);
  }
  if (clueOnly.length) {
    lines.push(`只作说话人线索、不得据此判译文遗漏的口癖：${list(clueOnly)}（本项目尚未登记这些口癖的译法，缺少比对基准；不要因为译文里没有对应写法就判缺漏、扣分或要求补写）。`);
  }
  return lines.join("\n");
}

/**
 * 剥掉行内注音标记，只留基文：`<ruby>基文<rt>读音</rt></ruby>` 与稿件形态 `|基文[读音]` 都要处理。
 *
 * 为什么口癖定位必须用剥过标记的文本：位置判据看的是「口癖前面那个字是什么」，
 * 而带标记时紧挨着的是标签的收尾符——`…<ruby>魔<rt>ま</rt></ruby>力` 会被判成“前面是 `>`”
 * （即词首），于是「魔力」也算成单字口癖「力」的命中。注音标记本身不参与语义判断。
 */
function plainInlineText(text) {
  return String(text || "")
    .replace(/<\s*(?:ruby|rb)\s*>([\s\S]*?)<\s*\/\s*(?:ruby|rb)\s*>/gi, "$1")
    .replace(/<\s*(?:rt|rp)\s*>[\s\S]*?<\s*\/\s*(?:rt|rp)\s*>/gi, "")
    .replace(/\|[^\s|\]]{0,30}\[([^\]\n]{1,40})\]/gu, "$1")
    .replace(/<[^>]*>/g, "");
}

/**
 * 口癖在原文里的出现位置是否算“该用法的出现”：
 * - 句末语气词 / 谓语形式：必须落在句末（后接标点、引号、行尾或 ☆ 这类装饰符号），「じゃん」不会被「じゃんけん」命中；
 * - 单字汉字口癖（名词后缀「力」= XX力）：必须落在**词首**（前面是行首、空白、标点或成对标记）——
 *   这类后缀型口癖在正文里到处撞普通词（風力/火力/磁力/能力/压力…），只按“前面不是假名”判断会让
 *   整章叙述行都命中（实测某卷 37 个说话人候选行里 32 行是「力」撞普通词），说话人判断与特色流失
 *   都成了误报。代价是「超能力」这类汉字连写的真用法也放过——宁可漏判，也不给整章塞错角色；
 * - 第一人称：后面必须接词界或常见助词，前一个字可以是日语语法的一部分（如「ているわらわから」）；
 * - 其余类型（接续词 / 句首语气词 / 未分类）：前面不能是假名或汉字，避免落在更长的词中间。
 * 判定前先剥掉注音标记（`plainInlineText`），否则紧挨着的标签收尾符会被误当成词首。
 */
function hasHabitOccurrence(text, entry) {
  const habit = String(entry.habit || "");
  if (!habit) return false;
  const plain = plainInlineText(text);
  const sentenceEnd = entry.type === "句末语气词" || entry.type === "谓语形式";
  const kanjiHabit = habit.length === 1 && KANJI.test(habit);
  let from = 0;
  while (from <= plain.length) {
    const at = plain.indexOf(habit, from);
    if (at < 0) return false;
    from = at + 1;
    const before = plain[at - 1] || "";
    const after = plain[at + habit.length] || "";
    if (sentenceEnd) {
      if (after === "" || SENTENCE_END_CHARS.includes(after)) return true;
      continue;
    }
    if (kanjiHabit) {
      if (before === "" || WORD_BOUNDARY.test(before)) return true;
      continue;
    }
    if (entry.type === "第一人称") {
      if (after === "" || WORD_BOUNDARY.test(after) || FIRST_PERSON_AFTER_PARTICLE.test(after)) return true;
      continue;
    }
    if (before && (KANA.test(before) || KANJI.test(before))) continue;
    return true;
  }
  return false;
}

/**
 * 行级“补回”线索：原文出现某个口癖、而译文里没有该角色任何版本的写法 → 疑似说话特色流失。
 * 只在“本章/本卷已按人名命中该角色”的前提下检查，避免全表乱报。
 */
function findHabitMisses({ source, target, characters = [] } = {}) {
  const jp = String(source || "");
  const cn = String(target || "");
  const misses = [];
  for (const item of characters) {
    if (item.activated === false) continue;
    const entry = item.entry;
    if (!isHabitDetectable(entry)) continue;
    if (!hasHabitOccurrence(jp, entry)) continue;
    if (entry.expectedWritings.some((writing) => cn.includes(writing))) continue;
    misses.push({
      character: entry.character,
      habit: entry.habit,
      type: entry.type,
      expected: entry.versions.x || "",
      memo: entry.memo,
    });
  }
  return misses;
}

/**
 * 按章/按卷汇总（脚本用）：命中哪些角色、口癖在原文命中多少行、译文是否体现。
 * scope=chapter（默认）逐章汇总；scope=volume 汇总整卷。
 */
function summarizeChapters({ rows = [], tables, volume = null, scope = "chapter" } = {}) {
  if (scope === "volume") {
    const characters = detectCharacters({ rows, tables, volume });
    return [summarizeGroup({ name: volume?.code || "（整卷）", rows, tables, volume, characters })];
  }
  return groupRowsByChapter(rows).map((group) => summarizeGroup({
    name: group.chapter,
    rows: group.rows,
    tables,
    volume,
  }));
}

function summarizeGroup({ name, rows = [], tables, volume = null, characters = null }) {
  const detected = characters || detectCharacters({ rows, tables, volume });
  let habitRows = 0;
  const misses = [];
  for (const row of rows) {
    const found = findHabitMisses({ source: row.jp, target: row.cn, characters: detected });
    if (!found.length) continue;
    habitRows += 1;
    misses.push({ index: row.index, items: found, source: String(row.jp || "").slice(0, 60), target: String(row.cn || "").slice(0, 60) });
  }
  return {
    chapter: name,
    rowCount: rows.length,
    indexRange: [rows[0]?.index, rows.at(-1)?.index],
    characters: detected.map((item) => ({
      character: item.entry.character,
      type: item.entry.type,
      habit: item.entry.habit,
      expected: item.entry.versions.x || "",
      // 三个写法槽位与备注：构建期落盘要原样带上，运行期才能还原出与现算完全一致的提示词块。
      versions: {
        x: item.entry.versions.x || "",
        net: item.entry.versions.net || "",
        tw: item.entry.versions.tw || "",
      },
      noSpecialHandling: Boolean(item.entry.noSpecialHandling),
      memo: item.entry.memo || "",
      detectedBy: item.detectedBy,
      activated: item.activated,
      strongRows: item.strongRows,
      weakRows: item.weakRows,
    })),
    habitRows,
    misses,
  };
}

module.exports = {
  COLUMN_CANDIDATES,
  DETECTABLE_TYPES,
  activatedCharacterNames,
  chapterHabitBlock,
  characterAliases,
  compareVolume,
  describeHabit,
  detectCharacters,
  detectChapterCharacters: detectCharacters,
  entryOf,
  findHabitMisses,
  groupRowsByChapter,
  habitCandidatesForRow,
  habitCharactersForRow,
  hasHabitOccurrence,
  isHabitDetectable,
  loadSpeechTable,
  loadSpeechTables,
  normalizeSpeechEntry,
  normalizeSpeechTablePaths,
  speakerCheckBlock,
  speechHabitBlockForRow,
  speechTableSummary,
  summarizeChapters,
  summarizeGroup,
  volumeHabitBlock,
  volumeKey,
  volumeKeyFromFiles,
};
