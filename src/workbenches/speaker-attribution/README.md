# 说话人归属工作台

本目录拥有单语或双语完整发话的说话人审阅模型、构建器、证据注意力、模型推断与独立的浏览器记录。人工判断和模型预测分别保留，结果不写入翻译备注或翻译比较行。

| 模块 | 职责 |
|---|---|
| `speaker-selection.js` | 单语/双语输入选择与校验 |
| `prealign.js`、`epub-header-alignment.js` | 单调预对齐、EPUB 表头分段与对齐证据 |
| `attention.js` | 上下文取舍、候选提取与 Prompt 所需证据排序 |
| `ai/speaker-contract.js`、`ai/speaker-inference.js` | 说话人 Prompt/schema、输出校验、独立推断与缓存 |
| `build-workbench.js` | 模型组装、单语字段裁剪及页面/JSON 生成 |

完整发话与 `parentParagraphId` 来自共享 ingest 层；证据排序与对齐分数只作为审阅线索。模型执行复用共享 AI 传输和任务队列，不复用翻译校对的三阶段队列或备注模型。

使用、命令、输出位置与写回说明见根 [README.md](../../../README.md)。正文准入和对齐见 [文本输入与对齐契约](../../../docs/contracts/text-input-alignment.md)，产物隔离与写回见 [项目存储契约](../../../docs/contracts/project-storage-writeback.md)；共享传输与模型能力约束见 [AI 校对契约](../../../docs/contracts/ai-proofread-contract.md)，公共 Toast 约束见 [工作台契约](../../../docs/contracts/workbench-notes-spaces.md)。本文件只记录模块归属，不维护第二份操作手册。
