const assert = require("node:assert/strict");
const test = require("node:test");
const { makeHtml } = require("./build-compare");
const { createClientFixture, storageFixture, currentKey, ROWS } = require("./workbench-fixture");

const passed = "[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改";
const reviewed = "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\nStylist复审[调整]：已复审\n复审改案：修订正文\n修改结果：修订正文";
const stopped = "[AI校对]\n校对已终止。";
const seedData = {
  1: { note: passed, manualDone: true, rowSig: "sig-1" },
  2: { note: reviewed, revisionText: "修订正文", rowSig: "sig-2" },
  3: { note: stopped, rowSig: "sig-3" },
};
const seed = { id: "a".repeat(64), key: currentKey, raw: JSON.stringify(seedData) };
const selection = { comparisonMode: "bilingual", files: { jp: "A.txt", cn: "B.txt" } };
const context = { projectKey: "project", rowsSignature: "rows", notesStorage: { key: currentKey } };
const html = () => makeHtml(ROWS, selection, context, null, null, seed);

test("explicit recovery seed restores the verified backup once and survives reload", async () => {
  const storage = storageFixture({ [currentKey]: "{}" });
  const ui = createClientFixture(html(), storage);
  assert.equal(ui.run("Object.keys(notes).length"), 3);
  assert.equal(ui.run('notes["1"].manualDone'), true);
  assert.equal(ui.run('notes["2"].revisionText'), "修订正文");
  assert.equal(ui.element("metricStage1Passed").textContent, 1);
  assert.equal(ui.element("metricStage1NeedsEdit").textContent, 1);
  assert.equal(ui.element("metricStage1Errors").textContent, 1);
  assert.equal(ui.run("notesPersistFailed"), false);
  assert.equal(storage.getItem("translation-compare-recovery-v1:project:" + seed.id), "saved");
  const reopened = createClientFixture(html(), storage);
  assert.equal(reopened.run("Object.keys(notes).length"), 3);
  assert.equal(reopened.run("notesRecovery"), null);
  await reopened.element("clearCurrentNotes").dispatch("click");
  assert.equal(createClientFixture(html(), storage).run("Object.keys(notes).length"), 0);
});

test("recovery preserves manual edits and more complete current conclusions", () => {
  const notes = {
    1: { note: "人工备注", manualDone: true, revisionText: "人工修改", rowSig: "sig-1" },
    2: { note: reviewed + "\nArbiter仲裁[保留]：终审定案", rowSig: "sig-2" },
    3: { note: passed, rowSig: "sig-3" },
  };
  const storage = storageFixture({ [currentKey]: JSON.stringify(notes) });
  const ui = createClientFixture(html(), storage);
  assert.equal(ui.run('notes["1"].revisionText'), "人工修改");
  assert.match(ui.run('notes["2"].note'), /终审定案/);
  assert.equal(ui.run('notes["3"].note'), passed);
});

test("recovery failure keeps the full backup in page memory and retries after capacity is available", async () => {
  const storage = storageFixture({ [currentKey]: "{}" });
  storage.failWrites = true;
  const ui = createClientFixture(html(), storage);
  assert.equal(ui.run("Object.keys(notes).length"), 3);
  assert.equal(storage.getItem(currentKey), "{}");
  assert.equal(storage.getItem("translation-compare-recovery-v1:project:" + seed.id), null);
  assert.equal(ui.element("notesSaveWarning").hidden, false);
  storage.failWrites = false;
  await ui.element("retryNotesSave").dispatch("click");
  const reopened = createClientFixture(html(), storage);
  assert.equal(reopened.run("Object.keys(notes).length"), 3);
  assert.equal(reopened.run("notesPersistFailed"), false);
});

test("recovery validates every row and project before publication and preserves corrupt current data", () => {
  assert.throws(() => makeHtml(ROWS, selection, context, null, null, { ...seed, key: "other" }), /不匹配/);
  assert.throws(() => makeHtml(ROWS, selection, context, null, null, {
    ...seed, raw: JSON.stringify({ ...seedData, 4: { note: passed, rowSig: "missing" } }),
  }), /不匹配/);
  const storage = storageFixture({ [currentKey]: "{broken" });
  const ui = createClientFixture(html(), storage);
  assert.equal(storage.getItem(currentKey), "{broken");
  assert.equal(ui.run("notesStorageBlocked"), true);
  assert.match(ui.run("notesRecovery.message"), /无法解析/);
});

test("known incomplete run cannot overwrite recovered conclusions but new runs still apply", () => {
  const seededHtml = makeHtml(ROWS, selection, context, null, null, { ...seed, ignoredRunIds: ["old-run"] });
  const ui = createClientFixture(seededHtml, storageFixture({ [currentKey]: "{}" }));
  const status = (runId, note) => ({ projectKey: "project", rowsSignature: "rows", runId, running: false,
    results: [{ runId, index: 2, signature: "sig-2", note, done: false, resultRevision: 1 }] });
  ui.run("renderAiStatus(" + JSON.stringify(status("old-run", stopped)) + ")");
  assert.match(ui.run('notes["2"].note'), /已复审/);
  assert.equal(ui.run('notes["2"].revisionText'), "修订正文");
  ui.run("renderAiStatus(" + JSON.stringify(status("new-run", passed)) + ")");
  assert.equal(ui.run('notes["2"].note'), passed);
});

test("recovery marker failure does not report the saved notes as unsaved", () => {
  const storage = storageFixture({ [currentKey]: "{}" });
  const set = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key.startsWith("translation-compare-recovery-v1:")) throw new Error("marker blocked");
    set(key, value);
  };
  const ui = createClientFixture(html(), storage);
  assert.equal(ui.run("notesPersistFailed"), false);
  assert.equal(ui.run("Object.keys(notes).length"), 3);
  assert.match(ui.run("notesRecovery.message"), /已无损压缩保存.*恢复标记未能保存/);
  assert.doesNotMatch(ui.run("notesRecovery.message"), /尚未保存|恢复未完成/);
});
