/**
 * 构建期「表层」的公共部分：从特化档案声明 + 环境变量解析出要算哪些表。
 *
 * 说话习惯层与对照表层的取表口径必须一致，否则同一张表在两层里会被判成不同的来源：
 * - 顺序固定为「档案声明 → 环境变量」，同一路径只算一次（大小写与相对写法归一后再去重）；
 * - 环境变量单独给出的表算作伪档案 `env`，这样只设环境变量、不建档案也能用；
 * - 档案没有声明该类型的表时直接跳过，不产生空条目。
 *
 * 各层只需给出表字段名、归一化函数与要附加的信息（例如说话习惯层的 scope）。
 */
function tableSourceCandidates({
  profiles = null,
  envTables = [],
  tableKey,
  normalize,
  envName,
  decorate = () => ({}),
} = {}) {
  const candidates = [];
  for (const profile of profiles) {
    const files = normalize([...(profile[tableKey] || []), ...envTables]);
    if (!files.length) continue;
    candidates.push({ id: profile.id, name: profile.name, files, ...decorate(profile) });
  }
  const envFiles = normalize(envTables);
  if (envFiles.length && !candidates.some((item) => item.id === "env")) {
    candidates.push({ id: "env", name: envName, files: envFiles, ...decorate(null) });
  }
  return candidates;
}

module.exports = { tableSourceCandidates };
