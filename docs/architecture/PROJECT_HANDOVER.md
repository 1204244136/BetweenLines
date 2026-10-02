# 项目交接入口

本文提供 BetweenLines 的接手路径。技术现状、未来计划和历史原因各自维护在独立文档中，交接入口只负责导航。

## 接手顺序

1. 阅读仓库根 [README.md](../../README.md)，了解两个工作台、运行方式、输出位置和用户可观察的限制。
2. 阅读 [AGENTS.md](../../AGENTS.md)，确认修改纪律、不变量、模块归属、生成物边界及所需验证。
3. 阅读 [CURRENT_SYSTEM.md](CURRENT_SYSTEM.md)，建立当前 AI 执行链与共享能力的认知。
4. 按改动范围阅读 [领域契约](../contracts/) 和对应模块 README：
   - [共享 AI 层](../../src/ai/README.md)
   - [工作台边界](../../src/workbenches/README.md)
   - [翻译比较](../../src/workbenches/translation-compare/README.md)
   - [说话人归属](../../src/workbenches/speaker-attribution/README.md)
5. 需要理解取舍时阅读 [DECISIONS.md](DECISIONS.md) 与 [AI_REVIEW_HISTORY.md](AI_REVIEW_HISTORY.md)；需要选择后续工作时查看 [ROADMAP.md](ROADMAP.md)。

## 开始修改前

代码入口、依赖方向和验证清单以 AGENTS 及对应契约为准；运行 Indexed CodeGraph 时遵循仓库的 CodeGraph 约定。已存在的领域执行器和共享模块先复用，旧设计稿仅作为背景材料。

历史蓝图见 [ai-review/](ai-review/)，不要求接手者先读完所有版本，也不根据旧稿中的实施顺序安排当前工作。
