const assert = require("node:assert/strict");
const test = require("node:test");

const { createServer, host } = require("./input-server");
const { mapCommandProgress, parseProgressMessage } = require("./generation-pipeline");

test("machine progress messages are parsed and clamped", () => {
  const message = parseProgressMessage(
    '@@transcomparator-progress@@{"percent":125,"label":"编码原文向量","current":256,"total":1000}',
  );
  assert.deepEqual(message, {
    percent: 100,
    label: "编码原文向量",
    current: 256,
    total: 1000,
  });
  assert.equal(parseProgressMessage("ordinary command output"), null);
  assert.equal(parseProgressMessage("@@transcomparator-progress@@not-json"), null);
});

test("command progress maps local work into its global pipeline range", () => {
  assert.deepEqual(
    mapCommandProgress({ percent: 50, label: "编码原文向量", current: 512, total: 1024 }, "align:jp", { start: 2, end: 84 }),
    {
      current: 512,
      total: 1024,
      percent: 43,
      step: "align:jp",
      detail: "编码原文向量",
    },
  );
});

test("status exposes the project API version and completed project slot", async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://${host}:${address.port}/api/status`);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.apiVersion, 5);
    assert.ok(Array.isArray(data.projects));
    assert.ok(Object.hasOwn(data.pipeline, "completedProject"));
    assert.ok(Object.hasOwn(data, "speaker"));
    assert.equal(data.speaker.outputUrl, data.speaker.outputExists ? "/output/speaker-attribution.html" : "");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("deleting an unknown project is rejected without touching storage", async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://${host}:${address.port}/api/projects/missing-project-key`, { method: "DELETE" });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.equal(data.ok, false);
    assert.match(data.error, /项目不存在/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("AI status supports compact incremental polling", async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  try {
    const address = server.address();
    const response = await fetch(`http://${host}:${address.port}/api/ai-proofread/status?compact=1&runId=unknown&afterRevision=12&resultLimit=64`);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.deepEqual(data.ai.logs, []);
    assert.ok(Array.isArray(data.ai.results));
    assert.equal(Number.isInteger(data.ai.resultRevision), true);
    assert.equal(Number.isInteger(data.ai.latestResultRevision), true);
    assert.equal(typeof data.ai.hasMoreResults, "boolean");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
