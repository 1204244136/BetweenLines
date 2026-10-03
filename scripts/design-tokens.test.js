// 共享设计 token 的守护测试：颜色口径一旦回落，两个工作台的说明性文案会一起变得难读，
// 而且不会有任何功能测试报警——所以在这里按可计算结果（对比度）与作用域位置直接锁住。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const publicDir = path.join(__dirname, "..", "public");
const read = (name) => fs.readFileSync(path.join(publicDir, name), "utf8");

// WCAG 2.x 相对亮度与「对白底」的对比度。普通文本达标线是 4.5:1。
function relativeLuminance(hex) {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastWithWhite(hex) {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

test("次要文字色达到 WCAG AA 对比度，且两个工作台保持同一口径", () => {
  const theme = read("workbench-theme.css");
  const translation = read("workbench-style.css").match(/--muted-2:\s*var\(--color-text-subtle\)/i);
  const speaker = read("speaker-workbench-style.css").match(/--speaker-muted-2:\s*var\(--color-text-subtle\)/i);
  const color = theme.match(/--color-text-subtle:\s*(#[0-9a-f]{6})/i);
  assert.ok(translation, "workbench-style.css 必须把 --muted-2 映射到共享文字色");
  assert.ok(speaker, "speaker-workbench-style.css 必须把 --speaker-muted-2 映射到共享文字色");
  assert.ok(color, "workbench-theme.css 必须定义共享的 --color-text-subtle");
  const ratio = contrastWithWhite(color[1]);
  assert.ok(ratio >= 4.5, `--color-text-subtle (${color[1]}) 对白底只有 ${ratio.toFixed(2)}:1，未达 AA 的 4.5:1`);
});

test("共享浮动提示的兜底色与工作台 token 同源", () => {
  const toast = read("toast.css");
  assert.match(
    toast,
    /--toast-muted-2: var\(--muted-2, var\(--speaker-muted-2, var\(--color-text-subtle\)\)\)/,
    "toast 的兜底色必须与 token 同名同值，否则两页会各显示一种灰",
  );
});

test("共享主题承载所有页面色板，组件样式不再各自发明色值", () => {
  const theme = read("workbench-theme.css");
  for (const token of [
    "--color-canvas",
    "--color-info-bg",
    "--color-success-bg",
    "--color-warning-bg",
    "--color-danger-bg",
    "--color-divergence-fg",
    "--color-stage-neutral-fg",
    "--color-stage-stylist-fg",
    "--color-stage-arbiter-fg",
    "--color-stage-summary-fg",
  ]) {
    assert.match(theme, new RegExp(`${token}:`), `共享主题必须定义 ${token}`);
  }
  for (const name of [
    "workbench-style.css",
    "speaker-workbench-style.css",
    "ai-panel.css",
    "toast.css",
    "workbench-dialog.css",
  ]) {
    assert.doesNotMatch(read(name), /#[0-9a-f]{3,8}\b/i, `${name} 不应包含游离色板字面量`);
  }
  const setup = read("setup.html");
  assert.match(setup, /href=["']\/workbench-theme\.css["']/, "控制台必须加载共享主题");
  assert.match(setup, /--muted-2:\s*var\(--color-text-subtle\)/, "控制台必须复用共享次要文字色");
  assert.doesNotMatch(setup, /#[0-9a-f]{3,8}\b/i, "setup.html 不应重复维护色板字面量");
});

test("行内审核组件的 token 别名挂在 :root 而不是面板作用域", () => {
  const aiPanel = read("ai-panel.css");
  // .stage-pipeline-badge 等渲染在表格里，不在 .ai-panel 子树内：别名挂错作用域会让
  // 这些组件的 var(--ai-*) 在使用处全部解析失败，退化成无背景、无边框、hover 无反馈。
  assert.match(aiPanel, /:root \{[\s\S]{0,200}--ai-line:/, "--ai-* 别名必须挂在 :root");
  assert.doesNotMatch(aiPanel, /\.ai-panel \{\s*\n\s*--ai-line:/, "--ai-* 别名不得回落到 .ai-panel 作用域");
});
