const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createRequestSecurity } = require("../src/runtime/request-security");
const { readJson } = require("../src/runtime/http-json");
const { createSpeakerRuntime } = require("../src/runtime/speaker-runtime");
const { createInputRoutes } = require("../src/runtime/routes/inputs");

function request(headers = {}, method = "POST") {
  return { method, headers: { host: "localhost:8123", ...headers }, socket: { localPort: 8123 } };
}

test("安全模块按实际监听端口验证来源，并隔离不同实例的令牌", () => {
  const options = { host: "127.0.0.1", defaultPort: 4317 };
  const security = createRequestSecurity(options);
  const other = createRequestSecurity(options);
  const html = security.injectSessionToken('<meta name="transcomparator-session-token" content="">');
  const token = html.match(/content="([^"]+)"/)[1];
  const authorized = request({ "x-transcomparator-token": token });
  assert.equal(security.hasValidApiSessionToken(authorized), true);
  assert.equal(other.hasValidApiSessionToken(authorized), false);
  assert.equal(security.hasValidApiSessionToken(request()), false);
  assert.equal(security.isAllowedRequestSource(request()), true);
  assert.equal(security.isAllowedRequestSource(request({ origin: "http://localhost:8123" })), true);
  assert.equal(security.isAllowedRequestSource(request({ host: "localhost:4317" })), false);
  assert.equal(security.isAllowedRequestSource(request({ origin: "https://example.test" })), false);
  assert.equal(security.isAllowedRequestSource(request({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(security.requiresApiSessionToken(request({}, "GET")), false);
  assert.equal(security.requiresApiSessionToken(request({}, "DELETE")), true);
});

function jsonStream(contentType = "application/json; charset=utf-8") {
  const stream = new PassThrough();
  stream.headers = { "content-type": contentType };
  return stream;
}

test("HTTP JSON 解析保留分块 UTF-8、空请求与格式错误语义", async () => {
  const stream = jsonStream();
  const pending = readJson(stream);
  const bytes = Buffer.from('{"text":"原文"}');
  stream.write(bytes.subarray(0, 11));
  stream.end(bytes.subarray(11));
  assert.deepEqual(await pending, { text: "原文" });
  const empty = jsonStream();
  const emptyResult = readJson(empty);
  empty.end();
  assert.deepEqual(await emptyResult, {});
  const malformed = jsonStream();
  const rejected = assert.rejects(readJson(malformed), /not valid JSON/);
  malformed.end("{");
  await rejected;
  await assert.rejects(readJson(jsonStream("text/plain")), { statusCode: 415 });
});

test("HTTP JSON 超过字节上限时拒绝并销毁请求", async () => {
  const stream = jsonStream();
  const rejected = assert.rejects(readJson(stream, 2), /too large/);
  stream.end("123");
  await rejected;
  assert.equal(stream.destroyed, true);
});

function speakerFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.txt");
  fs.writeFileSync(source, "「测试。」");
  const runtime = createSpeakerRuntime({ runtimeDir: path.join(root, "runtime"), ...options });
  return { root, source, runtime };
}

test("说话人任务可独立生成、阻止重入且不影响另一实例", async (t) => {
  let finish;
  let builds = 0;
  const { runtime, source, root } = speakerFixture(t, {
    build: () => { builds += 1; return new Promise((resolve) => { finish = resolve; }); },
    write: (model, dir) => fs.writeFileSync(path.join(dir, "speaker-attribution.html"), String(model.rows.length)),
  });
  const other = createSpeakerRuntime({ runtimeDir: path.join(root, "other") });
  assert.equal(runtime.readSelection(), null);
  runtime.saveSelection({ files: { jp: source } });
  assert.equal(runtime.readSelection().files.source, source);
  const pending = runtime.run();
  assert.equal(runtime.running, true);
  assert.equal(runtime.run(), undefined);
  assert.equal(other.running, false);
  await Promise.resolve();
  assert.equal(builds, 1);
  finish({ rows: [] });
  await pending;
  assert.equal(runtime.running, false);
  assert.equal(runtime.status().step, "done");
  assert.equal(runtime.status().code, 0);
  assert.equal(runtime.status().progress.percent, 100);
  assert.equal(runtime.status().outputUrl, "/output/speaker-attribution.html");
  assert.ok(runtime.status().finishedAt);
  assert.equal(other.status().step, "idle");
});

test("说话人任务失败后释放运行状态并允许重试", async (t) => {
  let fail = true;
  let writes = 0;
  const { runtime, source } = speakerFixture(t, {
    build: async () => { if (fail) throw new Error("build failed"); return { rows: [] }; },
    write: () => { writes += 1; },
  });
  runtime.saveSelection({ files: { source } });
  await runtime.run();
  assert.equal(runtime.running, false);
  assert.equal(runtime.status().step, "failed");
  assert.equal(runtime.status().error, "build failed");
  assert.equal(writes, 0);
  fail = false;
  await runtime.run();
  assert.equal(runtime.status().step, "done");
  assert.equal(runtime.status().error, "");
  assert.equal(writes, 1);
});

test("路由只处理匹配的方法和路径，未命中不消费请求", async () => {
  let saved;
  const route = createInputRoutes({ speaker: { saveSelection(payload) { saved = payload; return { selection: payload }; } } });
  assert.equal(await route({ method: "GET" }, null, "/api/speaker-selection"), false);
  assert.equal(await route({ method: "POST" }, null, "/api/unknown"), false);
  const req = jsonStream();
  req.method = "POST";
  let response;
  const res = { writeHead(code) { assert.equal(code, 200); }, end(text) { response = JSON.parse(text); } };
  const pending = route(req, res, "/api/speaker-selection");
  req.end('{"files":{"source":"sample.txt"}}');
  assert.equal(await pending, true);
  assert.deepEqual(saved, { files: { source: "sample.txt" } });
  assert.deepEqual(response, { ok: true, selection: saved });
});
