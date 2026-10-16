const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-auxiliary-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dir;
const { validateSelection } = require("./input-selection");
const { saveInputSelection } = require("../src/runtime/input-files");
const { createProjectContext } = require("./project-context");
const { createProjectStaging, projectArtifacts, publishProject, activateProject, readProjectSelection } = require("./project-store");
const { startPrefilter, startProofread, clientStatus, clearProofreadCache } = require("./ai-proofread");
const { buildTermLayer } = require("../src/workbenches/translation-compare/term-layer");
const { buildSpeechHabitLayer } = require("../src/workbenches/translation-compare/speech-habit-layer");
const { loadSpeechTables } = require("../src/workbenches/translation-compare/ai/speech-habit");
const { rebuildCompareHtmlFromSnapshot } = require("./build-compare");
const { createConsole } = require("./setup-console-fixture");
const { createInputRoutes } = require("../src/runtime/routes/inputs");

const jp = path.join(dir, "source.txt");
const cn = path.join(dir, "translation.txt");
const terms = path.join(dir, "terms.csv");
const habits = path.join(dir, "habits.csv");
fs.writeFileSync(jp, "甲野一郎", "utf8");
fs.writeFileSync(cn, "甲野一郎", "utf8");
fs.writeFileSync(terms, "Base_Ori,Base_Trans,Type\n甲野一郎,甲野一郎,人名\n", "utf8");
fs.writeFileSync(habits, "角色,口癖,x版\n甲野一郎,オレ,本大爷\n", "utf8");
const rows = [{ index: 1, chapter: "正文", jp: "甲野一郎", cn: "甲野一郎", score: 1, relation: "1:1" }];

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

function selection(tables = {}) {
  return validateSelection({ files: { jp, cn }, comparisonMode: "bilingual", ...tables });
}

function publish(label, tables) {
  const chosen = selection({ ...tables, files: { jp, cn } });
  // 不同输入项目才能验证切换隔离；辅助表本身不改变项目键。
  chosen.startMarkers = { jp: label };
  const project = createProjectContext(chosen, rows);
  const staging = createProjectStaging(chosen);
  const speechHabits = buildSpeechHabitLayer({ rows, selectedTables: chosen.speechTables });
  const termPrefilter = buildTermLayer({ rows, selectedTables: chosen.termTables });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({ project, rows, speechHabits, termPrefilter }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir);
  return project;
}

test("控制台选择保存两类独立可空路径，拒绝失效文件且不改变项目与备注身份", () => {
  const empty = selection();
  assert.deepEqual(empty.termTables, []);
  assert.deepEqual(empty.speechTables, []);
  const result = saveInputSelection({ ...empty, termTables: `${terms}; ${terms}`, speechTables: [habits] });
  assert.deepEqual(result.selection.termTables, [terms]);
  assert.deepEqual(result.selection.speechTables, [habits]);
  const a = createProjectContext(empty, rows);
  const b = createProjectContext(result.selection, rows);
  assert.equal(a.projectKey, b.projectKey);
  assert.equal(a.rowsSignature, b.rowsSignature);
  assert.deepEqual(a.notesStorage, b.notesStorage);
  assert.throws(() => selection({ termTables: [path.join(dir, "missing.csv")] }), /辅助表文件不存在/);
  assert.throws(() => selection({ termTables: [jp] }), /不支持的辅助表格式/);
  assert.deepEqual(selection({ termTables: terms }).speechTables, []);
  assert.deepEqual(selection({ speechTables: habits }).termTables, []);
});

test("构建时显式空选择屏蔽档案与环境表，非空选择在所有档案槽位一致", () => {
  const profiles = [{ id: "a", name: "A", termTables: [terms], speechTables: [habits] }, { id: "b", name: "B" }];
  for (const [build, file] of [[buildTermLayer, terms], [buildSpeechHabitLayer, habits]]) {
    assert.deepEqual(build({ rows, profiles, envTables: [file], selectedTables: [] }).byProfile, {});
    const built = build({ rows, profiles, envTables: ["missing.csv"], selectedTables: [file] });
    assert.deepEqual(Object.keys(built.byProfile), ["a", "b"]);
    assert.deepEqual(built.errors, []);
    assert.deepEqual(built.byProfile.a.files, [path.basename(file)]);
    assert.deepEqual(built.byProfile.b.files, [path.basename(file)]);
  }
});

test("真实构建入口使用生成前选表，空数组不被环境或档案补入", () => {
  for (const enabled of [false, true]) {
    const output = fs.mkdtempSync(path.join(dir, "build-"));
    const chosen = selection({ termTables: enabled ? [terms] : [], speechTables: enabled ? [habits] : [] });
    const selectionFile = path.join(output, "input-selection.json");
    fs.writeFileSync(selectionFile, JSON.stringify(chosen), "utf8");
    fs.writeFileSync(path.join(output, "jp-align.json"), JSON.stringify({
      pivotLang: "cn", groups: [{ jpStart: 0, jpEnd: 1, pivotStart: 0, pivotEnd: 1, score: 1, relation: "1:1" }],
    }), "utf8");
    const result = spawnSync(process.execPath, [path.join(__dirname, "../src/workbenches/translation-compare/build-compare.js")], {
      encoding: "utf8",
      env: { ...process.env, TRANSCOMPARATOR_SELECTION_FILE: selectionFile, TRANSCOMPARATOR_OUTPUT_DIR: output,
        TRANSCOMPARATOR_JP_FILE: "", TRANSCOMPARATOR_CN_FILE: "", TRANSCOMPARATOR_TW_FILE: "",
        TRANSCOMPARATOR_TERM_TABLES: terms, TRANSCOMPARATOR_SPEECH_TABLES: habits },
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(fs.readFileSync(path.join(output, "translation-compare.json"), "utf8"));
    assert.equal(data.rows.length, 1);
    for (const key of ["termPrefilter", "speechHabits"]) {
      assert.equal(Object.keys(data[key].byProfile).length > 0, enabled);
    }
  }
});

test("说话习惯与对照表采用相同外部格式，不执行 JavaScript 数据模块", () => {
  const marker = path.join(dir, "module-executed");
  const module = path.join(dir, "habits.js");
  fs.writeFileSync(module, `require("fs").writeFileSync(${JSON.stringify(marker)}, "bad"); module.exports = { entries: [] };`, "utf8");
  assert.throws(() => selection({ termTables: [module] }), /不支持的辅助表格式/);
  assert.throws(() => selection({ speechTables: [module] }), /不支持的辅助表格式/);
  assert.equal(loadSpeechTables([module]).errors.length, 1);
  assert.equal(fs.existsSync(marker), false);
});

test("生成后的 AI、预筛和状态只用项目表，空选择不被请求或环境重新挂入", async () => {
  const mounted = publish("mounted", { termTables: [terms], speechTables: [habits] });
  const empty = publish("empty", { termTables: [], speechTables: [] });
  const previousTermEnv = process.env.TRANSCOMPARATOR_TERM_TABLES;
  const previousSpeechEnv = process.env.TRANSCOMPARATOR_SPEECH_TABLES;
  process.env.TRANSCOMPARATOR_TERM_TABLES = terms;
  process.env.TRANSCOMPARATOR_SPEECH_TABLES = habits;
  try {
    for (const [project, expected] of [[mounted, 1], [empty, 0]]) {
      clearProofreadCache();
      const input = { projectKey: project.projectKey, rowsSignature: project.rowsSignature, termTables: [terms], speechTables: [habits], model: "fixture", baseUrl: "http://127.0.0.1:1" };
      const prefiltered = await startPrefilter(input);
      assert.equal(prefiltered.termPrefiltered, expected);
      const state = await startProofread(input);
      assert.equal(state.termPrefiltered, expected);
      assert.equal(state.speechHabitCharacters.length, expected);
      for (const profileId of ["novel", "demo"]) {
        const info = clientStatus({ ...input, profileId, includeResults: false });
        assert.deepEqual(info.termTableStatus.files, expected ? [terms] : []);
        assert.deepEqual(info.speechHabitStatus.files, expected ? [habits] : []);
      }
    }
    activateProject(mounted.projectKey);
    assert.deepEqual(readProjectSelection(mounted.projectKey).speechTables, [habits]);
    for (const [script, expectedFile] of [["term-prefilter.js", terms], ["speech-habit.js", habits]]) {
      const result = spawnSync(process.execPath, [path.join(__dirname, script), "--json"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).tables, [expectedFile]);
    }
  } finally {
    clearProofreadCache();
    if (previousTermEnv === undefined) delete process.env.TRANSCOMPARATOR_TERM_TABLES;
    else process.env.TRANSCOMPARATOR_TERM_TABLES = previousTermEnv;
    if (previousSpeechEnv === undefined) delete process.env.TRANSCOMPARATOR_SPEECH_TABLES;
    else process.env.TRANSCOMPARATOR_SPEECH_TABLES = previousSpeechEnv;
  }
});

test("旧版表层应用布局时按项目选择重算，保留空选择且不将表路径注入页面", () => {
  for (const selected of [[], [terms]]) {
    const snapshot = fs.mkdtempSync(path.join(dir, "layout-"));
    fs.writeFileSync(path.join(snapshot, "input-selection.json"), JSON.stringify(selection({ termTables: selected })), "utf8");
    fs.writeFileSync(path.join(snapshot, "translation-compare.json"), JSON.stringify({ rows, termPrefilter: { version: 0, byProfile: { obsolete: { files: ["old.csv"] } } } }), "utf8");
    rebuildCompareHtmlFromSnapshot(snapshot);
    const data = JSON.parse(fs.readFileSync(path.join(snapshot, "translation-compare.json"), "utf8"));
    assert.equal(Object.keys(data.termPrefilter.byProfile).length > 0, selected.length > 0);
    const html = fs.readFileSync(path.join(snapshot, "translation-compare.html"), "utf8");
    assert.equal(html.includes(JSON.stringify(terms).slice(1, -1)), false);
  }
});

test("控制台发送明确空数组，切换项目恢复独立选择，隐藏说话人页面无关控件", async () => {
  const ui = createConsole();
  ui.run(`state.comparisonMode = "bilingual"; state.roleFiles = ${JSON.stringify({ jp: { path: jp, name: "source.txt" }, cn: { path: cn, name: "translation.txt" } })};`);
  let sent;
  ui.context.fetch = async (url, options) => {
    sent = JSON.parse(options.body);
    return { json: async () => ({ ok: true }) };
  };
  await ui.run("persistSelection()");
  assert.deepEqual(sent.termTables, []);
  assert.deepEqual(sent.speechTables, []);
  ui.run(`applySavedSelection(${JSON.stringify(selection({ termTables: [terms], speechTables: [habits] }))}, {}, true)`);
  assert.equal(ui.element("termTables").value, terms);
  assert.equal(ui.element("speechTables").value, habits);
  ui.run(`applySavedSelection(${JSON.stringify(selection())}, {}, true)`);
  assert.equal(ui.element("termTables").value, "");
  assert.equal(ui.element("speechTables").value, "");
  ui.run('state.workbenchMode = "speaker-attribution"; renderWorkbenchMode()');
  assert.equal(ui.element("translationTablesPanel").hidden, true);
});

test("原生辅助表选择使用表格过滤器，取消不覆盖原选择，校验拒绝正文文件", async () => {
  let nextPick = terms;
  const route = createInputRoutes({ speaker: {}, pickPath: async (mode, options) => {
    assert.equal(mode, "file");
    assert.equal(options.tables, true);
    assert.equal(options.initialDir, dir);
    return nextPick;
  } });
  async function post() {
    const req = new PassThrough();
    req.method = "POST";
    req.headers = { "content-type": "application/json" };
    let result;
    const pending = route(req, { writeHead() {}, end(text) { result = JSON.parse(text); } }, "/api/pick-table");
    req.end(JSON.stringify({ kind: "termTables", currentPath: terms }));
    await pending;
    return result;
  }
  assert.equal((await post()).file.path, terms);
  nextPick = "";
  assert.equal((await post()).canceled, true);
  nextPick = jp;
  await assert.rejects(post(), /不支持的辅助表格式/);

  const ui = createConsole();
  ui.element("termTables").value = terms;
  let finish;
  ui.context.fetch = () => new Promise((resolve) => { finish = () => resolve({ json: async () => ({ ok: true, canceled: true }) }); });
  const pending = ui.run('pickTable("termTables")');
  assert.equal(ui.element("runButton").disabled, true);
  finish();
  await pending;
  assert.equal(ui.element("termTables").value, terms);
  assert.equal(ui.element("termTablesPick").disabled, false);
});
