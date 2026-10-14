const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createServer, host } = require("./input-server");
const { publishProject, projectArtifacts } = require("./project-store");
const { createWorkbench, currentKey } = require("./workbench-fixture");

test("备注接口沿用同源鉴权、严格版本写入与回读，页面动态注入且不修改已发布快照", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-notes-api-"));
  const previous = process.env.TRANSCOMPARATOR_DATA_DIR;
  process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;
  const server = createServer();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
    else process.env.TRANSCOMPARATOR_DATA_DIR = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  const base = `http://${host}:${server.address().port}`;
  const rootHtml = await (await fetch(base + "/")).text();
  const token = rootHtml.match(/name="transcomparator-session-token" content="([^"]+)"/)[1];
  const post = (action, body, headers = {}) => fetch(base + "/api/notes/spaces/" + action, {
    method: "POST", headers: { "X-TransComparator-Token": token, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const raw = JSON.stringify({ 1: { note: "持久备注 </script>", manualDone: true, rowSig: "sig-1" } });
  assert.equal((await post("write", { key: currentKey, raw, expectedVersion: null }, { "X-TransComparator-Token": "" })).status, 403);
  assert.equal((await post("write", { key: currentKey, raw, expectedVersion: null }, { Origin: "https://outside.example" })).status, 403);
  assert.equal((await post("write", { key: currentKey, raw })).status, 400);
  const response = await post("write", { key: currentKey, raw, expectedVersion: null });
  assert.equal(response.status, 200);
  const saved = (await response.json()).space;
  assert.equal(saved.raw, raw);
  assert.equal((await post("write", { key: currentKey, raw: "{}", expectedVersion: null })).status, 409);
  assert.equal((await post("write", { key: currentKey, raw: "bad-json", expectedVersion: saved.version })).status, 400);
  const inventory = await (await fetch(base + "/api/notes/spaces")).json();
  assert.equal(inventory.spaces[0].raw, raw);
  const staging = path.join(dataDir, ".staging", "publish");
  fs.mkdirSync(staging, { recursive: true });
  for (const name of projectArtifacts) fs.writeFileSync(path.join(staging, name), "{}");
  fs.writeFileSync(path.join(staging, "translation-compare.json"), JSON.stringify({
    project: { projectKey: "project", generatedAt: "2026-03-01T00:00:00.000Z", rowsSignature: "rows" }, rows: [],
  }));
  const sourceHtml = createWorkbench().html;
  fs.writeFileSync(path.join(staging, "translation-compare.html"), sourceHtml);
  const published = publishProject(staging, { dataDir });
  const html = await (await fetch(base + "/output/translation-compare.html")).text();
  const bootstrap = JSON.parse(html.match(/<script id="notesDiskData" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(bootstrap.spaces[0].raw, raw);
  assert.equal(fs.readFileSync(path.join(dataDir, "projects", "project", "snapshots", published.snapshotId,
    "translation-compare.html"), "utf8"), sourceHtml);
  assert.equal((await post("delete", { key: currentKey, expectedVersion: saved.version }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post("delete", { key: currentKey, expectedVersion: saved.version })).status, 200);
  assert.equal((await post("write", { key: currentKey, raw, expectedVersion: saved.version })).status, 409);
});
