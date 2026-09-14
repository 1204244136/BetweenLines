/**
 * 说话习惯层：构建期落盘 + 运行期复用。
 *
 * 分工（为什么这么分）：
 * - 章级判定（本章出现了哪些角色、哪些行疑似说话特色流失）只依赖「整卷行数据 + 说话习惯表」，
 *   与模型无关，因此放在**构建期**算一次，写进 `translation-compare.json` 的 `speechHabits` 顶层块
 *   并嵌进页面：可复现、可审计、人工能先看到结论，AI 任务重跑多次也不必重算。
 * - 行级说话人判断与提示词组装仍在**运行期**：它依赖当行文本与所选档案，且要跟随最新表。
 * - 表可能被改：落盘块带**指纹**（文件名 + mtime + 大小 + 条目数）。运行期指纹一致就复用，
 *   不一致就按最新表现算一次，并在日志里提示重新构建工作台。
 * - 落盘块只存**表文件名**，本机完整路径不进产物（快照与页面都可能被分享）。运行期要重算指纹时，
 *   按「当前档案声明 + 环境变量」重新解析路径（`currentSpeechFiles`），口径与构建期完全一致。
 *
 * 注意：块写在行数据之外（顶层 + 按章索引），不修改任何行字段，因此不改变
 * `rowsSignature`/`signature`，浏览器备注与写回定位不受影响。
 */
const {
  activatedCharacterNames,
  chapterHabitBlock,
  detectCharacters,
  groupRowsByChapter,
  loadSpeechTables,
  normalizeSpeechTablePaths,
  summarizeGroup,
  volumeHabitBlock,
  volumeKeyFromFiles,
} = require("./ai/speech-habit");
const { listProfiles, resolveProfile } = require("./ai/proofread-contract");
const { tableFilesForProfile, tableSourceCandidates } = require("./layer-sources");
const { tableFileNames, tablesFingerprint } = require("../../core/table-fingerprint");

// 4：`-` 作为“明确不特殊处理”注入提示词；旧快照必须按新口径重算。
const LAYER_VERSION = 4;

/**
 * 表指纹：文件状态 + 条目数，任一变化都视为过期。
 * @param {object} [preloaded] 已经解析过的表（避免重复解析大表）
 */
function speechTablesFingerprint(files = [], preloaded = null) {
  const unique = normalizeSpeechTablePaths(files);
  if (!unique.length) return "";
  const entries = preloaded ? preloaded.entries.length : loadSpeechTables(unique).entries.length;
  return tablesFingerprint(LAYER_VERSION, unique, entries);
}

/**
 * 由「角色字典 + 章级条目」还原运行期用的表条目形态。
 * 必须与现算路径的 entry 字段一致（habit/type/versions/noSpecialHandling/memo），
 * 否则拼出的提示词块会有差异。
 */
function characterDescriptor(item, records = []) {
  const record = (Array.isArray(records) ? records[item.ref] : null) || {};
  const versions = record.versions || { x: item.expected || "", net: "", tw: "" };
  return {
    character: item.character,
    habit: record.habit || item.habit || "",
    type: record.type || item.type || "",
    memo: record.memo || item.memo || "",
    hasLiteralHabit: Boolean(record.habit || item.habit),
    versions,
    noSpecialHandling: Boolean(record.noSpecialHandling),
    // 只有实际登记的项目写法参与补回；`-` 是明确的不特殊处理，不做字面流失检测。
    expectedWritings: versions.x ? [versions.x] : [],
  };
}

/**
 * 角色条目字典：同一角色可能有多条习惯（例如名词后缀「力」与句尾「ダゾ」），
 * 因此按「条目签名」索引而不是按角色名，章级只存下标引用。
 */
function characterDictionary(summaries) {
  const records = [];
  const refs = new Map();
  const indexOf = (item) => {
    const record = {
      character: item.character,
      type: item.type || "",
      habit: item.habit || "",
      versions: item.versions || { x: item.expected || "", net: "", tw: "" },
      noSpecialHandling: Boolean(item.noSpecialHandling),
      memo: item.memo || "",
    };
    const signature = JSON.stringify(record);
    if (!refs.has(signature)) {
      refs.set(signature, records.length);
      records.push(record);
    }
    return refs.get(signature);
  };
  for (const summary of summaries) {
    for (const item of summary.characters) indexOf(item);
  }
  return { records, refs, indexOf };
}

function compactChapter(summary, dictionary) {
  return {
    chapter: summary.chapter,
    rowCount: summary.rowCount,
    indexRange: summary.indexRange,
    // 章级只存引用下标 + 判定凭据；口癖/写法/备注放在条目字典里，避免逐章重复。
    characters: summary.characters.map((item) => ({
      ref: dictionary.indexOf(item),
      character: item.character,
      activated: item.activated,
      detectedBy: item.detectedBy,
      strongRows: item.strongRows,
      weakRows: item.weakRows,
    })),
    // 明细只留行号与命中项；原文/译文片段不进快照（体积与隐私都不需要）。
    misses: summary.misses.map((miss) => ({ index: miss.index, items: miss.items })),
  };
}

/**
 * 构建期：为每个声明了说话习惯表的档案算出章级判定块。
 * @returns {{ version: number, generatedAt: string, byProfile: Record<string, object>, errors: string[] }}
 */
function buildSpeechHabitLayer({ rows = [], projectFiles = {}, profiles = null, envTables = [] } = {}) {
  const byProfile = {};
  const errors = [];
  const candidates = tableSourceCandidates({
    profiles: profiles || listProfiles().map((item) => resolveProfile(item.id)),
    envTables,
    tableKey: "speechTables",
    normalize: normalizeSpeechTablePaths,
    envName: "环境变量指定的说话习惯表",
    decorate: (profile) => ({ scope: profile?.speechHabitScope === "volume" ? "volume" : "chapter" }),
  });

  const volume = volumeKeyFromFiles(projectFiles);
  for (const entry of candidates) {
    const tables = loadSpeechTables(entry.files);
    if (tables.errors.length) errors.push(...tables.errors);
    if (!tables.entries.length) continue;

    const summaries = groupRowsByChapter(rows).map((group) => summarizeGroup({
      name: group.chapter,
      rows: group.rows,
      tables,
      volume,
    }));
    // 角色条目字典：口癖/写法/备注只存一份，章级条目只引用下标。
    const dictionary = characterDictionary(summaries);
    const chapters = summaries.map((summary) => compactChapter(summary, dictionary));
    // 卷口径：额外存一份整卷判定，供运行期直接拼卷级块。
    const volumeCharacters = entry.scope === "volume"
      ? detectCharacters({ rows, tables, volume }).map((item) => ({
        ref: dictionary.indexOf({
          character: item.entry.character,
          type: item.entry.type,
          habit: item.entry.habit,
          versions: { ...item.entry.versions },
          noSpecialHandling: Boolean(item.entry.noSpecialHandling),
          memo: item.entry.memo || "",
        }),
        character: item.entry.character,
        activated: item.activated,
        detectedBy: item.detectedBy,
        strongRows: item.strongRows,
        weakRows: item.weakRows,
      }))
      : [];

    const missIndexes = chapters.flatMap((chapter) => chapter.misses.map((miss) => miss.index));
    const activatedCharacters = new Set();
    let activatedChapters = 0;
    for (const chapter of chapters) {
      const activated = chapter.characters.filter((item) => item.activated);
      if (activated.length) activatedChapters += 1;
      for (const item of activated) activatedCharacters.add(item.character);
    }

    byProfile[entry.id] = {
      id: entry.id,
      name: entry.name,
      scope: entry.scope,
      // 只留文件名：这是要进快照与页面的，本机完整路径不该出现在产物里。
      files: tableFileNames(entry.files),
      fingerprint: speechTablesFingerprint(entry.files, tables),
      entries: tables.entries.length,
      volume: volume?.code || "",
      characterRecords: dictionary.records,
      chapters,
      volumeCharacters,
      missIndexes,
      summary: {
        chapters: chapters.length,
        activatedChapters,
        activatedCharacters: [...activatedCharacters],
        missRows: missIndexes.length,
      },
    };
  }

  return { version: LAYER_VERSION, generatedAt: new Date().toISOString(), byProfile, errors };
}

/**
 * 运行期：本次实际用到的说话习惯表路径（口径与构建期一致：档案声明 → 环境变量）。
 * 落盘块里只有文件名，指纹要 stat 真实文件，所以路径必须在运行期重新解析。
 */
function currentSpeechFiles(profileId, envTables) {
  return tableFilesForProfile(resolveProfile(profileId), {
    tableKey: "speechTables",
    envTables: envTables === undefined ? process.env.TRANSCOMPARATOR_SPEECH_TABLES : envTables,
    normalize: normalizeSpeechTablePaths,
  });
}

/**
 * 运行期：按 profileId 取落盘块。没有该档案或指纹过期（表被改过）时返回可判定的结果，
 * 由调用方决定是现算还是继续用旧的。
 *
 * @param {string[]} [files] 本次**实际加载**的表路径（含显式指定的表）。不传时按当前档案解析；
 *   两种情况都解析不出表时视为不可信（stale），绝不静默复用旧结论。
 */
function speechHabitLayerFor(layer, profileId, { files = null } = {}) {
  if (!layer || !layer.byProfile) return null;
  const entry = layer.byProfile[profileId] || null;
  if (!entry) return null;
  const currentFiles = files ? normalizeSpeechTablePaths(files) : currentSpeechFiles(profileId);
  // 条目数取落盘的那份：与构建期同口径，也免得每次都重新解析整张表。
  const current = currentFiles.length
    ? tablesFingerprint(LAYER_VERSION, currentFiles, entry.entries || 0)
    : "";
  return { stale: !current || current !== entry.fingerprint, entry, currentFingerprint: current };
}

/**
 * 把落盘块还原成运行期上下文：章 → { block, characters, characters_raw }。
 * - `block` 是**章级**块（按章命中全部角色），页面/审计与现算路径的章级判定一致；
 * - 行级注入不直接用 `block`：运行期统一走 `speechHabitBlockForRow`，把角色收窄到本行
 *   （本行提到该角色、或原文出现了他的口癖），与现算路径共用同一函数，因此逐字一致。
 * - `volume` 带上卷号，供运行期为卷口径重建整卷块（`volumeHabitBlock` 需要 `{ code }`）。
 */
function contextFromLayerEntry(entry) {
  const blocks = new Map();
  const records = entry.characterRecords || [];
  const descriptorOf = (item) => ({ entry: characterDescriptor(item, records), activated: item.activated !== false });
  const volume = entry.volume ? { code: entry.volume } : null;

  if (entry.scope === "volume" && (entry.volumeCharacters || []).length) {
    const activated = entry.volumeCharacters.filter((item) => item.activated);
    const block = volumeHabitBlock({ volume, characters: activated.map(descriptorOf) });
    const names = activatedCharacterNames(activated);
    for (const chapter of entry.chapters || []) {
      blocks.set(chapter.chapter, { block, volume, characters: names, characters_raw: activated.map(descriptorOf) });
    }
  } else {
    for (const chapter of entry.chapters || []) {
      const activated = chapter.characters.filter((item) => item.activated);
      blocks.set(chapter.chapter, {
        block: chapterHabitBlock({ chapter: chapter.chapter, characters: activated.map(descriptorOf) }),
        volume,
        characters: activatedCharacterNames(activated),
        characters_raw: chapter.characters.map(descriptorOf),
      });
    }
  }

  const activatedCharacters = new Set();
  for (const chapter of entry.chapters || []) {
    for (const item of chapter.characters) if (item.activated) activatedCharacters.add(item.character);
  }
  if (entry.scope === "volume") {
    for (const item of entry.volumeCharacters || []) if (item.activated) activatedCharacters.add(item.character);
  }

  return {
    source: "snapshot",
    scope: entry.scope,
    volume: entry.volume ? { code: entry.volume } : null,
    tables: { files: entry.files || [], entries: entry.entries || 0, errors: [] },
    blocks,
    activatedChapters: (entry.chapters || []).filter((chapter) => chapter.characters.some((item) => item.activated)).length,
    activatedCharacters: [...activatedCharacters],
  };
}

module.exports = {
  LAYER_VERSION,
  buildSpeechHabitLayer,
  characterDescriptor,
  contextFromLayerEntry,
  speechHabitLayerFor,
  speechTablesFingerprint,
};
