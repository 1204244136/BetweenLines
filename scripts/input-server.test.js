const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createServer, host } = require("./input-server");
const { mapCommandProgress, parseProgressMessage } = require("./generation-pipeline");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function apiToken(port) {
  const response = await fetch(`http://${host}:${port}/`);
  const html = await response.text();
  const match = html.match(/<meta\s+name="transcomparator-session-token"\s+content="([^"]+)">/i);
  assert.ok(match, "setup page should contain an injected API session token");
  return match[1];
}

test("机器进度消息被正确解析与区间限制", () => {
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

test("命令进度将局部进度映射至全局流水线区间", () => {
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

test("状态接口暴露项目 API 版本与已完成项目槽位", async () => {
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
    assert.equal(data.apiVersion, 6);
    assert.ok(Array.isArray(data.projects));
    assert.ok(Object.hasOwn(data.pipeline, "completedProject"));
    assert.ok(Object.hasOwn(data, "speaker"));
    assert.equal(data.speaker.outputUrl, data.speaker.outputExists ? "/output/speaker-attribution.html" : "");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("删除不存在的项目直接拒绝且不触碰存储", async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const token = await apiToken(port);
    const response = await fetch(`http://${host}:${port}/api/projects/missing-project-key`, {
      method: "DELETE",
      headers: { "X-TransComparator-Token": token },
    });
    const data = await response.json();
    assert.equal(response.status, 400);
    assert.equal(data.ok, false);
    assert.match(data.error, /项目不存在/);
  } finally {
    await close(server);
  }
});

test("写操作 API 请求要求同源会话 Token 与 JSON 内容类型", async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const endpoint = `http://${host}:${port}/api/ai-proofread/stop`;
    const missingToken = await fetch(endpoint, { method: "POST" });
    assert.equal(missingToken.status, 403);

    const token = await apiToken(port);
    const crossOrigin = await fetch(endpoint, {
      method: "POST",
      headers: {
        "X-TransComparator-Token": token,
        Origin: "https://attacker.example",
      },
    });
    assert.equal(crossOrigin.status, 403);

    const crossSiteFetch = await fetch(endpoint, {
      method: "POST",
      headers: {
        "X-TransComparator-Token": token,
        "Sec-Fetch-Site": "cross-site",
      },
    });
    assert.equal(crossSiteFetch.status, 403);

    const invalidContentType = await fetch(`http://${host}:${port}/api/speaker-selection`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-TransComparator-Token": token,
      },
      body: "{}",
    });
    assert.equal(invalidContentType.status, 415);

    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: { "X-TransComparator-Token": token },
    });
    assert.equal(accepted.status, 200);
  } finally {
    await close(server);
  }
});

test("格式畸形的请求路径返回 400 且不终止服务进程", async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({
        host,
        port,
        method: "GET",
        path: "/%",
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 400);
    const alive = await fetch(`http://${host}:${port}/api/status`);
    assert.equal(alive.status, 200);
  } finally {
    await close(server);
  }
});

test("AI 状态支持紧凑增量轮询", async () => {
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
