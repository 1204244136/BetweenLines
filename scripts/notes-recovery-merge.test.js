const assert = require("node:assert/strict");
const test = require("node:test");
const { currentKey, siblingKey, storageFixture, createWorkbench, toastMessages } = require("./workbench-fixture");

const prefilterNote = "[规则预筛]\n语义是否相同：相同\n是否需要修改：否\n分析：规则预筛判定通过。";
const aiNote = "[AI校对]\n语义是否相同：不同\n是否需要修改：是\n分析：漏译。\n修改结果：改写后的译文内容。";

test("条目相同的历史空间照旧找回（合并改写不改变原行为）", () => {
  const storage = storageFixture({
    [siblingKey]: JSON.stringify({
      1: { note: prefilterNote, done: true, manualDone: true, aiDone: true, revisionText: "", rowSig: "sig-1" },
      2: { note: aiNote, done: true, manualDone: true, aiDone: true, revisionText: "改写后的译文内容。", rowSig: "sig-2" },
    }),
  });
  const ui = createWorkbench(storage);
  assert.equal(ui.run('notes["1"].manualDone'), true);
  assert.equal(ui.run('notes["2"].manualDone'), true);
  assert.equal(ui.run('notes["2"].revisionText'), "改写后的译文内容。");
  assert.equal(JSON.parse(storage.getItem(currentKey))[1].rowSig, "sig-1");
});

test("同一行在多份历史空间记录不同时逐字段合并，不再把人工确认整条丢掉", () => {
  const storage = storageFixture({
    [siblingKey]: JSON.stringify({
      1: { note: prefilterNote, done: true, manualDone: true, aiDone: true, revisionText: "", rowSig: "sig-1" },
    }),
    "translation-compare-notes-v7:project:rowsOlder": JSON.stringify({
      1: { note: aiNote, done: true, manualDone: true, aiDone: true, revisionText: "改写后的译文内容。", revisionTarget: "cn", rowSig: "sig-1" },
    }),
  });
  const ui = createWorkbench(storage);
  assert.equal(ui.run('Boolean(notes["1"])'), true, "记录不同也必须找回");
  assert.equal(ui.run('notes["1"].manualDone'), true, "人工确认必须保留");
  assert.equal(ui.run('notes["1"].done'), true);
  assert.equal(ui.run('notes["1"].revisionText'), "改写后的译文内容。");
  assert.equal(ui.run('notes["1"].mergedFromSpaces'), true);
  const saved = JSON.parse(storage.getItem(currentKey));
  assert.equal(saved[1].manualDone, true);
  assert.equal(saved[1].rowSig, "sig-1");
  // 找回回执走浮动提示，不再占用 AI 抽屉里那条默认折叠的固定状态行。
  assert.match(toastMessages(ui).join("|"), /合并了多个历史版本的记录/);
  assert.doesNotMatch(ui.element("aiStatus").textContent, /合并了多个历史版本的记录/);
});

test("只在非基准历史空间里出现的确认记录也要找回（候选集取全部历史空间的并集）", () => {
  // 基准空间（verified 更多的那份）里第 1 行的记录与别处不同、因而进不了它的 pairs；
  // 旧的实现只遍历基准空间的 pairs，第 1 行就会被漏掉。
  const storage = storageFixture({
    "translation-compare-notes-v7:project:rowsMost": JSON.stringify({
      2: { note: prefilterNote, done: true, manualDone: true, aiDone: true, revisionText: "", rowSig: "sig-2" },
      3: { note: aiNote, done: true, manualDone: true, aiDone: true, revisionText: "改写后的译文内容。", rowSig: "sig-3" },
    }),
    "translation-compare-notes-v7:project:rowsOnlyOne": JSON.stringify({
      1: { note: prefilterNote, done: true, manualDone: true, aiDone: true, revisionText: "", rowSig: "sig-1" },
    }),
  });
  const ui = createWorkbench(storage);
  for (const index of [1, 2, 3]) {
    assert.equal(ui.run(`notes["${index}"].manualDone`), true, `第 ${index} 行的人工确认必须找回`);
  }
  assert.match(toastMessages(ui).join("|"), /已按行内容找回 3 条记录/);
  assert.equal(ui.run("toasts[toasts.length - 1].tone"), "success");
});

test("没有任何一条能按内容对上时如实告知，并指向按行号核验", () => {
  const storage = storageFixture({
    [siblingKey]: JSON.stringify({ 1: { note: prefilterNote, done: true, manualDone: true, rowSig: "已被重新对齐改掉的签名" } }),
  });
  const ui = createWorkbench(storage);
  assert.equal(ui.run("Object.keys(notes).length"), 0);
  assert.equal(ui.storage.getItem(currentKey), null);
  const notices = toastMessages(ui).join("|");
  assert.match(notices, /没有任何一条能按行内容对上/);
  assert.match(notices, /按行号找回/);
  assert.equal(ui.run("toasts[toasts.length - 1].tone"), "watch", "一条都没对上时要提醒，而不是报成功");
});

test("另一对输入文件的历史备注不参与自动找回，只保留为手动预览项", () => {
  const unrelated = "translation-compare-notes-v7:another-project:otherRows";
  const ui = createWorkbench(storageFixture({
    [unrelated]: JSON.stringify({ 1: { note: "另一项目的记录", done: true, manualDone: true, rowSig: "sig-1" } }),
  }));
  assert.equal(ui.run("Object.keys(notes).length"), 0);
  assert.equal(ui.storage.getItem(currentKey), null);
  assert.equal(ui.run("toasts.some((toast) => /找回|历史备注/.test(toast.message))"), false);
  assert.equal(ui.run("notesSpaceInventory.filter((space) => !space.current).length"), 1, "无关空间仍允许用户手动预览");
});

test("预览找回时本页已有记录的行也按签名合并，不丢历史空间里的人工确认", () => {
  const storage = storageFixture({
    [currentKey]: JSON.stringify({
      1: { note: aiNote, done: false, manualDone: false, aiDone: true, revisionText: "改写后的译文内容。", revisionTarget: "cn", rowSig: "sig-1" },
    }),
    [siblingKey]: JSON.stringify({
      1: { note: prefilterNote, done: true, manualDone: true, aiDone: true, revisionText: "", rowSig: "sig-1" },
      2: { note: prefilterNote, done: true, manualDone: true, aiDone: true, revisionText: "", rowSig: "sig-2" },
    }),
  });
  const ui = createWorkbench(storage);
  assert.equal(ui.run('notes["1"].manualDone'), false, "没有找回动作之前本页记录不该被改动");
  const space = ui.run(`collectNotesSpaces().find((item) => item.key === ${JSON.stringify(siblingKey)}).raw`);
  ui.run(`previewNotesRecovery(collectNotesSpaces().find((item) => item.key === ${JSON.stringify(siblingKey)}))`);
  assert.equal(ui.run('notes["1"].manualDone'), true, "历史空间的人工确认必须合并进本页记录");
  assert.equal(ui.run('notes["1"].mergedFromSpaces'), true);
  assert.equal(ui.run("pendingNotesRecovery.plan.merged"), 1);
  assert.equal(ui.run("pendingNotesRecovery.plan.pairs.map((pair) => pair.to).join(',')"), "2");
  assert.equal(ui.element("applyNotesRecovery").textContent, "找回 1 条");
  assert.equal(ui.run(`localStorage.getItem(${JSON.stringify(siblingKey)})`), space, "来源空间始终保留");
});

// 「重新生成工作台后人工确认少一截」的真实形态：旧版规则把「内容重复的短行」整条丢掉、
// 把「写回后内容变过的行」清成需核验。下面三条夹具就是按这两种损伤搭的。
function healedRowSet() {
  return Array.from({ length: 14 }, (_, offset) => {
    const index = offset + 1;
    const rewritten = index === 3 || index === 5 || index === 7;
    return {
      index, jp: `原文${index}`, relation: "1:1", score: 0.9,
      cn: rewritten ? `第${index}段写回后的正文内容占位文本` : `第${index}段正文内容占位文本足够长`,
      signature: index >= 13 ? "dup" : rewritten ? `sig-${index}-new` : `sig-${index}`,
    };
  });
}

function healedHistorySpace() {
  const space = {};
  for (let index = 1; index <= 14; index += 1) {
    const rewritten = index === 3 || index === 5 || index === 7;
    space[index] = {
      note: rewritten ? aiNote : prefilterNote, done: true, manualDone: true, aiDone: true,
      revisionText: rewritten ? `第${index}段写回后的正文内容占位文本` : "",
      rowSig: index >= 13 ? "dup" : rewritten ? `sig-${index}-old` : `sig-${index}`,
    };
  }
  return space;
}

function damagedCurrentSpace() {
  const space = {};
  for (let index = 1; index <= 12; index += 1) {
    const rewritten = index === 3 || index === 5 || index === 7;
    space[index] = rewritten
      ? { note: aiNote, recoveredUnverified: true }
      : { note: prefilterNote, done: true, manualDone: true, aiDone: true, rowSig: `sig-${index}` };
  }
  return space;
}

test("载入自愈：补回旧版规则漏掉的记录、还回能证明的人工确认", () => {
  const storage = storageFixture({
    [currentKey]: JSON.stringify(damagedCurrentSpace()),
    [siblingKey]: JSON.stringify(healedHistorySpace()),
  });
  const ui = createWorkbench(storage, { rows: healedRowSet() });
  for (const index of [3, 5, 7]) {
    assert.equal(ui.run(`notes["${index}"].manualDone`), true, `第 ${index} 行现在的正文就是写回的成品，人工确认必须还回来`);
    assert.equal(ui.run(`notes["${index}"].recoveredUnverified`), undefined, "还回确认的行不再需要逐行核验");
  }
  for (const index of [13, 14]) {
    assert.equal(ui.run(`notes["${index}"].manualDone`), true, `第 ${index} 行的记录必须补回`);
  }
  assert.match(toastMessages(ui).join("|"), /已修复旧版找回规则漏掉的记录/);
  const saved = JSON.parse(storage.getItem(currentKey));
  assert.equal(saved[3].recoveredUnverified, undefined);
  assert.equal(saved[3].manualDone, true);
  assert.equal(saved[13].manualDone, true, "自愈结果要落盘，下次打开工作台才不会又少一截");
});

test("载入自愈只碰挨过旧版损伤的空间：本页没有未校验记录时原样不动", () => {
  const healthy = damagedCurrentSpace();
  for (const index of [3, 5, 7]) {
    healthy[index] = { note: aiNote, done: false, manualDone: false, aiDone: true, rowSig: `sig-${index}-new` };
  }
  const storage = storageFixture({
    [currentKey]: JSON.stringify(healthy),
    [siblingKey]: JSON.stringify(healedHistorySpace()),
  });
  const ui = createWorkbench(storage, { rows: healedRowSet() });
  assert.equal(ui.run('notes["13"]'), undefined, "没有损伤证据时不做任何自动搬运");
  assert.equal(ui.run('notes["3"].manualDone'), false, "没有损伤证据时也不替用户确认");
  assert.equal(ui.run("toasts.some((toast) => /已修复/.test(toast.message))"), false);
});

test("手动预览别的项目的空间时，内容对得上的行同样恢复人工确认", () => {
  const otherProject = "translation-compare-notes-v7:another-project:otherRows";
  const space = {};
  for (const index of [3, 5, 7]) {
    space[index] = {
      note: aiNote, done: true, manualDone: true, aiDone: true,
      revisionText: `第${index}段写回后的正文内容占位文本`, rowSig: `sig-${index}-old`,
    };
  }
  const ui = createWorkbench(storageFixture({
    [currentKey]: JSON.stringify(damagedCurrentSpace()),
    [otherProject]: JSON.stringify(space),
  }), { rows: healedRowSet() });
  assert.equal(ui.run('notes["3"].manualDone'), false, "自动层只管同一输入项目，别的项目要用户自己预览");
  ui.run(`previewNotesRecovery(collectNotesSpaces().find((item) => item.key === ${JSON.stringify(otherProject)}))`);
  assert.equal(ui.run('notes["3"].manualDone'), true);
  assert.equal(ui.run("pendingNotesRecovery.plan.approvedRestored"), 3);
  assert.match(ui.element("notesRecoveryPreview").innerHTML, /恢复确认/);
});
