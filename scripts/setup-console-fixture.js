// 控制台（public/setup.html）内联脚本的测试夹具：在 vm 里用假 DOM 跑真实脚本。
// 由 setup-import.test.js 与 setup-projects.test.js 共用；两处各写一套假 DOM 迟早会漂移。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "setup.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createConsole() {
  const elements = new Map();
  const documentEvents = {};
  const element = (id) => {
    if (!elements.has(id)) {
      const attributes = {};
      elements.set(id, {
        hidden: true, disabled: false, value: "", textContent: "", innerHTML: "",
        dataset: {}, style: {}, classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {}, replaceChildren() {},
        setAttribute(name, value) { attributes[name] = value; },
        getAttribute(name) { return attributes[name]; },
        focus() { this.focused = true; },
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      getElementById: element, querySelector: element, createElement: () => element(Symbol()),
      addEventListener(name, handler) { documentEvents[name] = handler; },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    // renderLog 会读 window.getSelection 判断用户是否正在拖选日志。
    window: { getSelection: () => null },
    // 无项目时 renderProjects / showServerVersionMismatch 会构造占位 option。
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    fetch: async () => ({ json: async () => ({ ok: false }) }),
    setInterval() {},
  });
  vm.runInContext(script, context);
  const run = (code) => vm.runInContext(code, context);
  return { context, element, documentEvents, run };
}

module.exports = { createConsole, html };
