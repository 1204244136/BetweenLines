const { createRequestSecurity } = require("./request-security");
const { createSpeakerRuntime } = require("./speaker-runtime");
const { createArtifactResponder } = require("./artifact-response");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { execFile } = require("child_process");
const { sendError } = require("./http-json");
const { GenerationPipeline } = require("./generation-pipeline");
const { storageLayout } = require("../core/storage-layout");
const { clientStatus: aiProofreadStatus } = require("../workbenches/translation-compare/ai/ai-proofread");
const { createWritebackRoutes } = require("./routes/writeback");
const { createStatusRoutes } = require("./routes/status");
const { createProjectRoutes } = require("./routes/projects");
const { createInputRoutes } = require("./routes/inputs");
const { createGenerationRoutes } = require("./routes/generation");
const { handleAiRoutes } = require("./routes/ai");
const { createNotesRoutes } = require("./routes/notes");
const { createNotesFileStore } = require("../workbenches/translation-compare/notes-file-store");

const rootDir = path.join(__dirname, "..", "..");
const publicDir = path.join(rootDir, "public");
const dataLayout = storageLayout();
const defaultPort = Number(process.env.TRANSCOMPARATOR_SETUP_PORT || 4317);
const host = "127.0.0.1";
const importedInputsDir = dataLayout.importedInputsDir;
const consoleApiVersion = 6;
const generation = new GenerationPipeline();
const speaker = createSpeakerRuntime({ runtimeDir: path.join(dataLayout.runtimeDir, "speaker-attribution") });
const { requestPort, isAllowedRequestSource, requiresApiSessionToken, hasValidApiSessionToken, injectSessionToken } = createRequestSecurity({ host, defaultPort });
const notesStore = createNotesFileStore();
const { serveStatic, serveOutput } = createArtifactResponder({ publicDir, speakerOutputDir: speaker.outputDir,
  injectSessionToken: (html) => notesStore.inject(injectSessionToken(html)) });
function runningTaskLabel() {
  return aiProofreadStatus().kind === "prefilter" ? "预筛选" : "AI 校对";
}

// 路由只返回是否已处理；鉴权和未匹配/异常响应统一由入口负责。
const apiRoutes = [
  createNotesRoutes({ store: notesStore }),
  createWritebackRoutes({ speaker, importedInputsDir }),
  createStatusRoutes({ generation, speaker, consoleApiVersion }),
  createProjectRoutes({ generation, consoleApiVersion, runningTaskLabel }),
  createInputRoutes({ speaker }),
  createGenerationRoutes({ generation, speaker, consoleApiVersion, runningTaskLabel }),
  handleAiRoutes,
];

async function handleApi(req, res, pathname, searchParams) {
  try {
    if (!isAllowedRequestSource(req)) {
      sendError(res, 403, new Error("拒绝跨站或非本机 API 请求。"));
      return;
    }
    if (requiresApiSessionToken(req) && !hasValidApiSessionToken(req)) {
      sendError(res, 403, new Error("API 会话令牌无效，请从本地控制台重新打开页面。"));
      return;
    }
    for (const handle of apiRoutes) {
      if (await handle(req, res, pathname, searchParams)) return;
    }
    sendError(res, 404, new Error(`Unknown local API endpoint: ${pathname}`));
  } catch (error) {
    sendError(res, Number(error.statusCode) || 400, error);
  }
}

function createServer() {
  const server = http.createServer((req, res) => {
    try {
      if (!isAllowedRequestSource(req)) {
        sendError(res, 403, new Error("拒绝跨站或非本机请求。"));
        return;
      }
      const url = new URL(req.url, `http://${host}:${requestPort(req)}`);
      if (url.pathname.startsWith("/api/")) {
        handleApi(req, res, url.pathname, url.searchParams);
        return;
      }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith("/output/")) {
        serveOutput(res, pathname);
        return;
      }
      serveStatic(req, res, pathname);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, 400, error instanceof URIError ? new Error("请求路径无效。") : error);
    }
  });
  server.on("clientError", (error, socket) => {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

const server = createServer();

// 控制台页面只能在端口真正绑定后打开：调用方（start-setup.bat）无法预知 npm 与 node 的启动耗时，
// 用固定等待去猜就会让浏览器先访问到未监听的 127.0.0.1 并停在「拒绝连接」。
function browserLaunchCommand(url) {
  if (process.platform === "win32") return { command: "cmd.exe", args: ["/c", "start", "", url] };
  if (process.platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

function openConsolePage(url) {
  const { command, args } = browserLaunchCommand(url);
  console.log(`Opening the console page: ${url}`);
  execFile(command, args, { windowsHide: true }, (error) => {
    if (error) console.warn(`Could not open the console page automatically: ${error.message}`);
  });
}

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.error(`Port ${defaultPort} is already in use. Stop the other TransComparator setup server, or start this one with TRANSCOMPARATOR_SETUP_PORT=<port>.`);
  } else {
    console.error(`TransComparator setup server failed to start: ${error && error.message}`);
  }
  process.exitCode = 1;
});

function startServer() {
  const openPage = process.env.TRANSCOMPARATOR_OPEN_BROWSER === "1";
  server.listen(defaultPort, host, () => {
    // 用真实绑定到的端口拼地址：TRANSCOMPARATOR_SETUP_PORT=0 时端口由系统分配。
    const url = `http://${host}:${server.address().port}/`;
    console.log(`TransComparator console: ${url}`);
    console.log("Press Ctrl+C to stop.");
    if (openPage) openConsolePage(url);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = {
  createServer,
  defaultPort,
  host,
  startServer,
};
