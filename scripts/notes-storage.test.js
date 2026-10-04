const assert = require("node:assert/strict");
const test = require("node:test");
const codec = require("lz-string");
const { createNotesStorage } = require("../src/workbenches/translation-compare/notes-storage");
const { createNotesTools } = require("../src/workbenches/translation-compare/notes-spaces");
const { alignLegacyNotes } = require("../src/workbenches/translation-compare/notes-recovery");

const currentKey = "translation-compare-notes-v7:project:rows";
const historicalKey = "translation-compare-notes-v7:project:older-rows";
const packedPrefix = "betweenlines-notes-lz-v1:";
const tools = createNotesTools(alignLegacyNotes);

function limitedStorage(initial = {}, quota = Infinity) {
  const values = new Map(Object.entries(initial));
  const size = () => [...values].reduce((total, [key, value]) => total + 2 * (key.length + value.length), 0);
  return {
    quota,
    get length() { return values.size; },
    get bytes() { return size(); },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(String(key)) ?? null; },
    setItem(key, value) {
      key = String(key);
      value = String(value);
      const previous = values.get(key);
      const replaced = previous === undefined ? 0 : 2 * (key.length + previous.length);
      if (size() - replaced + 2 * (key.length + value.length) > this.quota) {
        const error = new Error("Storage capacity exceeded");
        error.name = "QuotaExceededError";
        throw error;
      }
      values.set(key, value);
    },
    removeItem(key) { values.delete(String(key)); },
  };
}

function notesRaw(count = 100) {
  return JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, index) => [index + 1, {
    note: "[AI review] The original and translation agree. Keep the approved revision. ".repeat(4),
    revisionText: "Approved text with unchanged punctuation.",
    rowSig: "signature-" + (index + 1), manualDone: index % 5 === 0, aiDone: true,
  }])));
}

test("notes compression preserves the exact JSON string and all UTF-16 code units", () => {
  const storage = limitedStorage();
  const notesStorage = createNotesStorage(storage, codec);
  const data = { 1: { note: "\u5907\u6ce8\u539f\u6587\u65e5\u672c\u8a9e \ud83d\ude00 \ud800 \u0000\n\t".repeat(100),
    revisionText: "</script> \\\u2028\u2029", manualDone: true, rowSig: "stable-signature" } };
  const raw = JSON.stringify(data, null, 2);
  notesStorage.setItem(currentKey, raw);
  assert(storage.getItem(currentKey).startsWith(packedPrefix));
  assert.equal(notesStorage.getItem(currentKey), raw);
  assert.equal(createNotesStorage(storage, codec).getItem(currentKey), raw);
  assert.deepEqual(JSON.parse(notesStorage.getItem(currentKey)), data);
});

test("small notes remain ordinary JSON and absent spaces remain null", () => {
  const storage = limitedStorage();
  const notesStorage = createNotesStorage(storage, codec);
  assert.equal(notesStorage.getItem(currentKey), null);
  notesStorage.setItem(currentKey, "{}");
  assert.equal(storage.getItem(currentKey), "{}");
  assert.equal(notesStorage.getItem(currentKey), "{}");
});

test("configuration, speaker notes, and migration markers are not compressed", () => {
  const storage = limitedStorage();
  const notesStorage = createNotesStorage(storage, codec);
  const raw = notesRaw();
  for (const key of ["translation-compare-ai-config-v2", "translation-compare-ai-presets-v2",
    "speaker-attribution-notes-v1:project:rows", currentKey + ":previous-notes-migration-v2",
    currentKey + ":manual-done-prefix-v1"]) {
    notesStorage.setItem(key, raw);
    assert.equal(storage.getItem(key), raw);
    assert.equal(notesStorage.getItem(key), raw);
  }
});

test("a full origin can import and restore notes without rewriting other projects", () => {
  const foreign = Object.fromEntries(["other-a", "other-b", "other-c"].map((project) => [
    `translation-compare-notes-v7:${project}:rows`, notesRaw(60),
  ]));
  const storage = limitedStorage({ ...foreign, [currentKey]: "{}", settings: "settings".repeat(100) });
  const notesStorage = createNotesStorage(storage, codec);
  const raw = notesRaw(300);
  const encoded = notesStorage.encode(raw);
  const importedKey = currentKey + ":import-123";
  storage.quota = storage.bytes + 2 * (importedKey.length + currentKey.length + 2 * encoded.length) + 256;
  assert(raw.length > 2 * encoded.length);
  assert.throws(() => storage.setItem(importedKey, raw), { name: "QuotaExceededError" });
  const result = tools.importBackup(notesStorage, [{ key: currentKey, raw }], currentKey, 123);
  assert.deepEqual(result.imported, [importedKey]);
  assert.equal(result.error, null);
  assert.equal(notesStorage.getItem(importedKey), raw);
  notesStorage.setItem(currentKey, raw);
  assert.equal(notesStorage.getItem(currentKey), raw);
  assert(storage.bytes <= storage.quota);
  for (const [key, value] of Object.entries(foreign)) assert.equal(storage.getItem(key), value);
  assert.equal(storage.getItem("settings"), "settings".repeat(100));
});

test("backup imports compare decoded content and skip an already compressed copy", () => {
  const storage = limitedStorage();
  const notesStorage = createNotesStorage(storage, codec);
  const raw = notesRaw();
  notesStorage.setItem(historicalKey, raw);
  assert.notEqual(storage.getItem(historicalKey), raw);
  const result = tools.importBackup(notesStorage, [{ key: historicalKey, raw }], currentKey, 123);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.imported, []);
  assert.equal(storage.length, 1);
});

test("mixed ordinary JSON and compressed spaces export compatible JSON backups", () => {
  const legacyRaw = JSON.stringify({ 1: { note: "old notes", rowSig: "signature-1" } });
  const compressedRaw = notesRaw(30);
  const storage = limitedStorage({ [historicalKey]: legacyRaw });
  const notesStorage = createNotesStorage(storage, codec);
  const compressedKey = "translation-compare-notes-v7:project:recent-rows";
  notesStorage.setItem(compressedKey, compressedRaw);
  const inventory = tools.inventory(notesStorage, currentKey, {});
  assert.equal(inventory.find((space) => space.key === historicalKey).entries, 1);
  assert.equal(inventory.find((space) => space.key === compressedKey).entries, 30);
  const backup = tools.backup(inventory);
  assert.equal(backup.spaces.find((space) => space.key === historicalKey).raw, legacyRaw);
  assert.equal(backup.spaces.find((space) => space.key === compressedKey).raw, compressedRaw);
  assert.deepEqual(tools.decodeBackup(JSON.parse(JSON.stringify(backup))), backup.spaces);
});

test("corrupt length, checksum, or encoding leaves the original payload exportable", () => {
  const storage = limitedStorage();
  const notesStorage = createNotesStorage(storage, codec);
  const encoded = notesStorage.encode(notesRaw());
  const valid = JSON.parse(encoded.slice(packedPrefix.length));
  const broken = [
    packedPrefix + "{invalid-json",
    packedPrefix + JSON.stringify([valid[0] + 1, valid[1], valid[2]]),
    packedPrefix + JSON.stringify([valid[0], valid[1] + "wrong", valid[2]]),
    packedPrefix + JSON.stringify([valid[0], valid[1], ""]),
    packedPrefix + JSON.stringify([-1, valid[1], valid[2]]),
    packedPrefix + JSON.stringify(["100", valid[1], valid[2]]),
    packedPrefix + JSON.stringify({ length: valid[0], checksum: valid[1], data: valid[2] }),
  ];
  for (const damaged of broken) {
    storage.setItem(historicalKey, damaged);
    assert.equal(notesStorage.getItem(historicalKey), damaged);
    const space = tools.inventory(notesStorage, currentKey, {}).find((item) => item.key === historicalKey);
    assert.equal(space.parseFailed, true);
    assert.equal(tools.backup([space]).spaces[0].raw, damaged);
  }
});

test("unknown compression versions remain untouched instead of becoming empty notes", () => {
  const raw = "betweenlines-notes-lz-v2:" + "opaque-data".repeat(100);
  const storage = limitedStorage({ [currentKey]: raw });
  const notesStorage = createNotesStorage(storage, codec);
  assert.equal(notesStorage.getItem(currentKey), raw);
  assert.equal(tools.parse(notesStorage.getItem(currentKey)), null);
  assert.equal(storage.getItem(currentKey), raw);
});

test("a failed write preserves both the physical data and the decoded read value", () => {
  const storage = limitedStorage();
  const notesStorage = createNotesStorage(storage, codec);
  const original = notesRaw();
  notesStorage.setItem(currentKey, original);
  const stored = storage.getItem(currentKey);
  storage.quota = storage.bytes;
  const changed = JSON.stringify({ 1: { note: Array.from({ length: 10000 }, (_, index) => `unique-${index}`).join("|") } });
  assert.throws(() => notesStorage.setItem(currentKey, changed), { name: "QuotaExceededError" });
  assert.equal(storage.getItem(currentKey), stored);
  assert.equal(notesStorage.getItem(currentKey), original);
});

test("logical compare-before-save survives compaction but detects another page's changes", () => {
  const initial = notesRaw();
  const storage = limitedStorage({ [currentKey]: initial });
  const first = createNotesStorage(storage, codec);
  const second = createNotesStorage(storage, codec);
  const lastPersisted = first.getItem(currentKey);
  second.setItem(currentKey, initial);
  assert.notEqual(storage.getItem(currentKey), initial);
  assert.equal(first.getItem(currentKey), lastPersisted);
  const modified = JSON.stringify({ 1: { note: "Changed in another page", rowSig: "signature-1" } });
  second.setItem(currentKey, modified);
  assert.notEqual(first.getItem(currentKey), lastPersisted);
  assert.equal(first.getItem(currentKey), modified);
});

test("enumeration and removal retain Storage behavior across compressed entries", () => {
  const storage = limitedStorage({ other: "value" });
  const notesStorage = createNotesStorage(storage, codec);
  notesStorage.setItem(currentKey, notesRaw());
  assert.equal(notesStorage.length, 2);
  assert.equal(notesStorage.key(0), "other");
  assert.equal(notesStorage.key(1), currentKey);
  assert.equal(notesStorage.key(2), null);
  notesStorage.removeItem(currentKey);
  assert.equal(notesStorage.getItem(currentKey), null);
  assert.equal(notesStorage.length, 1);
  assert.equal(notesStorage.rawStorage, storage);
});
