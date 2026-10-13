const assert = require("node:assert/strict");
const test = require("node:test");
const { createWorkbench, storageFixture, currentKey, toastMessages } = require("./workbench-fixture");

const passed = "[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改";
const revised = "[AI校对]\n是否需要修改：是\nGatekeeper初审：建议修改\n修改结果：修订正文";
const result = (index, resultRevision = index, overrides = {}) => ({
  runId: "run-a", index, signature: `sig-${index}`, resultRevision,
  status: "done", note: passed, done: true, targetKey: "cn", ...overrides,
});
const status = (results = [], overrides = {}) => ({
  kind: "proofread", runId: "run-a", projectKey: "project", rowsSignature: "rows",
  running: false, total: 3, queued: 3, stageMode: "stage1", active: [],
  results, resultRevision: results.at(-1)?.resultRevision || 0, ...overrides,
});

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function controlledClient(storage = storageFixture(), options = {}) {
  const requests = [];
  const ui = createWorkbench(storage, {
    ...options,
    statusResponse(url) {
      const response = deferred();
      requests.push({ url, ...response });
      return response.promise;
    },
  });
  return {
    ui, requests,
    async reply(index, ai) {
      requests[index].resolve({ ok: true, ai });
      await ui.settle();
    },
  };
}

const paramsFor = (request) => new URL(request.url, "http://localhost").searchParams;

test("生成页面：在途轮询互斥，分页追赶携带已应用游标并读取当前档案", async () => {
  const client = controlledClient();
  const { ui, requests } = client;
  await ui.refresh();
  assert.equal(requests.length, 1, "页面初次轮询未返回，不重复发请求");
  const first = paramsFor(requests[0]);
  assert.equal(first.get("compact"), "1");
  assert.equal(first.get("resultLimit"), "64");
  assert.equal(first.get("projectKey"), "project");
  assert.equal(first.get("rowsSignature"), "rows");
  assert.equal(first.has("afterRevision"), false);
  await client.reply(0, status([result(1)], { hasMoreResults: true }));
  assert.equal(ui.run('notes["1"].note'), passed);
  const catchup = ui.timeouts.find((timer) => !timer.cleared && timer.delay === 16);
  assert.ok(catchup, "分页未收齐时安排 16ms 追赶");
  ui.element("aiProfile").value = "changed-profile";
  catchup.callback();
  assert.equal(requests.length, 2);
  const next = paramsFor(requests[1]);
  assert.equal(next.get("runId"), "run-a");
  assert.equal(next.get("afterRevision"), "1");
  assert.equal(next.get("profileId"), "changed-profile");
  await ui.refresh();
  assert.equal(requests.length, 2, "追赶请求也使用同一互斥规则");
  await client.reply(1, status([
    result(1), result(1, 2, { note: revised, status: "suggestion", done: false }), result(2, 3),
  ], { resultRevision: 3 }));
  assert.equal(ui.run('notes["1"].note'), revised, "同一行的新版本仍正常应用");
  assert.equal(ui.run('notes["2"].note'), passed);
  await ui.refresh();
  assert.equal(paramsFor(requests[2]).get("afterRevision"), "3");
  await client.reply(2, status([], { resultRevision: 3 }));
});

for (const running of [false, true]) {
  test(`生成页面：清运行时轮询未返回，迟到${running ? "运行中" : "静止"}回包保持原拦截口径`, async () => {
    const client = controlledClient(storageFixture(), {
      apiResponses: { "/api/ai-proofread/cache/clear": { ok: true, ai: { runId: "run-a" } } },
    });
    const { ui } = client;
    await client.reply(0, status([result(1)]));
    await ui.refresh();
    await ui.element("clearAiLog").dispatch("click");
    assert.equal(ui.run('notes["1"].note'), passed, "清运行保留已有备注");
    await client.reply(1, status([result(2, 2)], { running, resultRevision: 2 }));
    assert.equal(ui.run('notes["2"]?.note || ""'), running ? passed : "");
    await ui.refresh();
    assert.equal(paramsFor(client.requests[2]).get("afterRevision"), running ? "2" : "0");
    await client.reply(2, status([], { resultRevision: 2 }));
  });
}

test("生成页面：结果清除失败拦截旧回包，启动只确认当时携带的遗忘行", async () => {
  const startup = deferred();
  const client = controlledClient(storageFixture(), {
    apiResponses: {
      "/api/ai-proofread/results/clear": { ok: false, error: "暂时无法清除" },
      "/api/ai-proofread/start": () => startup.promise,
    },
  });
  const { ui } = client;
  await client.reply(0, status([result(1)]));
  await ui.run("forgetPersistedAiResults([1])");
  await ui.refresh();
  await client.reply(1, status([result(1, 2, { note: revised }), result(2, 3)]));
  assert.equal(ui.run('notes["1"].note'), passed);
  assert.equal(ui.run('notes["2"].note'), passed);
  const start = ui.run('startAiProofread({ stage: "stage1", continueOnly: true })');
  const post = ui.posts.find((item) => item.url === "/api/ai-proofread/start");
  assert.deepEqual(post.body.forgetResultIndexes, [1]);
  await ui.run("forgetPersistedAiResults([3])");
  startup.resolve({ ok: true, ai: status([], { runId: "run-b", running: true }) });
  await start;
  await ui.settle();
  await client.reply(2, status([
    result(1, 1, { runId: "run-b", note: revised }), result(3, 2, { runId: "run-b" }),
  ], { runId: "run-b", running: true, resultRevision: 2 }));
  assert.equal(ui.run('notes["1"].note'), revised, "启动已确认的遗忘行可接收新结果");
  assert.equal(ui.run('notes["3"]?.note || ""'), "", "启动等待期间新清除的行继续隔离");
});

test("生成页面：保存失败保留内存备注并推进游标，人工备注与确认保持原合并规则", async () => {
  const storage = storageFixture({ [currentKey]: JSON.stringify({
    2: { note: "人工备注", manualDone: true, done: true, rowSig: "sig-2" },
  }) });
  const client = controlledClient(storage);
  const { ui } = client;
  storage.failWrites = true;
  await client.reply(0, status([result(1), result(2, 2, { note: revised, done: false })], { resultRevision: 2 }));
  assert.equal(ui.run('notes["1"].note'), passed);
  assert.equal(ui.run('notes["2"].note'), "人工备注\n\n" + revised);
  assert.equal(ui.run('notes["2"].manualDone'), true);
  const save = ui.timeouts.find((timer) => !timer.cleared && timer.delay === 250);
  assert.ok(save, "备注仍按现有节奏延迟保存");
  save.callback();
  assert.equal(ui.element("notesSaveWarning").hidden, false);
  await ui.refresh();
  assert.equal(paramsFor(client.requests[1]).get("afterRevision"), "2");
  await client.reply(1, status([], { resultRevision: 2 }));
  storage.failWrites = false;
  await ui.element("retryNotesSave").dispatch("click");
  assert.equal(ui.run('JSON.parse(notesStorage.getItem(storageKey))["1"].note'), passed);
  assert.equal(ui.element("notesSaveWarning").hidden, true);
});

test("生成页面：重复错误签名只提示一次，错项目回包仍按原规则观察运行与游标", async () => {
  const client = controlledClient();
  const { ui } = client;
  const invalid = result(1, 1, { signature: "old-sig" });
  await client.reply(0, status([invalid]));
  assert.equal(ui.run('notes["1"]?.note || ""'), "");
  await ui.refresh();
  await client.reply(1, status([invalid]));
  assert.equal(toastMessages(ui).filter((text) => /行内容不匹配/.test(text)).length, 1);
  await ui.refresh();
  await client.reply(2, status([result(2, 7)], { runId: "foreign-run", projectKey: "other", resultRevision: 7 }));
  assert.equal(ui.run('notes["2"]?.note || ""'), "");
  await ui.refresh();
  const query = paramsFor(client.requests[3]);
  assert.equal(query.get("runId"), "foreign-run");
  assert.equal(query.get("afterRevision"), "7");
  await client.reply(3, status([], { runId: "foreign-run", projectKey: "other", resultRevision: 7 }));
});
