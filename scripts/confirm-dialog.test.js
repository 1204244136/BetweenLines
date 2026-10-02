const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { renderHtml } = require("../src/workbenches/speaker-attribution/build-workbench");
const { createClientFixture, createWorkbench, storageFixture, toastMessages } = require("./workbench-fixture");

function createConfirmFixture({ existingDialog = true, ...options } = {}) {
  const shared = fs.readFileSync(path.join(__dirname, "../public/workbench-shared.js"), "utf8");
  const dialog = existingDialog ? '<dialog id="genericConfirmDialog"><h3 id="genericConfirmTitle"></h3><p id="genericConfirmMessage"></p><button id="genericConfirmCancel"></button><button id="genericConfirmOk"></button></dialog>' : "";
  return createClientFixture(`<body>${dialog}<div id="toastStack"></div><script id="rowData" type="application/json">[]</script><script>${shared}\nconst { askConfirm } = createConfirmDialog();</script></body>`, storageFixture(), {
    manualConfirm: true,
    strictIds: true,
    confirm() { throw new Error("确认不得回退到原生弹窗"); },
    ...options,
  });
}

function assertDialogListenersCleared(ui) {
  assert.equal(ui.element("genericConfirmOk").listenerCount("click"), 0);
  assert.equal(ui.element("genericConfirmCancel").listenerCount("click"), 0);
  assert.equal(ui.element("genericConfirmDialog").listenerCount("close"), 0);
  assert.equal(ui.element("genericConfirmDialog").listenerCount("cancel"), 0);
}

test("共享页内确认保留纯文本，确认与取消分别落定，并清理监听器", async () => {
  const ui = createConfirmFixture();
  const first = ui.run('askConfirm("正文 <img onerror=alert(1)>\\n第二行", { title: "写回", confirmText: "写回原文件" })');
  await ui.settle();
  assert.equal(ui.element("genericConfirmDialog").open, true);
  assert.equal(ui.element("genericConfirmMessage").textContent, "正文 <img onerror=alert(1)>\n第二行");
  assert.equal(ui.element("genericConfirmMessage").innerHTML, "");
  assert.equal(ui.element("genericConfirmTitle").textContent, "写回");
  assert.equal(ui.element("genericConfirmOk").textContent, "写回原文件");
  await ui.element("genericConfirmCancel").dispatch("click");
  assert.equal(await first, false);
  assertDialogListenersCleared(ui);

  const next = ui.run('askConfirm("再次确认")');
  await ui.settle();
  await ui.element("genericConfirmOk").dispatch("click");
  assert.equal(await next, true);
  assertDialogListenersCleared(ui);
});

test("Esc 与程序关闭均取消确认，下一次弹窗正常工作", async () => {
  const ui = createConfirmFixture();
  for (const action of ["cancel", "close"]) {
    const answer = ui.run('askConfirm("即将改动原文件")');
    await ui.settle();
    if (action === "cancel") {
      let prevented = false;
      await ui.element("genericConfirmDialog").dispatch("cancel", { preventDefault() { prevented = true; } });
      assert.equal(prevented, true, "Esc 取消事件由共享确认处理，明确关闭并落定 Promise");
    } else {
      ui.element("genericConfirmDialog").close();
    }
    assert.equal(await answer, false);
    assertDialogListenersCleared(ui);
  }
  const next = ui.run('askConfirm("关闭后的新确认")');
  await ui.settle();
  await ui.element("genericConfirmOk").dispatch("click");
  assert.equal(await next, true);
});

test("不同确认串行显示，前一次关闭事件不取消后一次", async () => {
  const ui = createConfirmFixture();
  const first = ui.run('askConfirm("第一项", { title: "第一项标题" })');
  const second = ui.run('askConfirm("第二项", { title: "第二项标题" })');
  await ui.settle();
  assert.equal(ui.element("genericConfirmTitle").textContent, "第一项标题");
  assert.equal(ui.element("genericConfirmMessage").textContent, "第一项");
  await ui.element("genericConfirmOk").dispatch("click");
  assert.equal(await first, true);
  await ui.settle();
  assert.equal(ui.element("genericConfirmDialog").open, true);
  assert.equal(ui.element("genericConfirmMessage").textContent, "第二项");
  await ui.element("genericConfirmCancel").dispatch("click");
  assert.equal(await second, false);
  assertDialogListenersCleared(ui);
});

test("没有现成弹窗时创建共享节点，没有 dialog 支持或打开失败时取消并提示", async () => {
  const dynamic = createConfirmFixture({ existingDialog: false });
  const first = dynamic.run('askConfirm("动态弹窗")');
  await dynamic.settle();
  assert.equal(dynamic.element("genericConfirmDialog").open, true);
  assert.equal(dynamic.element("genericConfirmDialog").tagName, "DIALOG");
  assert.equal(dynamic.element("genericConfirmDialog").getAttribute("aria-labelledby"), "genericConfirmTitle");
  assert.equal(dynamic.element("genericConfirmDialog").getAttribute("aria-describedby"), "genericConfirmMessage");
  assert.equal(dynamic.element("genericConfirmCancel").focused, true, "危险确认默认聚焦取消");
  await dynamic.element("genericConfirmCancel").dispatch("click");
  assert.equal(await first, false);

  for (const showModal of [undefined, () => { throw new Error("dialog 无法打开"); }]) {
    const ui = createConfirmFixture();
    ui.element("genericConfirmDialog").showModal = showModal;
    assert.equal(await ui.run('askConfirm("不可放行的写回")'), false);
    assert.ok(toastMessages(ui).length, "无法打开页内确认时需给出可见错误提示");
    assertDialogListenersCleared(ui);
  }
});

const translationResponse = { ok: true, updated: 1, missed: [], ambiguous: [], targets: ["B.txt"] };
const translationWrites = (ui) => ui.posts.filter((post) => post.url === "/api/translation-export");

test("翻译单行写回等待确认，取消/Esc/关闭均不请求、不改变按钮或备注", async () => {
  const ui = createWorkbench(storageFixture(), { manualConfirm: true, strictIds: true, apiResponses: { "/api/translation-export": translationResponse } });
  assert.match(ui.html, /\.workbench-confirm-dialog\s*\{/, "翻译页面内联共享确认样式");
  ui.run('notes["2"] = { revisionText: "译文二改", revisionTarget: "cn" };');
  const button = ui.element("rowWriteback");
  button.textContent = "写回";
  const originalNotes = ui.run("JSON.stringify(notes)");
  for (const action of ["click", "cancel", "close"]) {
    const writeback = ui.run('writebackSingleRevision("2", document.getElementById("rowWriteback"))');
    await ui.settle();
    assert.equal(ui.element("genericConfirmDialog").open, true);
    assert.equal(translationWrites(ui).length, 0);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "写回");
    if (action === "click") await ui.element("genericConfirmCancel").dispatch("click");
    if (action === "cancel") await ui.element("genericConfirmDialog").dispatch("cancel", { preventDefault() {} });
    if (action === "close") ui.element("genericConfirmDialog").close();
    await writeback;
    assert.equal(translationWrites(ui).length, 0);
    assert.equal(ui.run("JSON.stringify(notes)"), originalNotes);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "写回");
  }
  const approved = ui.run('writebackSingleRevision("2", document.getElementById("rowWriteback"))');
  await ui.settle();
  await ui.element("genericConfirmOk").dispatch("click");
  await approved;
  assert.equal(translationWrites(ui).length, 1);
  assert.equal(ui.run('notes["2"].manualDone'), true);
});

test("翻译批量写回只执行一次，确认文案与请求使用同一份备份设置", async () => {
  const ui = createWorkbench(storageFixture(), { manualConfirm: true, apiResponses: { "/api/translation-export": translationResponse } });
  ui.run('notes["1"] = { revisionText: "译文一改", revisionTarget: "cn" }; setWritebackBackupSetting(true);');
  const button = ui.element("exportNotes");
  button.textContent = "批量写回";
  const writeback = button.dispatch("click");
  await ui.settle();
  assert.equal(translationWrites(ui).length, 0);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "批量写回");
  assert.match(ui.element("genericConfirmMessage").textContent, /已开启自动备份/);
  await button.dispatch("click");
  ui.run('writebackSingleRevision("1", document.getElementById("rowWriteback")); setWritebackBackupSetting(false);');
  await ui.settle();
  await ui.element("genericConfirmOk").dispatch("click");
  await writeback;
  await ui.settle();
  assert.equal(translationWrites(ui).length, 1, "确认期间的重复批量/单行点击不能追加写回");
  assert.equal(translationWrites(ui)[0].body.writebackBackup, true);
  assert.equal(ui.element("genericConfirmDialog").open, false);
});

test("翻译写回失败恢复按钮并解锁，后续确认可以重试", async () => {
  const responses = { "/api/translation-export": { ok: false, error: "模拟定位失败" } };
  const ui = createWorkbench(storageFixture(), { manualConfirm: true, apiResponses: responses });
  ui.run('notes["1"] = { revisionText: "译文一改", revisionTarget: "cn" };');
  const button = ui.element("rowWriteback");
  button.textContent = "写回";
  const failed = ui.run('writebackSingleRevision("1", document.getElementById("rowWriteback"))');
  await ui.settle();
  await ui.element("genericConfirmOk").dispatch("click");
  await failed;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "写回");
  assert.equal(ui.run('Boolean(notes["1"].manualDone)'), false);
  assert.match(toastMessages(ui).at(-1), /模拟定位失败/);
  responses["/api/translation-export"] = translationResponse;
  const retry = ui.run('writebackSingleRevision("1", document.getElementById("rowWriteback"))');
  await ui.settle();
  assert.equal(ui.element("genericConfirmDialog").open, true);
  await ui.element("genericConfirmOk").dispatch("click");
  await retry;
  assert.equal(translationWrites(ui).length, 2);
  assert.equal(ui.run('notes["1"].manualDone'), true);
});

test("翻译弹窗和请求等待期间更新的建议不会被误标为已写回", async () => {
  for (const phase of ["confirmation", "response"]) {
    let resolveResponse;
    const response = new Promise((resolve) => { resolveResponse = resolve; });
    const ui = createWorkbench(storageFixture(), {
      manualConfirm: true, apiResponses: { "/api/translation-export": phase === "response" ? response : translationResponse },
    });
    ui.run('notes["1"] = { revisionText: "批准版本", revisionTarget: "cn", manualDone: false };');
    const writeback = ui.run('writebackSingleRevision("1", document.getElementById("rowWriteback"))');
    await ui.settle();
    if (phase === "response") {
      await ui.element("genericConfirmOk").dispatch("click");
      await ui.settle();
      assert.equal(translationWrites(ui).length, 1);
      assert.equal(ui.element("rowWriteback").disabled, true);
    }
    ui.run('notes["1"].revisionText = "较新的未写回建议";');
    if (phase === "confirmation") await ui.element("genericConfirmOk").dispatch("click");
    else resolveResponse(translationResponse);
    await writeback;
    assert.equal(translationWrites(ui)[0].body.entries[0].replaceText, "批准版本");
    assert.equal(ui.run('notes["1"].revisionText'), "较新的未写回建议");
    assert.equal(ui.run('Boolean(notes["1"].manualDone)'), false);
  }
});

function createSpeakerFixture(apiResponses = { "/api/speaker-export": { ok: true, updated: 1, missed: [], ambiguous: [] } }, rowCount = 1) {
  const model = {
    analysisKey: "confirm-test", sourceLineCount: rowCount, parallelLineCount: 0, generatedAt: "2026-01-01T00:00:00.000Z",
    selection: { mode: "monolingual", files: { source: "source.txt" } },
    alignment: { version: "none", unmatchedSource: 0, unmatchedParallel: 0, lowConfidence: 0 },
    rows: Array.from({ length: rowCount }, (_, index) => ({ id: "line-" + (index + 1), index: index + 1, source: { text: "「谁在说话？" + (index + 1) + "」" }, parallel: [], context: [], alignment: { status: "source-only", relation: "1:0", score: 1 }, prediction: { speaker: "甲", confidence: 0.9, evidence: "上下文", status: "confirmed" } })),
  };
  return createClientFixture(renderHtml(model), storageFixture(), {
    manualConfirm: true, strictIds: true,
    apiResponses,
    confirm() { throw new Error("说话人写回不得使用原生弹窗"); },
  });
}

function clickSpeakerRow(ui, button) {
  return ui.element("#speakerTable tbody").dispatch("click", {
    target: { closest(selector) { return selector === 'button[data-action="writeback-row"]' ? button : null; } },
  });
}

test("说话人单行写回取消不改状态，批准只发送一次并固定备份设置", async () => {
  const ui = createSpeakerFixture();
  assert.match(ui.html, /\.workbench-confirm-dialog\s*\{/, "说话人页面内联共享确认样式");
  const button = ui.element("speakerRowWriteback");
  button.dataset.rowId = "line-1";
  button.textContent = "写回原文件";
  const backup = ui.element("speakerWritebackBackup");
  backup.checked = true;
  await backup.dispatch("change");
  const originalStorage = [...ui.storage.data.entries()];
  await clickSpeakerRow(ui, button);
  await ui.settle();
  assert.equal(ui.posts.length, 0);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "写回原文件");
  assert.match(ui.element("genericConfirmMessage").textContent, /已开启自动备份/);
  await ui.element("genericConfirmCancel").dispatch("click");
  await ui.settle();
  assert.equal(ui.posts.length, 0);
  assert.deepEqual([...ui.storage.data.entries()], originalStorage);

  await clickSpeakerRow(ui, button);
  await ui.settle();
  await clickSpeakerRow(ui, button);
  await ui.element("speakerBatchAdopt").dispatch("click");
  backup.checked = false;
  await backup.dispatch("change");
  await ui.element("genericConfirmOk").dispatch("click");
  await ui.settle();
  assert.equal(ui.posts.length, 1);
  assert.equal(ui.posts[0].body.writebackBackup, true);
  assert.equal(ui.posts[0].body.row.speaker, "甲");
  assert.equal(button.textContent, "✓ 已写回");
  assert.equal(ui.element("genericConfirmDialog").open, false);
});

test("说话人批量写回的 Esc/关闭不请求，批准后执行一次", async () => {
  const ui = createSpeakerFixture();
  const button = ui.element("speakerBatchAdopt");
  button.textContent = "批量写回原文件";
  for (const action of ["cancel", "close"]) {
    const writeback = button.dispatch("click");
    await ui.settle();
    assert.equal(ui.posts.length, 0);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "批量写回原文件");
    if (action === "cancel") await ui.element("genericConfirmDialog").dispatch("cancel", { preventDefault() {} });
    if (action === "close") ui.element("genericConfirmDialog").close();
    await writeback;
    await ui.settle();
    assert.equal(ui.posts.length, 0);
    assert.equal(button.disabled, false);
  }
  const approved = button.dispatch("click");
  await ui.settle();
  await ui.element("genericConfirmOk").dispatch("click");
  await approved;
  await ui.settle();
  assert.equal(ui.posts.length, 1);
  assert.equal(ui.posts[0].body.rows[0].speaker, "甲");
});

test("说话人写回失败恢复按钮并解锁，后续确认可以重试", async () => {
  const responses = { "/api/speaker-export": { ok: false, error: "模拟定位失败" } };
  const ui = createSpeakerFixture(responses);
  const button = ui.element("speakerRowWriteback");
  button.dataset.rowId = "line-1";
  button.textContent = "写回原文件";
  await clickSpeakerRow(ui, button);
  await ui.settle();
  await ui.element("genericConfirmOk").dispatch("click");
  await ui.settle();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "写回原文件");
  assert.match(toastMessages(ui).at(-1), /模拟定位失败/);
  responses["/api/speaker-export"] = { ok: true, updated: 1, missed: [], ambiguous: [] };
  await clickSpeakerRow(ui, button);
  await ui.settle();
  assert.equal(ui.element("genericConfirmDialog").open, true);
  await ui.element("genericConfirmOk").dispatch("click");
  await ui.settle();
  assert.equal(ui.posts.length, 2);
  assert.equal(button.textContent, "✓ 已写回");
});

test("说话人弹窗和请求等待期间更新的记录仍保持未写回", async () => {
  for (const phase of ["confirmation", "response"]) {
    let resolveResponse;
    const response = new Promise((resolve) => { resolveResponse = resolve; });
    const ui = createSpeakerFixture({ "/api/speaker-export": phase === "response" ? response : { ok: true, updated: 1, missed: [], ambiguous: [] } });
    const button = ui.element("speakerRowWriteback");
    button.dataset.rowId = "line-1";
    button.textContent = "写回原文件";
    await clickSpeakerRow(ui, button);
    await ui.settle();
    if (phase === "response") {
      await ui.element("genericConfirmOk").dispatch("click");
      await ui.settle();
      assert.equal(ui.posts.length, 1);
    }
    const field = { dataset: { rowId: "line-1", field: "speaker" }, value: "乙" };
    await ui.element("#speakerTable tbody").dispatch("change", { target: { closest() { return field; } } });
    if (phase === "confirmation") await ui.element("genericConfirmOk").dispatch("click");
    else resolveResponse({ ok: true, updated: 1, missed: [], ambiguous: [] });
    await ui.settle();
    assert.equal(ui.posts[0].body.row.speaker, "甲");
    const save = ui.timeouts.find((timer) => !timer.cleared && timer.delay === 180);
    assert.ok(save, "新记录与写回状态应可持久化");
    save.callback();
    const record = JSON.parse(ui.storage.getItem("between-lines:speaker-attribution:confirm-test:v2"))["line-1"];
    assert.equal(record.speaker, "乙");
    assert.equal(Boolean(record.isWritten), false);
    assert.notEqual(record.status, "written");
  }
});

test("说话人批量写回逐行确认：更新过的记录留待写回，其余记录标记成功", async () => {
  const ui = createSpeakerFixture({ "/api/speaker-export": { ok: true, updated: 2, missed: [], ambiguous: [] } }, 2);
  const writeback = ui.element("speakerBatchAdopt").dispatch("click");
  await ui.settle();
  assert.match(ui.element("genericConfirmMessage").textContent, /将 2 行的说话人写回原文件/);
  const field = { dataset: { rowId: "line-1", field: "speaker" }, value: "乙" };
  await ui.element("#speakerTable tbody").dispatch("change", { target: { closest() { return field; } } });
  await ui.element("genericConfirmOk").dispatch("click");
  await writeback;
  assert.deepEqual(ui.posts[0].body.rows.map((row) => row.speaker), ["甲", "甲"]);
  ui.timeouts.find((timer) => !timer.cleared && timer.delay === 180).callback();
  const records = JSON.parse(ui.storage.getItem("between-lines:speaker-attribution:confirm-test:v2"));
  assert.equal(records["line-1"].speaker, "乙");
  assert.equal(Boolean(records["line-1"].isWritten), false);
  assert.equal(records["line-2"].isWritten, true);
  assert.equal(records["line-2"].status, "written");
  assert.match(toastMessages(ui).at(-1), /1 行说话人后来已更新/);
});
