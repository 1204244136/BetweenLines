const fs = require("fs");
const path = require("path");
const { outputDir, loadParagraphs } = require("./text-utils");
const { activeLangs, describeSelection, resolveInputSelection, saveSelection, selectionFile } = require("./input-selection");

const progressPrefix = "@@transcomparator-progress@@";

function reportProgress(percent, label) {
  if (process.env.TRANS_COMPARATOR_MACHINE_PROGRESS !== "1") return;
  console.log(`${progressPrefix}${JSON.stringify({ percent, label })}`);
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  reportProgress(1, "读取输入配置");
  const selection = await resolveInputSelection({ promptIfSaved: true });
  saveSelection(selection);
  const snapshotSelectionFile = path.join(outputDir, "input-selection.json");
  fs.writeFileSync(snapshotSelectionFile, JSON.stringify(selection, null, 2), "utf8");

  reportProgress(3, "转换并清理源文本");
  const paragraphs = await loadParagraphs(selection);
  const outFile = path.join(outputDir, "paragraphs.json");
  fs.writeFileSync(outFile, JSON.stringify(paragraphs, null, 2), "utf8");
  reportProgress(8, "段落导出完成");

  console.log("Input files:");
  console.log(describeSelection(selection));
  // 只报告该模式真实参与的列：双语模式没有第三列，不打印 TW paragraphs: 0。
  for (const lang of activeLangs(paragraphs.comparisonMode)) {
    console.log(`${lang.toUpperCase()} paragraphs: ${paragraphs[lang].length}`);
  }
  console.log(`Saved input selection: ${selectionFile}`);
  console.log(`Wrote ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
