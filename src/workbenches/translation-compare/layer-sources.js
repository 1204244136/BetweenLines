/**
 * 构建期「表层」的公共部分：优先使用生成前显式选择的项目表。
 * selectedTables 为 [] 时没有候选，不回落；null 仅保留旧快照/离线调用的档案兼容。
 *
 * 说话习惯层与对照表层的取表口径必须一致，否则同一张表在两层里会被判成不同的来源：
 * - 顺序固定为「档案声明 → 环境变量」，同一路径只算一次（大小写与相对写法归一后再去重）；
 * - 环境变量单独给出的表算作伪档案 `env`，这样只设环境变量、不建档案也能用；
 * - 档案没有声明该类型的表时直接跳过，不产生空条目。
 *
 * 各层只需给出表字段名、归一化函数与要附加的信息（例如说话习惯层的 scope）。
 *
 * 同一份口径在**运行期**也要用一次：落盘的层块只存表文件名（不进产物的是本机路径），
 * 运行期要重算指纹就得重新解析「当前档案现在用哪些表」——用的就是这个函数。
 */

/** 环境变量/命令行里的表路径写法：数组、`;` 与换行分隔都接受。 */
function toPathList(value) {
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((item) => String(item || "").split(/[;\n]/))
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 按档案 + 环境变量解析当前该用哪些表（构建期与运行期同口径）。
 * @param {object|null} profile 特化档案
 * @param {object} options `tableKey` 表字段名、`envTables` 环境变量给的路径、`normalize` 归一化函数
 */
function tableFilesForProfile(profile, { tableKey, envTables = [], normalize = (list) => list } = {}) {
  return normalize([...(profile?.[tableKey] || []), ...toPathList(envTables)]);
}

function tableSourceCandidates({
  profiles = null,
  envTables = [],
  selectedTables = null,
  tableKey,
  normalize,
  envName,
  decorate = () => ({}),
} = {}) {
  const candidates = [];
  for (const profile of profiles) {
    const files = selectedTables === null
      ? tableFilesForProfile(profile, { tableKey, envTables, normalize })
      : normalize(toPathList(selectedTables));
    if (!files.length) continue;
    candidates.push({ id: profile.id, name: profile.name, files, ...decorate(profile) });
  }
  const envFiles = selectedTables === null ? normalize(toPathList(envTables)) : [];
  if (envFiles.length && !candidates.some((item) => item.id === "env")) {
    candidates.push({ id: "env", name: envName, files: envFiles, ...decorate(null) });
  }
  return candidates;
}

module.exports = { tableFilesForProfile, tableSourceCandidates, toPathList };
