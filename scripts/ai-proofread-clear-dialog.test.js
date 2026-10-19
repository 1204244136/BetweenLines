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

// 同一组配置分别从阶段按钮和总按钮启动，确认弹窗必须保留用户选择的运行范围。
function setupCascadeDialogWorkbench() {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-dialog-cascade", stageMode: "stage1", stageCascade: { toStylist: true, toArbiter: false }, results: [] } },
    },
  });
  ui.storage.setItem("translation-compare-ai-presets-v2", JSON.stringify([
    { id: "preset_s2", name: "Gemini 复审", protocol: "compatible", baseUrl: "https://example.invalid/v1", model: "gemini-3.8-flash" },
  ]));
  ui.run("restoreAiConfig()");
  ui.run('stagePresetSelections.stage2 = ["preset_s2"];');
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
  return ui;
}

test("独立初审：确认弹窗「继续剩下的」保留阶段范围，配置复审也不自动串联", async () => {
  const ui = setupCascadeDialogWorkbench();
  const plan = ui.run("cascadeFromStage('stage1')");
  assert.equal(plan.toStylist, false);
  assert.equal(plan.toArbiter, false);

  await ui.element("aiStart").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true, "有未确认记录时仍应先弹确认弹窗");
  assert.doesNotMatch(ui.element("aiConfirmMessage").innerHTML, /初审 → 复审/, "单阶段弹窗不得宣称推进下游");

  await ui.element("aiConfirmKeep").dispatch("click");
  const post = ui.posts.find((p) => p.url === "/api/ai-proofread/start");
  assert.ok(post, "发起启动请求");
  assert.equal(post.body.stage, "stage1");
  assert.ok(post.body.stylistConfig, "保存的下游配置可以随请求传送，但只有 all 才有权级联");
  assert.doesNotMatch(toastMessages(ui).join("|"), /本次会一路推进：初审 → 复审/);
});

test("一键开始：确认弹窗「从未人工确认处开始」保留 all 范围并说明已配置阶段", async () => {
  const ui = setupCascadeDialogWorkbench();

  await ui.element("aiStartAll").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true);
  assert.match(ui.element("aiConfirmMessage").innerHTML, /初审 → 复审/);

  await ui.element("aiConfirmClear").dispatch("click");
  const post = ui.posts.find((p) => p.url === "/api/ai-proofread/start");
  assert.ok(post, "发起启动请求");
  assert.equal(post.body.stage, "all", "清空重跑也必须保留一键开始范围");
  assert.ok(post.body.stylistConfig);
});

test("一键开始：阶段二预设取不到时不谎报会走到复审", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-stale-preset", stageMode: "stage1", stageCascade: { toStylist: false, toArbiter: false }, results: [] } },
    },
  });

  // 适用列表里留着一个本地已经不存在的预设 id。
  ui.run('stagePresetSelections.stage2 = ["preset_gone"];');
  const plan = ui.run("cascadeFromStage('all')");
  assert.equal(plan.toStylist, false, "取不到预设就等于那一段没启用");
  assert.equal(plan.toArbiter, false);

  await ui.element("aiStartAll").dispatch("click");
  const post = ui.posts.at(-1);
  assert.equal(post.body.stage, "all");
  assert.equal(post.body.stylistConfig, null, "取不到预设就不会带上阶段二配置，服务端也就不会级联");
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

test("阶段三终审仲裁完全结束后，点击阶段3「开始」弹出确认弹窗，可选择「从未人工确认处开始」重跑仲裁", async () => {
  const ui = createWorkbench(storageFixture({}), {
    apiResponses: {
      "/api/ai-proofread/start": { ok: true, ai: { running: true, runId: "run-stage3-rerun", results: [] } },
    },
  });

  // 配置阶段三预设，并设置两行分歧行：均已完成阶段三仲裁，但未人工确认，且文本中无「提交仲裁/分歧/escalate」字样
  ui.run(`
    stagePresetSelections.stage3 = ["preset-s3"];
    notes["1"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：是\\nGatekeeper初审：建议修改硬伤\\n初审改案：初审案1\\nStylist复审[调整]：深化文学隐喻\\n复审改案：复审案1\\nArbiter仲裁[初审方案]：采纳初审方案\\n仲裁改案：初审案1\\n修改结果：初审案1",
      revisionText: "初审案1",
      manualDone: false,
      done: false,
      aiDone: true,
    };
    notes["2"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：是\\nGatekeeper初审：建议修改硬伤\\n初审改案：初审案2\\nStylist复审[驳回]：原译文意顺畅\\nArbiter仲裁[结合方案]：融合两者长处\\n仲裁改案：结合案2\\n修改结果：结合案2",
      revisionText: "结合案2",
      manualDone: false,
      done: false,
      aiDone: true,
    };
    notes["3"] = {
      note: "[AI校对]\\n语义是否相同：相同\\n是否需要修改：否\\nGatekeeper初审：无需修改\\n分析：正常。",
      manualDone: true,
      done: true,
      aiDone: true,
    };
  `);

  // 点击阶段三「开始」按钮
  await ui.element("stage3Start").dispatch("click");

  // 必须弹出确认弹窗，不能被直接拦截报错
  assert.equal(ui.element("aiConfirmDialog").open, true, "阶段三完全结束后点击开始必须打开确认弹窗");
  assert.match(ui.element("aiConfirmMessage").innerHTML, /2.*条终审仲裁方案/, "提示信息中必须包含已有的2条终审仲裁方案");

  // 1. 测试选择「继续剩下的」：因为全部已仲裁，应当友好提示并关闭弹窗，不发起空请求
  await ui.element("aiConfirmKeep").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, false, "点击继续后弹窗关闭");
  assert.equal(ui.posts.filter((p) => p.url === "/api/ai-proofread/start").length, 0, "全部已完成时不发起启动请求");
  assert.equal(
    toastMessages(ui).some((m) => m.includes("所有分歧行均已完成终审仲裁") && m.includes("从未人工确认处开始")),
    true,
    "必须提示用户若要重跑请选择「从未人工确认处开始」"
  );

  // 2. 再次点击阶段三「开始」，这次选择「从未人工确认处开始」
  await ui.element("stage3Start").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, true);
  await ui.element("aiConfirmClear").dispatch("click");
  assert.equal(ui.element("aiConfirmDialog").open, false);

  // 验证启动请求
  const startPosts = ui.posts.filter((p) => p.url === "/api/ai-proofread/start");
  assert.equal(startPosts.length, 1, "必须发起重跑启动请求");
  const lastPost = startPosts[0];
  assert.equal(lastPost.body.stage, "stage3", "启动请求 stage 必须是 stage3");
  assert.equal(lastPost.body.continueOnly, false, "从未人工确认处开始时 continueOnly 必须是 false");

  // 验证未人工确认行的 Arbiter 仲裁记录已被清空，但保留初审与复审方案
  const note1 = ui.run('notes["1"]?.note');
  assert.equal(note1.includes("Arbiter仲裁"), false, "第1行的仲裁记录已被清空");
  assert.equal(note1.includes("仲裁改案"), false, "第1行的仲裁改案已被清空");
  assert.equal(note1.includes("Stylist复审[调整]"), true, "第1行的文学复审记录必须保留");
  assert.equal(note1.includes("Gatekeeper初审"), true, "第1行的事实初审记录必须保留");

  const note2 = ui.run('notes["2"]?.note');
  assert.equal(note2.includes("Arbiter仲裁"), false, "第2行的仲裁记录已被清空");
  assert.equal(note2.includes("Stylist复审[驳回]"), true, "第2行的复审驳回记录必须保留");

  // 验证已人工确认的第3行完好无损
  assert.equal(ui.run('Boolean(notes["3"]?.manualDone)'), true, "已确认的第3行记录保持不变");

  // 验证 Toast 提示
  assert.equal(toastMessages(ui).some((m) => m.includes("已清空 2 条未人工确认的终审仲裁方案")), true);
});
