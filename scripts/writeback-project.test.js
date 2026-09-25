const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-project-test-"));
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;
const store = require("../src/storage/project-store");
const { createServer, host } = require("../src/runtime/input-server");
const { createWorkbench } = require("./workbench-fixture");
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function publish(name, rowsSignature = name) {
  const target = path.join(dataDir, name + ".html");
  if (!fs.existsSync(target)) fs.writeFileSync(target, "<p>共同段落。</p>");
  const selection = { comparisonMode: "bilingual", inputMode: "document", files: { jp: target, cn: target }, labels: { jp: "原文", cn: "译文" } };
  const staging = store.createProjectStaging(selection);
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project: { projectKey: staging.projectKey, rowsSignature, generatedAt: new Date().toISOString() },
    rows: [{ index: 1, jp: "原文", cn: "共同段落。" }],
  }));
  for (const name of store.projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, "{}");
  }
  return { target, project: store.publishProject(staging.dir) };
}

test("翻译写回拒绝缺少身份、跨项目和过期内容，允许布局更新后的同内容页面", async () => {
  const a = publish("a");
  const b = publish("b");
  const server = createServer();
  await new Promise(resolve => server.listen(0, host, resolve));
  try {
    const base = "http://" + host + ":" + server.address().port;
    const html = await (await fetch(base + "/")).text();
    const token = html.split('name="transcomparator-session-token" content="')[1].split('"')[0];
    const payload = { entries: [{ id: 1, targetKey: "cn", searchText: "共同段落。", replaceText: "修订段落。" }], rowTexts: { cn: ["共同段落。"] } };
    const write = identity => fetch(base + "/api/translation-export", { method: "POST",
      headers: { "Content-Type": "application/json", "X-TransComparator-Token": token },
      body: JSON.stringify({ ...payload, ...identity }),
    });
    for (const identity of [{}, { projectKey: a.project.id, rowsSignature: a.project.rowsSignature },
      { projectKey: b.project.id, rowsSignature: "old-content" }]) {
      const response = await write(identity);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).ok, false);
      assert.equal(fs.readFileSync(a.target, "utf8"), "<p>共同段落。</p>");
      assert.equal(fs.readFileSync(b.target, "utf8"), "<p>共同段落。</p>");
    }
    const next = publish("b");
    assert.notEqual(next.project.snapshotId, b.project.snapshotId);
    const response = await write({ projectKey: b.project.id, rowsSignature: b.project.rowsSignature });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).updated, 1);
    assert.equal(fs.readFileSync(b.target, "utf8"), "<p>修订段落。</p>");
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("单行与批量写回均携带页面项目和内容签名", async () => {
  const ui = createWorkbench(undefined, { apiResponses: { "/api/translation-export": { ok: true, updated: 1, missed: [], ambiguous: [] } } });
  ui.run('notes["1"] = { note: "", revisionText: "修订一", revisionTarget: "cn" };');
  await ui.run('writebackSingleRevision("1", document.getElementById("testWriteButton"))');
  await ui.element("exportNotes").dispatch("click");
  const requests = ui.posts.filter(request => request.url === "/api/translation-export");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.body.projectKey, "project");
    assert.equal(request.body.rowsSignature, "rows");
  }
});
