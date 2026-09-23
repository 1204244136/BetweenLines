#!/usr/bin/env node
/**
 * 对照表预处理（离线脚本）：对当前项目的行先查译名对照表，输出命中的行与建议，
 * 不调用任何模型。用途是在真正跑 AI 之前先确认表格命中率与冲突是否可信。
 *
 * 用法：
 *   node scripts/term-prefilter.js                        # 用默认特化档案声明的表
 *   node scripts/term-prefilter.js --table D:\t.xlsx      # 指定表（可重复）
 *   node scripts/term-prefilter.js --profile demo         # 指定特化档案（用档案 id；本机叠加档案沿用基底 id）
 *   node scripts/term-prefilter.js --target tw            # 三语下指定目标列（默认 cn，与运行期一致）
 *   node scripts/term-prefilter.js --from-snapshot        # 只读构建期落盘结论（与页面徽标同源，不重算）
 *   node scripts/term-prefilter.js --json --out report.json
 *   node scripts/term-prefilter.js --limit 20             # 只看前 N 行
 *
 * 退出码：0 正常；1 参数或数据有问题（无活动项目 / 表不可用）。
 */
const fs = require("fs");
const path = require("path");

const { getActiveProject, resolveProjectArtifact } = require("./project-store");
const { loadActiveCompareData } = require("./lib/offline-cli");
const { loadTermTables, evaluateTermRow, describeTermHit, displayTermPair, termTableSummary, normalizeTermTablePaths } = require("../src/workbenches/translation-compare/ai/term-table");
const { termTargetKeyFor, conflictAnalysisHead } = require("../src/workbenches/translation-compare/ai/term-prefilter");
const { resolveProfile } = require("../src/workbenches/translation-compare/ai/proofread-contract");
const { describeTermLayerEntry, termLayerFor, variantIndexSets } = require("../src/workbenches/translation-compare/term-layer");

function parseArgs(argv) {
  const options = { tables: [], profileId: "", json: false, out: "", limit: 0, showAll: false, target: "cn", fromSnapshot: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--table" || arg === "-t") options.tables.push(argv[++i] || "");
    else if (arg === "--profile" || arg === "-p") options.profileId = argv[++i] || "";
    else if (arg === "--target") options.target = argv[++i] === "tw" ? "tw" : "cn";
    else if (arg === "--from-snapshot") options.fromSnapshot = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--out" || arg === "-o") options.out = argv[++i] || "";
    else if (arg === "--limit" || arg === "-n") options.limit = Number(argv[++i]) || 0;
    else if (arg === "--all") options.showAll = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

function usage() {
  return [
    "对照表预处理（离线，不调用模型）",
    "",
    "  node scripts/term-prefilter.js [--table <文件>]... [--profile <id>] [--target cn|tw] [--from-snapshot] [--limit N] [--all] [--json] [--out <文件>]",
    "",
    "  --table          对照表文件（xlsx/csv/tsv/json），可重复；缺省取特化档案声明的表",
    "  --profile        特化档案 id（决定默认对照表与提示词口径）",
    "  --target         目标列：三语下 cn（非原文 B）或 tw（非原文 C）；双语恒为 cn",
    "  --from-snapshot  只输出构建期落盘的判定（与页面徽标同一份数据），不重新查表",
    "  --limit          只输出前 N 条命中明细",
    "  --all            输出全部命中明细（默认只列冲突行）",
    "  --json           以 JSON 输出",
    "  --out            同时把结果写入指定文件",
  ].join("\n");
}

function loadRows() {
  const { project, file, rows, data } = loadActiveCompareData();
  return {
    project,
    file,
    rows,
    // 构建期算好的对照表判定（老快照可能没有）。
    termPrefilter: data.termPrefilter || null,
  };
}

/** 只读构建期结论：给页面徽标同源的清单，不重新查表。 */
function reportFromSnapshot({ layer, profileId, proofreadMode, targetKey, files }) {
  // 指纹按本次实际加载的表重算（落盘块里只有文件名，本机路径不回读产物）。
  const match = termLayerFor(layer, profileId, { proofreadMode, targetKey, files });
  if (!match) {
    console.error("当前快照没有这个档案的对照表判定：请重新构建工作台（npm run build），或去掉 --from-snapshot 现算。");
    return 1;
  }
  if (match.stale) console.warn("对照表在构建之后被修改过：页面徽标已过期，请重新构建工作台。");
  if (!match.variant) {
    console.error(`构建期没有算过「${match.variantKey}」这个变体：请重新构建工作台。`);
    return 1;
  }
  const { consistent, conflicts, termOnly } = variantIndexSets(match.variant);
  console.log(describeTermLayerEntry(match.entry, match.variantKey));
  console.log(`构建期结论：命中 ${match.variant.hits} 行（译名一致 ${consistent.size}：整行只有术语 ${termOnly.size} / 需注入术语 ${consistent.size - termOnly.size}，需人工确认 ${conflicts.size}），预计 ${match.variant.summary.aiRows} 行仍需 AI 判定。`);
  if (termOnly.size) console.log(`整行只有术语、跳过模型的行号：${[...termOnly].join(", ")}`);
  if (conflicts.size) console.log(`需人工确认的行号：${[...conflicts].join(", ")}`);
  return 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const profile = resolveProfile(options.profileId || undefined);
  const { project, file, rows, termPrefilter } = loadRows();
  const bilingual = project.comparisonMode === "bilingual";
  const proofreadMode = bilingual ? "bilingual" : "trilingual";
  const targetKey = termTargetKeyFor(proofreadMode, options.target);
  // 本次实际要用的表：--table 优先，其次档案声明，最后环境变量。与构建期同一口径。
  const tables = normalizeTermTablePaths([
    ...options.tables,
    ...(profile.termTables || []),
    ...String(process.env.TRANSCOMPARATOR_TERM_TABLES || "").split(/[;\n]/),
  ]);

  if (options.fromSnapshot) {
    return reportFromSnapshot({
      layer: termPrefilter,
      profileId: profile.id,
      proofreadMode,
      targetKey,
      files: tables,
    });
  }

  if (!tables.length) {
    console.error(`没有可用的对照表：特化档案「${profile.name}」没有声明 termTables，也没有 --table / TRANSCOMPARATOR_TERM_TABLES。`);
    return 1;
  }

  const loaded = loadTermTables(tables);
  for (const error of loaded.errors) console.warn(`对照表加载告警：${error}`);
  if (!loaded.entries.length) {
    console.error("对照表没有可用条目，请检查表头是否包含原文列与译名列。");
    return 1;
  }

  const report = { project: project.projectKey || "", snapshot: file, profile: profile.id, tables: loaded.files, entries: loaded.entries.length, hits: [], consistent: 0, termOnly: 0, injected: 0, advisory: 0, conflicts: 0, rubySkipped: 0, rubyDemoted: 0, total: rows.length };

  // 被注音口径排除的候选（非人名条目带注音时：中日两侧都注音才按完整口径判定，
  // 否则降级为只作一致性证据；这里是“降级且译文也没用该译名”的那部分）。
  const rubySkippedCandidates = [];
  // 降级命中：没有双侧注音，但译文确实用了该译名（算命中，只是不能指控译名差异）。
  const rubyDemotedCandidates = [];
  for (const row of rows) {
    const evaluation = evaluateTermRow({
      source: row.jp || "",
      target: String(row[targetKey] ?? row.cn ?? ""),
      tables: loaded,
      rejected: rubySkippedCandidates,
      demoted: rubyDemotedCandidates,
    });
    if (!evaluation) continue;
    const record = {
      index: row.index,
      kind: evaluation.kind,
      // 整行有效内容都是术语时，覆盖率说明了“术语之外还剩什么”，便于人工核对跳过是否合理。
      coverage: evaluation.coverage || null,
      // 术语冲突行由模型出结论（术语判断是模型分析的一环）：这里只给“差异明细 + 其余计数”，
      // 供人工核对模型结论是否有依据，不做成面向人工的判定。
      conflictHead: evaluation.kind === "conflict" ? conflictAnalysisHead(evaluation.hits) : "",
      // 若只做术语替换、句子其余部分不动会是这个样子：仅作审计参考，不是结论。
      revisedText: evaluation.revisedText || "",
      terms: evaluation.hits.map((hit) => ({
        source: hit.entry.source,
        target: hit.entry.target,
        type: hit.entry.type,
        scope: hit.scope,
        consistent: hit.consistent,
        description: describeTermHit(hit),
      })),
      source: String(row.jp || "").slice(0, 120),
      target: String(row[targetKey] ?? row.cn ?? "").slice(0, 120),
    };
    report.hits.push(record);
    if (evaluation.kind === "term-only") {
      report.termOnly += 1;
      report.consistent += 1;
    } else if (evaluation.kind === "consistent") {
      report.injected += 1;
      report.consistent += 1;
    } else if (evaluation.kind === "advisory") {
      // 存疑（假名写法，可能只是普通词）：不由对照表定论，照常交给模型判断，不能算进“需人工确认”。
      report.advisory += 1;
      report.injected += 1;
      report.consistent += 1;
    } else {
      // 术语冲突：不由对照表出结论，注入提示词后交给模型（术语判断是模型分析的一环）。
      // 它不算「译名一致」，所以只计入 injected，不计入 consistent。
      report.conflicts += 1;
      report.injected += 1;
    }
  }

  report.rubySkipped = rubySkippedCandidates.length;
  report.rubyDemoted = rubyDemotedCandidates.length;
  if (options.json) {
    const text = JSON.stringify(report, null, 2);
    console.log(text);
    if (options.out) fs.writeFileSync(path.resolve(options.out), `${text}\n`, "utf8");
    return 0;
  }

  const conflictHits = report.hits.filter((hit) => hit.kind === "conflict");
  const listed = options.showAll ? report.hits : conflictHits;
  const limited = options.limit > 0 ? listed.slice(0, options.limit) : listed;
  console.log(termTableSummary(loaded));
  console.log(`特化档案：${profile.name}（${profile.id}）；目标列：${targetKey === "tw" ? "非原文 C" : "非原文 B"}`);
  console.log(`扫描 ${report.total} 行，命中 ${report.hits.length} 行：整行只有术语、跳过模型 ${report.termOnly} 行；其余 ${report.injected} 行把术语作为提示词注入后交给模型（其中术语冲突 ${report.conflicts} 行、假名存疑 ${report.advisory} 行）。`);
  if (report.rubyDemoted) {
    const samples = [...new Set(rubyDemotedCandidates.map((item) => displayTermPair(item.entry)))].slice(0, 5);
    console.log(`另有 ${report.rubyDemoted} 条候选因中日两侧没有同时注音，降级为只作一致性证据（例：${samples.join("、")}）。`);
  }
  if (report.rubySkipped) {
    const samples = [...new Set(rubySkippedCandidates.map((item) => displayTermPair(item.entry)))].slice(0, 5);
    console.log(`另有 ${report.rubySkipped} 条候选因没有同时注音、且译文未出现该译名而未参与判定（例：${samples.join("、")}）。`);
  }
  console.log("跳过模型的条件：只有整行有效内容本身就是术语；其余命中行（含术语冲突）都把术语作为提示词注入，整行交给模型判断。");
  const layerNote = compareWithLayer({
    layer: termPrefilter,
    profileId: profile.id,
    proofreadMode,
    targetKey,
    files: loaded.files,
    report,
  });
  if (layerNote) console.log(layerNote);
  if (limited.length) {
    console.log("");
    console.log(options.showAll ? "全部命中明细：" : "术语冲突的行（结论由 AI 给出）：");
    for (const hit of limited) {
      const label = hit.kind === "conflict" ? "术语冲突·交模型判断" : (hit.kind === "term-only" ? "整行只有术语·跳过模型" : "术语注入·照常交模型");
      console.log(`  #${hit.index} ${label}`);
      console.log(`    原文：${hit.source}`);
      console.log(`    译文：${hit.target}`);
      if (hit.conflictHead) console.log(`    差异：${hit.conflictHead}`);
      else for (const term of hit.terms) console.log(`    ${term.description}`);
    }
    if (listed.length > limited.length) console.log(`  …（其余 ${listed.length - limited.length} 条已省略，用 --limit 调整）`);
  }
  if (options.out) {
    fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\n已写入 ${path.resolve(options.out)}`);
  }
  return 0;
}

/** 现算结果与构建期落盘结论对照：两者必须给出同一批命中行。 */
function compareWithLayer({ layer, profileId, proofreadMode, targetKey, files = null, report }) {
  const match = termLayerFor(layer, profileId, { proofreadMode, targetKey, files });
  if (!match) return "";
  if (match.stale) return "对照表在构建之后被修改过：页面徽标已过期，请重新构建工作台。";
  if (!match.variant) return "";
  const { consistent, conflicts } = variantIndexSets(match.variant);
  const predicted = new Set([...consistent, ...conflicts]);
  const actual = new Set(report.hits.map((hit) => Number(hit.index)));
  const missing = [...predicted].filter((index) => !actual.has(index));
  const extra = [...actual].filter((index) => !predicted.has(index));
  if (missing.length || extra.length) {
    return `与构建期预筛不一致（少 ${missing.length} 行 / 多 ${extra.length} 行）：重新构建工作台后再核对页面徽标。`;
  }
  return `与构建期预筛一致（${predicted.size} 行；页面用同一份结论标注徽标）。`;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
