const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// 真实回归：双击 start-setup.bat 后浏览器先停在「127.0.0.1 拒绝了连接」，一秒后才恢复正常。
// 原因是脚本用 `timeout /t 2` 猜启动耗时，并且在 `npm run setup` **之前**就打开页面；
// 页面必须在服务端真正监听之后才打开，也就是由服务端在 server.listen 回调里自己开。
//
// 这里在 require 之前替换 execFile：input-server 在模块顶层就取用了它，
// 因此测试既能记录「打开页面」发生的时刻（以及当时端口有没有绑定），又不会真的拉起浏览器。
const launches = [];
let launchFailure = null;
let boundServer = null;
childProcess.execFile = (command, args, options, callback) => {
  const address = boundServer && boundServer.listening ? boundServer.address() : null;
  launches.push({ command, args, options, boundPort: address ? address.port : null });
  if (typeof callback === "function") callback(launchFailure);
  return { on() {} };
};

// 与其它 e2e 一样：数据目录与端口必须在 require 之前设好（模块级会读它们）。
// 端口用 0 让系统分配，避免和其它测试或用户正在运行的实例抢 4317。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-setup-open-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
const previousPort = process.env.TRANSCOMPARATOR_SETUP_PORT;
const previousOpen = process.env.TRANSCOMPARATOR_OPEN_BROWSER;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;
process.env.TRANSCOMPARATOR_SETUP_PORT = "0";

const { host, startServer } = require("./input-server");
launches.length = 0;

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  if (previousPort === undefined) delete process.env.TRANSCOMPARATOR_SETUP_PORT;
  else process.env.TRANSCOMPARATOR_SETUP_PORT = previousPort;
  if (previousOpen === undefined) delete process.env.TRANSCOMPARATOR_OPEN_BROWSER;
  else process.env.TRANSCOMPARATOR_OPEN_BROWSER = previousOpen;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("等待条件超时");
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => server.once("listening", resolve));
}

// 每个用例都用同一个单例 server，需要自己重置调用记录并等端口真正绑定。
async function startListening() {
  launches.length = 0;
  const server = startServer();
  boundServer = server;
  await waitForListening(server);
  return server;
}

// 断言期间不往测试输出里写服务端日志，需要时从 captures 里读。
function captureConsole() {
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const captures = { log: [], warn: [], error: [] };
  for (const level of Object.keys(captures)) {
    console[level] = (message) => captures[level].push(String(message));
  }
  return {
    captures,
    restore() {
      Object.assign(console, originals);
    },
  };
}

test("控制台页面在端口绑定之后才打开", async () => {
  process.env.TRANSCOMPARATOR_OPEN_BROWSER = "1";
  const output = captureConsole();
  const server = await startListening();
  try {
    const url = `http://${host}:${server.address().port}/`;
    await waitFor(() => launches.length > 0);
    assert.equal(launches[0].boundPort, server.address().port, "打开页面时端口必须已经绑定");
    assert.equal(launches[0].args.at(-1), url, "打开的必须是服务端实际监听的地址");
    assert.equal(launches.length, 1, "一轮启动只应打开一次页面");
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.ok(output.captures.log.some((line) => line.includes(url)), "服务端应打印控制台地址");
  } finally {
    output.restore();
    await closeServer(server);
  }
});

test("只有调用方显式要求时才打开页面", async () => {
  delete process.env.TRANSCOMPARATOR_OPEN_BROWSER;
  const output = captureConsole();
  const server = await startListening();
  try {
    const response = await fetch(`http://${host}:${server.address().port}/`);
    assert.equal(response.status, 200);
    await delay(120);
    assert.equal(launches.length, 0, "npm run setup 自己不应该打开页面");
  } finally {
    output.restore();
    await closeServer(server);
  }
});

test("打开页面失败不影响服务端继续提供服务", async () => {
  process.env.TRANSCOMPARATOR_OPEN_BROWSER = "1";
  launchFailure = new Error("no browser available");
  const output = captureConsole();
  const server = await startListening();
  try {
    await waitFor(() => launches.length > 0);
    const response = await fetch(`http://${host}:${server.address().port}/`);
    assert.equal(response.status, 200);
    await waitFor(() => output.captures.warn.length > 0);
    assert.match(output.captures.warn[0], /no browser available/);
  } finally {
    launchFailure = null;
    output.restore();
    await closeServer(server);
  }
});
