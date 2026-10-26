# 翻译比较工作台

本目录拥有 TransComparator 的翻译比较模型、跨语言对齐、页面构建及翻译专属 AI 校对。输入转换与正文提取复用 `src/ingest/`，连接和模型传输复用 `src/ai/`。

| 范围 | 职责 |
|---|---|
| `align_jp.py`、`row-alignment.js`、`alignment-artifact.js` | 跨语言对齐、比较行组装及对齐产物兼容与校验 |
| `build-compare.js`、`row-output.js`、`render-workbench.js` | 构建入口、模式输出与页面渲染 |
| `notes-recovery.js`、`notes-spaces.js` | 翻译备注的匹配、恢复与空间管理 |
| `ai/`、`ai-presets.js` | 翻译提示词、三阶段任务、输出门禁、预设与结果语义 |

翻译行不作为说话人或其他分析的通用容器。原文准入、段落完整性、模式裁剪和签名见 [文本输入与对齐契约](../../../docs/contracts/text-input-alignment.md)，依赖方向见 [模块边界](../../../docs/contracts/module-boundaries.md)；根 [AGENTS.md](../../../AGENTS.md) 只保留跨任务约束和读取入口。

使用和命令见根 [README.md](../../../README.md)。AI 提示词及阶段规则见 [AI 校对契约](../../../docs/contracts/ai-proofread-contract.md)，备注和客户端状态见 [工作台契约](../../../docs/contracts/workbench-notes-spaces.md)。上游 index-X 的输入规范归文本输入契约，翻译规范来源与同步义务归 AI 契约，本文件不复制这些细则。
