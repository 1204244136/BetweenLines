function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, error) {
  sendJson(res, status, { ok: false, error: error.message || String(error) });
}

function readJson(req, maxBytes = 128 * 1024 * 1024) {
  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("API 请求必须使用 application/json。");
    error.statusCode = 415;
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

module.exports = { sendJson, sendError, readJson };
