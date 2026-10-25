/**
 * 特化侧档案注册表。
 *
 * 通用侧（任务契约）在 `../proofread-contract.js`；特化侧（作品/工作阶段规范）
 * 在这里注册，两者在组装系统提示词时合并注入。
 *
 * 档案来源分两类：
 * - 仓库内档案：`./novel.js`（与具体作品无关的成品校对规范）与 `./demo.js`
 *   （作品专有档案的公开示范，同时是本项目实际使用的一份）。
 * - 本机额外档案：被忽略的 `./local/*.js` 目录，或环境变量
 *   `TRANSCOMPARATOR_PROFILE_FILES` 指向的仓库外文件（不想公开的作品档案走这条路径）。
 *
 * 新增档案：放一个导出 `{ id, name, summary, sections }` 的文件并在 `builtInProfiles`
 * 登记，界面下拉与默认值会自动带上它。档案可以继承（见 `./demo.js`），但必须保持该结构。
 *
 * 叠加（`extends`）：本机档案通常不是"另立一份"，而是给既有档案补本机专有的东西
 * （表路径、名字、少量补充规则）。这类文件只写 `{ extends: "<既有 id>", ...差异字段 }`，
 * 注册表把它合并进基底档案后**沿用基底的 id**——于是下拉里仍然只有一项，也不会出现
 * 两份逐字相同的规范让人分不清该选哪个。只声明差异字段还顺带解决了"基底改了、
 * 本机副本忘了同步"的问题：提示词永远跟着基底走。
 */
const fs = require("fs");
const path = require("path");
const novel = require("./novel");
const demo = require("./demo");
const { FEATURE_IDS } = require("../row-features");

const builtInProfiles = [novel, demo];
const localProfileDir = path.join(__dirname, "local");
const DEFAULT_PROFILE_ID = "novel";
const warnedFeatureIds = new Set();

/**
 * 规则条目归一化。条目支持三种形态（写法与选择标准见 `./novel.js` 的文件头说明）：
 * - 字符串：常驻条目，每一行都注入；
 * - `{ text, features: [...] }`：按行条目，只在当前行命中这些**版式/文字现象**时才注入；
 * - `{ text, characters: [...] }`：实体条目，只在当前行真的出现该角色/专有词时才注入
 *   （判定见 `../name-entities.js`，实体名单只能由档案声明）。
 *
 * 这里**不能**把对象压成字符串（旧版 `String(line)` 会让对象条目变成 "[object Object]"，
 * 按行裁剪随之静默失效）。`features` 声明了未注册的 id 时按常驻处理并告警一次：
 * 宁可多注入几十 token，也不能因为一个笔误让某条规范永远不出现。
 */
function normalizeLine(line) {
  if (line == null) return null;
  if (typeof line === "string") return line.trim() || null;
  const text = String(line.text || "").trim();
  if (!text) return null;
  const features = (Array.isArray(line.features) ? line.features : [line.features])
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  for (const id of features) {
    if (!FEATURE_IDS.includes(id) && !warnedFeatureIds.has(id)) {
      warnedFeatureIds.add(id);
      console.warn(`[ai] 特化档案声明了未注册的行特征「${id}」，该条目按常驻处理（注册表见 ai/row-features.js）。`);
    }
  }
  // 实体声明只做去空与保序；名字与别名的解析统一交给 name-entities（页面审计与运行期判定共用一份）。
  const characters = (Array.isArray(line.characters) ? line.characters : [line.characters])
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  if (!features.length && !characters.length) return text;
  return Object.freeze({
    text,
    ...(features.length ? { features: Object.freeze(features) } : {}),
    ...(characters.length ? { characters: Object.freeze(characters) } : {}),
  });
}

function externalProfileFiles() {
  const fromEnv = String(process.env.TRANSCOMPARATOR_PROFILE_FILES || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!fs.existsSync(localProfileDir)) return fromEnv;
  const fromLocalDir = fs.readdirSync(localProfileDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => path.join(localProfileDir, name));
  return [...fromEnv, ...fromLocalDir];
}

function normalizeProfile(profile) {
  const id = String(profile?.id || "").trim();
  if (!id) throw new Error("特化侧档案缺少 id。");
  const sections = (profile.sections || [])
    .map((section) => {
      const lines = (section?.lines || []).map(normalizeLine).filter(Boolean);
      return { title: String(section?.title || "").trim(), lines };
    })
    .filter((section) => section.lines.length);
  if (!sections.length) throw new Error(`特化侧档案 ${id} 没有可用规则。`);
  const name = String(profile.name || id).trim();
  return Object.freeze({
    ...profile,
    id,
    name,
    summary: String(profile.summary || "").trim(),
    // 特化侧除了提示词，还可以声明辅助判断数据：译名表与说话习惯表（只放本机路径）。
    termTables: (Array.isArray(profile.termTables) ? profile.termTables : [profile.termTables])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
    speechTables: (Array.isArray(profile.speechTables) ? profile.speechTables : [profile.speechTables])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
    // 说话习惯的作用范围：chapter（默认，按章命中人名）或 volume（整卷）。
    speechHabitScope: profile.speechHabitScope === "volume" ? "volume" : "chapter",
    // 线上查证用的官方站点入口（有序：声明顺序就是查询顺序）。作品专有信息，所以由档案声明；
    // 未声明时线上查询层整体不启用。这里只做形态归一化（字符串/对象都接受、去重、保持顺序）。
    wikiSites: (Array.isArray(profile.wikiSites) ? profile.wikiSites : [profile.wikiSites])
      .map((item) => (typeof item === "string" ? { url: item } : (item || {})))
      .map((item) => ({ label: String(item.label || "").trim(), url: String(item.url || "").trim() }))
      .filter((item) => item.url),
    sections: Object.freeze(sections.map((section) => Object.freeze(section))),
    // 合并注入时的去重标记：自定义提示词里已经有这段标题就不再追加。
    marker: `【成品校对规范：${name}】`,
  });
}

/**
 * 叠加合并：基底档案 + 叠加档案里**显式声明**的差异字段。
 *
 * 只认差异是这套语义的关键——叠加档案不该复制基底的规范正文，否则基底一改，
 * 本机副本就悄悄过期，两份内容也再次分叉成"该选哪个"的问题。
 * - `name`/`summary`/`speechHabitScope`/`wikiSites`：声明即覆盖，未声明沿用基底。
 * - `sections`：声明即在基底之后追加；同名小节视为修正，替换基底的那一节。
 * - `termTables`/`speechTables`：按"再补一层"理解，与基底合并去重（基底的表继续生效）。
 */
function applyOverlay(base, patch) {
  const listOf = (value) => (Array.isArray(value) ? value : [value]).map((item) => String(item || "").trim()).filter(Boolean);
  const patchSections = Array.isArray(patch.sections) ? patch.sections : [];
  const sections = patchSections.reduce((acc, section) => {
    const title = String(section?.title || "").trim();
    const index = title ? acc.findIndex((item) => String(item?.title || "").trim() === title) : -1;
    if (index >= 0) acc[index] = section;
    else acc.push(section);
    return acc;
  }, [...(Array.isArray(base.sections) ? base.sections : [])]);
  const patchFields = { ...patch };
  // `extends` 只用于定位基底，不进档案本身。
  delete patchFields.extends;
  return {
    ...base,
    ...patchFields,
    // id 与 marker 都跟着基底走：叠加档案不是一个新档案，只是这一份档案的本机版本。
    id: base.id,
    name: patch.name || base.name,
    summary: patch.summary || base.summary,
    sections,
    termTables: [...new Set([...listOf(base.termTables), ...listOf(patch.termTables)])],
    speechTables: [...new Set([...listOf(base.speechTables), ...listOf(patch.speechTables)])],
    speechHabitScope: patch.speechHabitScope || base.speechHabitScope,
  };
}

function loadProfiles() {
  const profiles = new Map();
  for (const profile of builtInProfiles) {
    const normalized = normalizeProfile(profile);
    profiles.set(normalized.id, normalized);
  }
  for (const file of externalProfileFiles()) {
    try {
      const raw = require(file);
      const baseId = String(raw?.extends || "").trim();
      const base = baseId ? profiles.get(baseId) : null;
      // 叠加目标只能是已注册的档案（内置档案，或先加载的仓库外档案）。
      if (baseId && !base) {
        console.warn(`[ai] 特化档案 ${file} 声明叠加到「${baseId}」，但没有这个档案，已跳过。`);
        continue;
      }
      const ownId = String(raw?.id || "").trim();
      if (base && ownId && ownId !== base.id) {
        console.warn(`[ai] 特化档案 ${file} 同时写了 extends 与 id「${ownId}」；叠加档案沿用基底 id「${base.id}」，该 id 已被忽略。`);
      }
      const normalized = normalizeProfile(base ? applyOverlay(base, raw) : raw);
      if (!base && profiles.has(normalized.id)) {
        console.warn(`[ai] 特化档案 ${file} 的 id「${normalized.id}」覆盖了同名档案；只想在既有档案上补本机内容，请改用 extends。`);
      }
      profiles.set(normalized.id, normalized);
    } catch (error) {
      console.warn(`[ai] 特化档案加载失败，已跳过 ${file}：${error.message}`);
    }
  }
  return profiles;
}

const profiles = loadProfiles();

function listProfiles() {
  return [...profiles.values()].map((profile) => ({
    id: profile.id,
    name: profile.name,
    summary: profile.summary,
  }));
}

function resolveProfile(profileId) {
  const id = String(profileId || "").trim();
  if (id && profiles.has(id)) return profiles.get(id);
  return profiles.get(DEFAULT_PROFILE_ID);
}

module.exports = {
  DEFAULT_PROFILE_ID,
  listProfiles,
  resolveProfile,
};
