const assert = require("node:assert/strict");
const dns = require("node:dns/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-opencode-go-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { clearProofreadCache, clientStatus, listModels, startProofread, testModel } = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const { createProjectStaging, projectArtifacts, publishProject } = require("./project-store");
const { inferSpeakerBatch } = require("../src/workbenches/speaker-attribution/ai/speaker-inference");

const connection = {
  protocol: "compatible",
  provider: "测试提供商名称",
  baseUrl: "https://opencode.ai/inference/go/openai/v1",
  model: "glm-5.3-flash",
  apiKey: "test-go-key",
};
const completionUrl = `${connection.baseUrl}/chat/completions`;
const legacyBaseUrl = "https://opencode.ai/zen/go";
const legacyCompletionUrl = `${legacyBaseUrl}/v1/chat/completions`;
const acceptedDecision = {
  decision: "keep",
  semanticSame: true,
  needsEdit: false,
  needsContext: false,
  summary: "译文准确。",
};

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function mockFetch(t, handler) {
  t.mock.method(dns, "lookup", async () => [{ address: "127.0.0.1", family: 4 }]);
  t.mock.method(globalThis, "fetch", (url, options) => handler(String(url), options));
}

function completion(content) {
  return Response.json({ choices: [{ message: { content } }] });
}

function goSession(options) {
  const headers = new Headers(options.headers);
  assert.match(headers.get("user-agent") || "", /^BetweenLines\/\S+$/);
  assert.equal(headers.get("authorization"), `Bearer ${connection.apiKey}`);
  const session = headers.get("x-opencode-session");
  assert.match(session || "", /^ses_\S+$/);
  return session;
}

test("OpenCode Go 模型可发现，连通性降级重试复用会话且只标识官方 Go 推理地址", async (t) => {
  const sessions = [];
  const otherUrls = [
    "https://opencode.ai/inference/openai/v1",
    "https://opencode.ai/zen/v1",
    "https://opencode.ai.example.test/inference/go/openai/v1",
    "https://opencode.ai.example.test/zen/go/v1",
  ];
  const otherEndpoints = new Set(otherUrls.map((url) => `${url}/chat/completions`));
  mockFetch(t, (url, options) => {
    if (url === "https://models.dev/api.json") return Response.json({});
    if (url === `${connection.baseUrl}/models`) {
      assert.equal(options.method, "GET");
      return Response.json({ data: [{ id: connection.model }] });
    }
    assert.equal(options.method, "POST");
    if (otherEndpoints.has(url)) {
      const headers = new Headers(options.headers);
      assert.equal(headers.get("x-opencode-session"), null);
      assert.doesNotMatch(headers.get("user-agent") || "", /^BetweenLines\//);
      return completion("OK");
    }
    assert.equal(url, completionUrl);
    const body = JSON.parse(options.body);
    assert.equal(body.model, connection.model);
    sessions.push(goSession(options));
    if (sessions.length === 1) {
      return Response.json({ error: { message: "Unsupported parameter: max_tokens" } }, { status: 400 });
    }
    return completion("OK");
  });

  const catalog = await listModels(connection);
  assert.deepEqual(catalog.models.map(({ id }) => id), [connection.model]);
  const first = await testModel(connection);
  assert.equal(first.ok, true, first.message);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0], sessions[1]);
  const second = await testModel({ ...connection, baseUrl: completionUrl });
  assert.equal(second.ok, true, second.message);
  assert.equal(sessions.length, 3);
  assert.notEqual(sessions[1], sessions[2]);

  for (const baseUrl of otherUrls) {
    const result = await testModel({ ...connection, provider: "OpenCode Go", baseUrl });
    assert.equal(result.ok, true, result.message);
  }
});

test("OpenCode Go 旧版预设保留地址并在连通性请求中发送会话头", async (t) => {
  const sessions = [];
  mockFetch(t, (url, options) => {
    assert.equal(url, legacyCompletionUrl);
    assert.equal(options.method, "POST");
    sessions.push(goSession(options));
    return completion("OK");
  });

  for (const baseUrl of [legacyBaseUrl, `${legacyBaseUrl}/v1`, legacyCompletionUrl]) {
    const result = await testModel({ ...connection, baseUrl });
    assert.equal(result.ok, true, result.message);
  }
  assert.equal(sessions.length, 3);
  assert.equal(new Set(sessions).size, sessions.length);
});

function publishRows() {
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: { jp: path.join(dataDir, "source.txt"), cn: path.join(dataDir, "translation.txt") },
    labels: { jp: "原文 A", cn: "译文 B" },
  };
  const rows = [1, 2].map((index) => ({
    index, jp: `部屋に猫が${index}匹いる。`, cn: `房间里有 ${index} 只猫。`, score: 0,
  }));
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project, rowsSignature: project.rowsSignature, rows,
  }));
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "");
  }
  publishProject(staging.dir, { dataDir });
  return { projectKey: project.projectKey, rowsSignature: project.rowsSignature };
}

test("OpenCode Go 旧版预设初审并行行与断流重试复用会话，下次初审分配新会话", async (t) => {
  const project = publishRows();
  const calls = [];
  let inFlight = 0;
  let peakInFlight = 0;
  mockFetch(t, async (url, options) => {
    assert.equal(url, legacyCompletionUrl);
    const body = JSON.parse(options.body);
    assert.equal(body.model, connection.model);
    const { index } = JSON.parse(body.messages[1].content).row;
    calls.push({ index, session: goSession(options) });
    const firstRequest = calls.length === 1;
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await delay(20);
    inFlight -= 1;
    const response = completion(JSON.stringify(acceptedDecision));
    if (firstRequest) response.text = async () => { throw new TypeError("terminated"); };
    return response;
  });

  for (const expectedCalls of [3, 2]) {
    clearProofreadCache();
    const start = calls.length;
    await startProofread({ ...connection, ...project, baseUrl: legacyBaseUrl, targetStage: "stage1", concurrency: 2 });
    const deadline = Date.now() + 5000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) await delay(10);
    const finished = clientStatus();
    assert.equal(finished.running, false);
    assert.equal(finished.errors, 0, finished.logs.join("\n"));
    assert.equal(finished.processed, 2);
    assert.equal(finished.results.filter(({ done }) => done).length, 2);
    const run = calls.slice(start);
    assert.equal(run.length, expectedCalls);
    assert.deepEqual([...new Set(run.map(({ index }) => index))].sort(), [1, 2]);
    assert.equal(new Set(run.map(({ session }) => session)).size, 1);
  }
  assert.equal(peakInFlight, 2);
  assert.notEqual(calls[0].session, calls[3].session);
});

test("OpenCode Go 说话人推断在并行批次内复用会话，下次批次分配新会话", async (t) => {
  const sessions = [];
  let inFlight = 0;
  let peakInFlight = 0;
  mockFetch(t, async (url, options) => {
    assert.equal(url, completionUrl);
    sessions.push(goSession(options));
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await delay(20);
    inFlight -= 1;
    return completion(JSON.stringify({ status: "unknown", evidence: "发话行缺少归属线索。" }));
  });

  for (let batch = 0; batch < 2; batch += 1) {
    const rows = [1, 2].map((index) => ({ index, sourceText: `「発話 ${index}。」` }));
    const result = await inferSpeakerBatch(rows, connection, { concurrency: 2 });
    assert.equal(result.stats.inferred, 2);
    assert.equal(sessions.length, (batch + 1) * 2);
    assert.equal(sessions[batch * 2], sessions[batch * 2 + 1]);
  }
  assert.equal(peakInFlight, 2);
  assert.notEqual(sessions[0], sessions[2]);
});
