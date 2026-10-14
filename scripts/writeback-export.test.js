const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// 端到端：服务端必须把「整卷行序」交给写回引擎——同一卷里两处相同的段落，只写第 2 处时不能落到第 1 处。
// storage-layout 在 require 时读数据目录，所以先指向临时目录再加载服务端，否则会动到真实项目的活动指针。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-writeback-"));
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { createProjectStaging, projectArtifacts, publishProject } = require("./project-store");
const { createServer, host } = require("./input-server");
const { ROWS, createWorkbench, storageFixture } = require("./workbench-fixture");

const PARAGRAPHS = ["开场。", "尽管如此。", "甲段。", "乙段。", "丙段。", "尽管如此。", "收场。"];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function apiToken(port) {
  const response = await fetch(`http://${host}:${port}/`);
  const match = (await response.text()).match(/<meta\s+name="transcomparator-session-token"\s+content="([^"]+)">/i);
  assert.ok(match, "setup page should contain an injected API session token");
  return match[1];
}

function paragraphTexts(file) {
  return [...fs.readFileSync(file, "utf8").matchAll(/<p>([\s\S]*?)<\/p>/g)].map((match) => match[1]);
}

// 最小项目：登记的原文件就是要写回的 XHTML，行数据与该文件的段落一一对应。
function createFixture(name, paragraphs = PARAGRAPHS) {
  const root = path.join(dataDir, name);
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(root, "chapter.xhtml");
  fs.writeFileSync(source, `<html><body>\n${paragraphs.map((text) => `<p>${text}</p>`).join("\n")}\n</body></html>\n`, "utf8");
  const jp = path.join(root, "source.txt");
  fs.writeFileSync(jp, "原文\n", "utf8");
  const staging = createProjectStaging(
    { comparisonMode: "bilingual", inputMode: "html", files: { jp, cn: source }, labels: { jp: "原文", cn: "主文本" } },
    { dataDir },
  );
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project: { projectKey: staging.projectKey, generatedAt: new Date().toISOString(), rowsSignature: `${name}-rows`, comparisonMode: "bilingual" },
    rowsSignature: `${name}-rows`,
    rows: paragraphs.map((text, index) => ({ index: index + 1, jp: "", cn: text })),
  }), "utf8");
  for (const artifact of projectArtifacts) {
    const file = path.join(staging.dir, artifact);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${name}:${artifact}`, "utf8");
  }
  const project = publishProject(staging.dir, { dataDir });
  return { source, projectKey: project.id, rowsSignature: project.rowsSignature };
}

async function exportRevisions(port, payload) {
  const token = await apiToken(port);
  const response = await fetch(`http://${host}:${port}/api/translation-export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-TransComparator-Token": token },
    body: JSON.stringify(payload),
  });
  return { status: response.status, result: await response.json() };
}

test("写回按整卷行序落位：只写第二处相同段落时不会改到第一处", async () => {
  const fixture = createFixture("ordered");
  const server = createServer();
  const port = await listen(server);
  try {
    const { status, result } = await exportRevisions(port, {
      projectKey: fixture.projectKey, rowsSignature: fixture.rowsSignature,
      entries: [{ id: "6", targetKey: "cn", searchText: "尽管如此。", replaceText: "尽管如此（第二处改）。" }],
      rowTexts: { cn: PARAGRAPHS.slice(0, 6) },
    });
    assert.equal(status, 200);
    assert.equal(result.updated, 1);
    assert.deepEqual(result.missed, []);
    assert.deepEqual(result.ambiguous, []);
    assert.deepEqual(paragraphTexts(fixture.source), [
      "开场。", "尽管如此。", "甲段。", "乙段。", "丙段。", "尽管如此（第二处改）。", "收场。",
    ]);
  } finally {
    await close(server);
  }
});

test("写回按整卷行序落位：两处同段各归其位", async () => {
  const fixture = createFixture("pair");
  const server = createServer();
  const port = await listen(server);
  try {
    const { status, result } = await exportRevisions(port, {
      projectKey: fixture.projectKey, rowsSignature: fixture.rowsSignature,
      entries: [
        { id: "2", targetKey: "cn", searchText: "尽管如此。", replaceText: "第一处改。" },
        { id: "6", targetKey: "cn", searchText: "尽管如此。", replaceText: "第二处改。" },
      ],
      rowTexts: { cn: PARAGRAPHS.slice(0, 6) },
    });
    assert.equal(status, 200);
    assert.equal(result.updated, 2);
    assert.deepEqual(result.missed, []);
    assert.deepEqual(result.ambiguous, []);
    assert.deepEqual(paragraphTexts(fixture.source), [
      "开场。", "第一处改。", "甲段。", "乙段。", "丙段。", "第二处改。", "收场。",
    ]);
  } finally {
    await close(server);
  }
});

// 写回定位按「整卷行序」推进锚点：未改动的行也要按自己的文本先占住位置，要改的行才落在
// 自己那一处。这份行序清单由客户端随请求发出（服务端只做形状校验），缺了它同一段文字在
// 别处先出现时就会被本行改掉——所以请求体必须带上它，且只能带真实存在的列。
test("写回请求带整卷行序：批量写回按目标列发出全部行文本", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: { "/api/translation-export": { ok: true, updated: 2, missed: [], ambiguous: [], targets: ["B.txt"] } },
  });
  ui.run('notes["1"] = { revisionText: "译文一改", revisionTarget: "cn" }; notes["3"] = { revisionText: "译文三改", revisionTarget: "cn" };');
  await ui.element("exportNotes").dispatch("click");

  assert.equal(ui.posts.length, 1);
  const [post] = ui.posts;
  assert.equal(post.url, "/api/translation-export");
  assert.deepEqual(post.body.entries.map((entry) => entry.id), ["1", "3"]);
  assert.deepEqual(post.body.entries.map((entry) => entry.searchText), ["译文一", "译文三"]);
  assert.deepEqual(post.body.rowTexts, { cn: ROWS.map((row) => row.cn) });
  // 双语模式没有第三列，行序清单里也不允许出现 tw。
  assert.equal(Object.prototype.hasOwnProperty.call(post.body.rowTexts, "tw"), false);
});

test("写回请求带整卷行序：单行写回附带后文定位上下文", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: { "/api/translation-export": { ok: true, updated: 1, missed: [], ambiguous: [], targets: ["B.txt"] } },
  });
  ui.run('notes["2"] = { revisionText: "译文二改", revisionTarget: "cn" };');
  await ui.run('writebackSingleRevision("2", { disabled: false, textContent: "", classList: { add() {} } })');

  assert.equal(ui.posts.length, 1);
  // 后文用于界定重复句的位置，不作为待写回条目。
  assert.deepEqual(ui.posts[0].body.rowTexts, { cn: ROWS.map((row) => row.cn) });
  assert.deepEqual(ui.posts[0].body.entries.map((entry) => entry.id), ["2"]);
});

test("写回请求只附带有限后文，不扩大单行写入或确认范围", async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ ...ROWS[0], index: i + 1, cn: `译文${i + 1}`, signature: `sig-${i + 1}` }));
  const ui = createWorkbench(storageFixture(), {
    rows, apiResponses: { "/api/translation-export": { ok: true, updated: 1, missed: [], ambiguous: [] } },
  });
  ui.run('notes["2"] = { revisionText: "第二行改后", revisionTarget: "cn" };');
  await ui.run('writebackSingleRevision("2", { disabled: false, textContent: "" })');
  assert.deepEqual(ui.posts[0].body.rowTexts, { cn: rows.slice(0, 34).map(row => row.cn) });
  assert.deepEqual(ui.posts[0].body.entries.map(entry => entry.id), ["2"]);
  assert.equal(ui.run('notes["2"].manualDone'), true);
  assert.equal(ui.run('Object.keys(notes).length'), 1);
});

test("旧页面行数据经真实单行请求连续写回两处近邻重复句，各自落位", async () => {
  const original = ["开场。", "「？」", "前文锚点。", "前段旧文。", "重复句。", "中间锚点。", "重复句。", "收场。", "「？」"];
  const current = [...original];
  current[1] = "问句已改。";
  current[3] = "前段已改。";
  const fixture = createFixture("stale-context", original);
  fs.writeFileSync(fixture.source, current.map(text => `<p>${text}</p>`).join("\n"));
  const server = createServer();
  const port = await listen(server);
  try {
    const ui = createWorkbench(storageFixture(), {
      projectKey: fixture.projectKey, rowsSignature: fixture.rowsSignature,
      rows: original.map((cn, index) => ({ ...ROWS[0], index: index + 1, cn, signature: `sig-${index + 1}` })),
      apiResponses: { "/api/translation-export": async request => {
        const { status, result } = await exportRevisions(port, JSON.parse(request.body));
        assert.equal(status, 200);
        assert.equal(result.updated, 1);
        assert.deepEqual(result.missed, []);
        assert.deepEqual(result.ambiguous, []);
        return result;
      } },
    });
    ui.run('notes["5"] = { revisionText: "第一处改。", revisionTarget: "cn" }; notes["7"] = { revisionText: "第二处改。", revisionTarget: "cn" };');
    for (const id of [5, 7]) await ui.run(`writebackSingleRevision("${id}", { disabled: false, textContent: "" })`);
    current[4] = "第一处改。";
    current[6] = "第二处改。";
    assert.deepEqual(paragraphTexts(fixture.source), current);
    assert.equal(ui.posts.length, 2);
    assert.equal(ui.run('notes["5"].manualDone && notes["7"].manualDone'), true);
  } finally { await close(server); }
});
