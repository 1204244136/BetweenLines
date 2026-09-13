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
function createFixture(name) {
  const root = path.join(dataDir, name);
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(root, "chapter.xhtml");
  fs.writeFileSync(source, `<html><body>\n${PARAGRAPHS.map((text) => `<p>${text}</p>`).join("\n")}\n</body></html>\n`, "utf8");
  const jp = path.join(root, "source.txt");
  fs.writeFileSync(jp, "原文\n", "utf8");
  const staging = createProjectStaging(
    { comparisonMode: "bilingual", inputMode: "html", files: { jp, cn: source }, labels: { jp: "原文", cn: "主文本" } },
    { dataDir },
  );
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project: { projectKey: staging.projectKey, generatedAt: new Date().toISOString(), rowsSignature: `${name}-rows`, comparisonMode: "bilingual" },
    rowsSignature: `${name}-rows`,
    rows: PARAGRAPHS.map((text, index) => ({ index: index + 1, jp: "", cn: text })),
  }), "utf8");
  for (const artifact of projectArtifacts) {
    const file = path.join(staging.dir, artifact);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${name}:${artifact}`, "utf8");
  }
  publishProject(staging.dir, { dataDir });
  return { source };
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
