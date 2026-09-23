const assert = require("node:assert/strict");
const test = require("node:test");
const { ROWS, storageFixture, createWorkbench, toastMessages } = require("./workbench-fixture");

test("存在未人工确认的 AI 校对信息时，点击开始校对弹出确认弹窗", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-new", results: [] } },
    },
  });

  // 设置数据：第 1 行是普通未确认 AI 校对，第 2 行是 AI 失败记录，第 3 行已人工确认
  ui.run(`
    notes["1"] = {
      note: "[AI校对]\\n语义是否相同：不同\\n是否需要修改：是\\n分析：漏译。\\n修改结果：修订一",
      revisionText: "修订一",
      revisionTarget: "cn",
      manualDone: false,
      done: false,
      aiDone: true,
    };
    notes["2"] = {
      note: "[AI校对]\\n调用失败：401 Unauthorized",
      manualDone: false,
      done: false,
      aiDone: false,
    };
    notes["3"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：否\\n分析：正常。",
      manualDone: true,
      done: true,
      aiDone: true,
    };
  `);

  assert.equal(ui.run("countUnconfirmedAiProofreadNotes()"), 2, "第 1、2 行算未确认 AI 校对，第 3 行已人工确认不计入");

  // 点击 AI 校对「开始」按钮
  await ui.element("aiStart").dispatch("click");

  // 应该弹出确认弹窗
  assert.equal(ui.element("aiConfirmDialog").open, true, "存在未确认 AI 结果时必须打开确认弹窗");
  assert.match(ui.element("aiConfirmMessage").innerHTML, /2.*条未人工确认/, "提示信息中必须包含未确认的条数");
  assert.equal(ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length, 0, "弹窗打开时尚未发起启动请求");

  // 测试取消：点击取消按钮
  await ui.element("aiConfirmCancel").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, false, "点击取消后弹窗应关闭");
  assert.equal(ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length, 0, "取消后不发起启动请求");
  assert.equal(ui.run('Boolean(notes["1"] && notes["2"])'), true, "取消后未确认记录完好保留");
});

test("弹窗中选择「继续剩下的（未AI校对过的）」，保留原有 AI 记录并跳过已有结果启动校对", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-new", results: [] } },
    },
  });

  ui.run(`
    notes["1"] = {
      note: "[AI校对]\\n语义是否相同：不同\\n是否需要修改：是\\n分析：漏译。\\n修改结果：修订一",
      revisionText: "修订一",
      revisionTarget: "cn",
      manualDone: false,
      done: false,
      aiDone: true,
    };
  `);

  await ui.element("aiStart").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true);

  // 点击「继续剩下的（未AI校对过的）」
  await ui.element("aiConfirmKeep").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, false, "弹窗关闭");
  assert.equal(ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length, 1, "发起启动请求");
  const post = ui.posts.find((p) => p.url === "/api/ai-proofread/start");
  assert.equal(post.body.completedIndexes.includes(1), true, "已有 AI 记录的第 1 行被加入 completedIndexes 跳过");
  assert.equal(ui.run('notes["1"]?.revisionText'), "修订一", "原有修改建议保持不变");
});

test("弹窗中选择「从未人工确认处开始」，清空未确认的 AI 记录，保留已确认记录并启动校对", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-new", results: [] } },
    },
  });

  ui.run(`
    notes["1"] = {
      note: "[AI校对]\\n语义是否相同：不同\\n是否需要修改：是\\n分析：漏译。\\n修改结果：修订一",
      revisionText: "修订一",
      revisionTarget: "cn",
      manualDone: false,
      done: false,
      aiDone: true,
    };
    notes["2"] = {
      note: "[AI校对]\\n调用失败：请求超时",
      manualDone: false,
      done: false,
      aiDone: false,
    };
    notes["3"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：否\\n分析：正常。",
      manualDone: true,
      done: true,
      aiDone: true,
    };
  `);

  await ui.element("aiStart").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true);

  // 点击「清空并开始」
  await ui.element("aiConfirmClear").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, false, "弹窗关闭");
  assert.equal(ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length, 1, "发起启动请求");

  // 断言未确认记录已被清空，已确认记录被保留
  assert.equal(ui.run('Boolean(notes["1"])'), false, "未确认的第 1 行 AI 记录已被清除并修剪");
  assert.equal(ui.run('Boolean(notes["2"])'), false, "未确认的第 2 行 AI 失败记录已被清除并修剪");
  assert.equal(ui.run('Boolean(notes["3"]?.manualDone)'), true, "已人工确认的第 3 行记录完好保留");
  assert.equal(ui.run('notes["3"]?.note.startsWith("[AI校对]")'), true, "已人工确认的备注内容保留");

  // 检查 Toast 提示
  assert.deepEqual(toastMessages(ui), ["已清空 2 条未人工确认的 AI 校对信息。"]);
});

test("没有未人工确认的 AI 校对信息时，点击开始校对不弹窗直接启动", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-new", results: [] } },
    },
  });

  // 只有预筛选记录和纯手写备注，没有 [AI校对]
  ui.run(`
    notes["1"] = {
      note: "[规则预筛]\\n语义是否相同：相同\\n是否需要修改：否\\n分析：预筛通过。",
      manualDone: false,
      done: false,
    };
    notes["2"] = {
      note: "用户自己写的备注",
      manualDone: false,
      done: false,
    };
  `);

  assert.equal(ui.run("countUnconfirmedAiProofreadNotes()"), 0, "预筛选和人工手写备注不算 AI 校对信息");

  await ui.element("aiStart").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, false, "没有未确认 AI 记录时不打扰用户，不弹窗");
  assert.equal(ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length, 1, "直接发起启动请求");
  assert.equal(ui.run('notes["1"]?.note.startsWith("[规则预筛]")'), true, "规则预筛未受影响");
  assert.equal(ui.run('notes["2"]?.note'), "用户自己写的备注", "人工手写备注未受影响");
});

test("复合备注（手写备注 + AI校对）清空时剥离 AI 部分，保留手写备注", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-new", results: [] } },
    },
  });

  ui.run(`
    notes["1"] = {
      note: "重点核验此行\\n\\n[AI校对]\\n语义是否相同：不同\\n是否需要修改：是\\n分析：有漏词。\\n修改结果：改后的译文",
      revisionText: "改后的译文",
      revisionTarget: "cn",
      manualDone: false,
      done: false,
      aiDone: true,
    };
  `);

  assert.equal(ui.run("countUnconfirmedAiProofreadNotes()"), 1);

  await ui.element("aiStart").dispatch("click");
  await ui.element("aiConfirmClear").dispatch("click");

  assert.equal(ui.run('notes["1"]?.note'), "重点核验此行", "清空后保留手写部分");
  assert.equal(ui.run('notes["1"]?.revisionText'), "", "AI 生成的修改结果已被清除");
  assert.equal(ui.run('notes["1"]?.aiDone'), false, "aiDone 重置为 false");
  assert.deepEqual(toastMessages(ui), ["已清空 1 条未人工确认的 AI 校对信息。"]);
});
