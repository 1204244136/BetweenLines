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
 */
const fs = require("fs");
const path = require("path");
const novel = require("./novel");
const demo = require("./demo");

const builtInProfiles = [novel, demo];
const localProfileDir = path.join(__dirname, "local");
const DEFAULT_PROFILE_ID = "novel";

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
    .map((section) => ({
      title: String(section?.title || "").trim(),
      lines: (section?.lines || []).map((line) => String(line || "").trim()).filter(Boolean),
    }))
    .filter((section) => section.lines.length);
  if (!sections.length) throw new Error(`特化侧档案 ${id} 没有可用规则。`);
  const name = String(profile.name || id).trim();
  return Object.freeze({
    ...profile,
    id,
    name,
    summary: String(profile.summary || "").trim(),
    // 特化侧除了提示词，还可以声明辅助判断数据：译名对照表与说话习惯表（只放本机路径）。
    termTables: (Array.isArray(profile.termTables) ? profile.termTables : [profile.termTables])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
    speechTables: (Array.isArray(profile.speechTables) ? profile.speechTables : [profile.speechTables])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
    // 说话习惯的作用范围：chapter（默认，按章命中人名）或 volume（整卷）。
    speechHabitScope: profile.speechHabitScope === "volume" ? "volume" : "chapter",
    sections: Object.freeze(sections.map((section) => Object.freeze(section))),
    // 合并注入时的去重标记：自定义提示词里已经有这段标题就不再追加。
    marker: `【成品校对规范：${name}】`,
  });
}

function loadProfiles() {
  const profiles = new Map();
  for (const profile of builtInProfiles) {
    const normalized = normalizeProfile(profile);
    profiles.set(normalized.id, normalized);
  }
  for (const file of externalProfileFiles()) {
    try {
      const normalized = normalizeProfile(require(file));
      if (profiles.has(normalized.id)) {
        console.warn(`[ai] 特化档案 ${file} 的 id「${normalized.id}」覆盖了同名档案。`);
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
