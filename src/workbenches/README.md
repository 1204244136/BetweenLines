# 工作台边界

每个工作台拥有独立的分析模型、构建器、UI 状态和导出产物。工作台可以复用 `src/core/`、`src/storage/`、`src/ingest/`、`src/ai/` 和公共浏览器资源；不得将其他工作台的行或备注当作自己的数据模型。

| 工作台 | 领域职责 |
|---|---|
| [translation-compare](translation-compare/README.md) | 一份原文与一到两份同级非原文的比较与翻译校对 |
| [speaker-attribution](speaker-attribution/README.md) | 单语或双语完整发话的说话人审阅与推断 |

完整段落身份由 ingest 层维护，句子和发话是可追溯的派生单元。领域工作台分别拥有分析结果，公共浏览器资源仍由 `public/` 维护，不复制为领域副本。

产品与操作说明见根 [README.md](../../README.md)，不变量、扩展规则和验证方式见 [AGENTS.md](../../AGENTS.md)。
