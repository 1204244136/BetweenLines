/**
 * 实体闸门：让「作品专有事实」里**只对某个角色/条目成立**的规则按行注入。
 *
 * 为什么需要它：`row-features.js` 的特征只描述**版式与文字现象**（注音、引号、省略号、数字……），
 * 而特化档案里还有一类规则，它们既不是每行都要核对的通用契约，也不由版式现象触发，而是
 * 「只在这一行真的出现那个角色/那个专有词时才成立」——例如「安娜·金斯福德把部分假名改写为片假名」
 * 「御坂妹妹的编号在正文写阿拉伯数字」。这类规则过去只能写成常驻条目，于是整卷 3119 行的每一次请求
 * 都背着它（实测：本卷里「安娜·金斯福德」一行都没出现、「御坂妹妹」也只出现在带数字的少数行），
 * 既花 token 又把注意力从「这一行到底哪里有问题」上稀释掉。
 *
 * 分工（与 row-features 的三条纪律一一对应）：
 * - **宁可多注入**：两侧文本都缺失（行数据缺失/统计口径外的调用）时，档案声明的实体**全部按命中**处理；
 *   只有拿到了两侧文本才做真正的匹配。
 * - **只描述现象**：实体 id 说的是「这一行里出现了这个名字」，不是「这一行有缺陷」。
 * - **不猜语义**：实体的名字**只能由档案声明**（`characters`），本模块不认识任何作品专有名词，
 *   也不从译名表/说话习惯表里自动挑实体——声明了才可能注入，没声明就永远不注入。
 *
 * 名字与别名的口径（与说话习惯层同源，见 `speech-habit.js` 的 `characterAliases`）：
 * - 全名（含去掉分隔符的写法，如「安娜·金斯福德」→「安娜金斯福德」）是默认别名；
 * - 「御坂妹妹`|御坂`」这种写法是**显式别名**：`|` 后面的是放宽匹配用的片段。
 *   片段命中会把同姓的别的角色也带进来（单独一个「御坂」能带出御坂美琴、御坂美铃…），
 *   所以只放宽到需要放宽的那些条目，不要给每个角色都挂上姓氏。
 */

// 名字里的分隔符（中日文都可能有）：去掉分隔符的写法单独算一个别名。
const NAME_SEPARATORS = /[·・\s]/;

/**
 * 把档案声明的一条实体写成 `{ id, name, aliases }`。
 * id 是注入时用于比对的键（本行命中的实体集合里出现它，声明它的条目才注入）。
 * @param {string} raw 形如 `御坂妹妹` 或 `御坂妹妹|御坂`
 */
function normalizeEntity(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const [name, ...aliasParts] = value.split("|").map((item) => item.trim()).filter(Boolean);
  if (!name) return null;
  const aliases = new Set([name]);
  const withoutSeparator = name.replace(/[·・\s]/g, "");
  if (withoutSeparator && withoutSeparator !== name) aliases.add(withoutSeparator);
  for (const alias of aliasParts) aliases.add(alias);
  // 长别名优先：短片段先匹配会让「御坂妹妹」被片段「御坂」抢走，剩下的片段无从区分。
  return { id: name, name, aliases: [...aliases].sort((a, b) => b.length - a.length) };
}

// 档案声明名单的缓存：档案是冻住的对象，按对象身份缓存一次即可。
// 用处是热路径——每个实体的每个别名都会参与整行文本的子串判断（本卷 3119 行、每秒几十次调用），
// 每次重新解析一遍声明名单纯属浪费。
const profileEntityCache = new WeakMap();

/** 档案里所有声明了 `characters` 的条目涉及的实体（去重、保序、剔除笔误与非字符串）。 */
function profileEntities(profile) {
  if (!profile || typeof profile !== "object") return [];
  const cached = profileEntityCache.get(profile);
  if (cached) return cached;
  const seen = new Map();
  for (const section of profile?.sections || []) {
    for (const line of section.lines || []) {
      if (typeof line === "string") continue;
      for (const raw of line?.characters || []) {
        const entity = normalizeEntity(raw);
        if (entity && !seen.has(entity.id)) seen.set(entity.id, entity);
      }
    }
  }
  const list = [...seen.values()];
  profileEntityCache.set(profile, list);
  return list;
}

/**
 * 一行文本命中了哪些实体（纯字符串判断，不做语义推断）。
 * @param {string} text 原文与目标列拼在一起后的文本
 * @param {Array} entities `profileEntities()` 的结果
 * @returns {Set<string>} 命中的实体 id
 */
function matchEntityIds(text, entities = []) {
  const haystack = String(text || "");
  const hit = new Set();
  if (!haystack) return hit;
  for (const entity of entities) {
    if (entity.aliases.some((alias) => haystack.includes(alias))) hit.add(entity.id);
  }
  return hit;
}

/**
 * 本行实际命中的实体集合。
 *
 * 兜底口径与 `detectRowFeatures` 一致：两侧都没文本时**不做裁剪**——档案声明的实体全部按命中处理。
 * 「看不出这一行有没有这个角色」不等于「这一行没有这个角色」，漏注入等于让模型看不到这条规范却又
 * 可能按它判违规。拿到任意一侧文本时才做真正的匹配（id 认不出、声明名单为空的实体匹配不到任何条目，
 * 等于维持原状）。
 *
 * @param {{source?: string, target?: string, entities?: Array}} options
 */
function detectRowEntities({ source = "", target = "", entities = [] } = {}) {
  const list = (Array.isArray(entities) ? entities : [])
    .map((item) => (typeof item === "string" ? normalizeEntity(item) : item))
    .filter(Boolean);
  const src = String(source || "");
  const dst = String(target || "");
  if (!src && !dst) return new Set(list.map((entity) => entity.id));
  return matchEntityIds(`${src}\n${dst}`, list);
}

/**
 * 审计用明细：本次声明了哪些实体、命中了哪些、跳过了哪些。
 * 走 `promptTrimSummary()` 汇报一次，回答的是「规则为什么没注入」——
 * 少了它，实体闸门静默失效时（例如名字写错、别名写窄了）没人看得出来。
 */
function entityGateReport(profile, entities = null) {
  const declared = profileEntities(profile);
  if (!entities) return { declared: declared.map((entity) => entity.id), hit: [], skipped: [], gated: false };
  const hit = declared.filter((entity) => entities.has(entity.id)).map((entity) => entity.id);
  const skipped = declared.filter((entity) => !entities.has(entity.id)).map((entity) => entity.id);
  return { declared: declared.map((entity) => entity.id), hit, skipped, gated: true };
}

module.exports = {
  detectRowEntities,
  entityGateReport,
  matchEntityIds,
  normalizeEntity,
  profileEntities,
};
