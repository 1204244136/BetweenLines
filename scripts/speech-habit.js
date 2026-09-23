#!/usr/bin/env node
/**
 * 说话习惯层（离线脚本）：按章或按卷判定人名命中，列出该章/该卷启用哪些角色的说话特色，
 * 并给出“原文有口癖、译文没体现”的疑似流失行。不调用任何模型。
 *
 * 为什么按章/按卷而不是逐行：一行台词往往看不出说话人，但一章里出现某角色的人名，
 * 其说话习惯就很可能出现在这一章的台词里——所以判定单位是章（或整卷）。
 *
 * 用法：
 *   node scripts/speech-habit.js                          # 用默认特化档案声明的表，按章汇总
 *   node scripts/speech-habit.js --profile demo --all      # 列出全部章与疑似流失行明细
 *   node scripts/speech-habit.js --by volume               # 按整卷汇总
 *   node scripts/speech-habit.js --table D:\habits.xlsx --json --out report.json
 *
 * 退出码：0 正常；1 参数或数据有问题（无活动项目 / 表不可用）。
 */
const fs = require("fs");
const path = require("path");

const { getActiveProject, resolveProjectArtifact } = require("./project-store");
const { loadActiveCompareData } = require("./lib/offline-cli");
const {
  loadSpeechTables,
  normalizeSpeechTablePaths,
  speechTableSummary,
  summarizeChapters,
  volumeKeyFromFiles,
} = require("../src/workbenches/translation-compare/ai/speech-habit");
const { resolveProfile } = require("../src/workbenches/translation-compare/ai/proofread-contract");
const { defaultIndexXDir, verifyAgainstSource } = require("../src/workbenches/translation-compare/verify-source");
const { speechHabitLayerFor } = require("../src/workbenches/translation-compare/speech-habit-layer");

function parseArgs(argv) {
  const options = { tables: [], profileId: "", scope: "chapter", json: false, out: "", limit: 0, showAll: false, verifySource: false, indexXDir: "", live: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--table" || arg === "-t") options.tables.push(argv[++i] || "");
    else if (arg === "--profile" || arg === "-p") options.profileId = argv[++i] || "";
    else if (arg === "--by") options.scope = (argv[++i] || "").trim() === "volume" ? "volume" : "chapter";
    else if (arg === "--json") options.json = true;
    else if (arg === "--out" || arg === "-o") options.out = argv[++i] || "";
    else if (arg === "--limit" || arg === "-n") options.limit = Number(argv[++i]) || 0;
    else if (arg === "--all") options.showAll = true;
    else if (arg === "--live") options.live = true;
    else if (arg === "--verify-source") options.verifySource = true;
    else if (arg === "--index-x") options.indexXDir = argv[++i] || "";
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

function usage() {
  return [
    "说话习惯层（离线，不调用模型）",
    "",
    "  node scripts/speech-habit.js [--table <文件>]... [--profile <id>] [--by chapter|volume] [--limit N] [--all] [--live] [--verify-source] [--json] [--out <文件>]",
    "",
    "  --table    说话习惯表（xlsx/csv/tsv/json），可重复；缺省取特化档案声明的表",
    "  --profile  特化档案 id（决定默认表与作用范围）",
    "  --by       判定单位：chapter（默认，按章命中人名）或 volume（整卷）",
    "  --all      输出所有章的明细（默认只列有启用角色或疑似流失的章）",
    "  --live     忽略快照里构建期算好的结果，按当前表重算（默认直接用构建期结果，与页面/AI 同源）",
    "  --verify-source  用 index-X 缓存的日文原文校验章节结构与口癖计数（--index-x 指定目录，缺省取 ../index-X）",
    "  --limit    只输出前 N 章",
    "  --json     以 JSON 输出",
    "  --out      同时把结果写入指定文件",
  ].join("\n");
}

function loadRows() {
  const { project, file, rows, data } = loadActiveCompareData();
  return {
    project,
    file,
    rows,
    speechHabits: data.speechHabits || null,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const profile = resolveProfile(options.profileId || undefined);
  const tables = normalizeSpeechTablePaths([
    ...options.tables,
    ...(profile.speechTables || []),
    ...String(process.env.TRANSCOMPARATOR_SPEECH_TABLES || "").split(/[;\n]/),
  ]);
  if (!tables.length) {
    console.error(`没有可用的说话习惯表：特化档案「${profile.name}」没有声明 speechTables，也没有 --table / TRANSCOMPARATOR_SPEECH_TABLES。`);
    return 1;
  }

  const loaded = loadSpeechTables(tables);
  for (const error of loaded.errors) console.warn(`说话习惯表加载告警：${error}`);
  if (!loaded.entries.length) {
    console.error("说话习惯表没有可用条目，请检查表头是否包含「角色」列。");
    return 1;
  }

  const { project, file, rows, speechHabits } = loadRows();
  const volume = volumeKeyFromFiles(project.files);
  // 默认消费构建期算好的结果：页面、AI 任务与这个脚本看到的是同一份结论，避免三处各算一遍。
  // 指纹按本次实际加载的表重算（落盘块里只有文件名，本机路径不回读产物）。
  const layerMatch = options.live ? null : speechHabitLayerFor(speechHabits, profile.id, { files: loaded.files });
  let chapters;
  let layerInfo = "（现算）";
  if (layerMatch && !layerMatch.stale) {
    const entry = layerMatch.entry;
    chapters = entry.chapters.map((chapter) => ({
      chapter: chapter.chapter,
      rowCount: chapter.rowCount,
      indexRange: chapter.indexRange,
      characters: chapter.characters,
      habitRows: chapter.misses.length,
      misses: chapter.misses.map((miss) => ({ index: miss.index, items: miss.items, source: "", target: "" })),
    }));
    layerInfo = `（构建期结果，生成于 ${speechHabits?.generatedAt || "未知时间"}）`;
    if (entry.scope !== options.scope) {
      console.warn(`提示：快照里的说话习惯结果是「${entry.scope === "volume" ? "按卷" : "按章"}」口径，与本次 --by ${options.scope} 不一致；加 --live 可按当前口径重算。`);
    }
  } else {
    if (layerMatch && layerMatch.stale) {
      console.warn("提示：说话习惯表在构建之后被修改过，本次按最新表重算；重新构建工作台可让页面同步。");
    } else if (!speechHabits) {
      console.warn("提示：当前快照里没有说话习惯层（老快照或构建时该档案还没声明表）；本次按最新表现算，重新构建工作台可让页面也显示。");
    }
    chapters = summarizeChapters({ rows, tables: loaded, volume, scope: options.scope });
  }
  const report = {
    project: project.projectKey || "",
    snapshot: file,
    profile: profile.id,
    scope: options.scope,
    volume: volume?.code || "",
    source: layerInfo,
    tables: loaded.files,
    entries: loaded.entries.length,
    chapters,
  };

  if (options.verifySource) {
    const verification = verifyAgainstSource({
      indexXDir: options.indexXDir || defaultIndexXDir(),
      volume,
      rows,
      tables: loaded,
    });
    report.verification = verification.ok ? verification : { ok: false, error: verification.error };
  }

  if (options.json) {
    const text = JSON.stringify(report, null, 2);
    console.log(text);
    if (options.out) fs.writeFileSync(path.resolve(options.out), `${text}\n`, "utf8");
    return 0;
  }

  const interesting = options.showAll
    ? chapters
    : chapters.filter((item) => item.characters.some((character) => character.activated) || item.habitRows);
  const listed = options.limit > 0 ? interesting.slice(0, options.limit) : interesting;

  console.log(speechTableSummary(loaded));
  console.log(`特化档案：${profile.name}（${profile.id}）｜判定单位：${options.scope === "volume" ? "整卷" : "按章"}${volume ? `｜本卷 ${volume.code}` : ""}${layerInfo}`);
  console.log(`共 ${chapters.length} ${options.scope === "volume" ? "项" : "章"}，其中 ${interesting.length} ${options.scope === "volume" ? "项" : "章"}命中人名或有疑似流失行`);
  for (const item of listed) {
    const activated = item.characters.filter((character) => character.activated);
    const mentioned = item.characters.filter((character) => !character.activated);
    console.log("");
    console.log(`—— ${item.chapter}（第 ${item.indexRange[0]}~${item.indexRange[1]} 行，共 ${item.rowCount} 行）`);
    console.log(`   启用说话特色：${activated.length ? activated.map((character) => `${character.character}${character.habit ? `「${character.habit}」` : `（${character.type || "说话特色"}）`}${character.expected ? `→${character.expected}` : ""}`).join("；") : "（无）"}`);
    if (mentioned.length) console.log(`   仅名字片段提及（不启用）：${mentioned.map((character) => character.character).join("、")}`);
    console.log(`   疑似说话特色流失：${item.habitRows} 行`);
    for (const miss of item.misses.slice(0, options.showAll ? 20 : 5)) {
      const detail = miss.items.map((entry) => `${entry.character}「${entry.habit}」${entry.expected ? `→${entry.expected}` : ""}`).join("；");
      console.log(`     #${miss.index} ${detail}`);
      if (options.showAll) {
        console.log(`        原文：${miss.source}`);
        console.log(`        译文：${miss.target}`);
      }
    }
    if (item.misses.length > (options.showAll ? 20 : 5)) {
      console.log(`     …（其余 ${item.misses.length - (options.showAll ? 20 : 5)} 行已省略，用 --all 查看）`);
    }
  }
  if (report.verification) {
    const v = report.verification;
    console.log("");
    console.log("—— 日文原文校验（index-X 缓存）——");
    if (!v.ok) {
      console.log(`   校验未执行：${v.error}`);
    } else {
      console.log(`   原文目录：${v.sourceName}｜正文文件 ${v.sourceFiles.length} 个`);
      console.log(`   章节结构：快照 ${v.chapters.length} 项，原文标记 ${v.sourceMarkers.map((item) => item.key).join(" ")}`);
      console.log(`   章节标记匹配：${v.chapters.length - v.chaptersMissing.length}/${v.chapters.length}${v.chaptersMissing.length ? `（未找到：${v.chaptersMissing.join("、")}）` : ""}`);
      if (v.characters.length) {
        console.log("   口癖计数（原文 / 快照）：");
        for (const item of v.characters.slice(0, 12)) {
          const diff = item.habitCountSource - item.habitCountRows;
          console.log(`     ${item.character}${item.habit ? `「${item.habit}」` : ""}：${item.habitCountSource} / ${item.habitCountRows}${diff > 0 ? `（快照少 ${diff} 次，通常是后记/插页未收入正文）` : ""}`);
        }
      }
    }
  }
  if (options.out) {
    fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\n已写入 ${path.resolve(options.out)}`);
  }
  return 0;
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
