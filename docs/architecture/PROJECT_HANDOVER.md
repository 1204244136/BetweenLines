# PROJECT HANDOVER

## 目的

本文件是 BetweenLines AI 校对体系的总交接入口。

新接手开发者应按以下顺序阅读：

1. CURRENT_SYSTEM.md
2. AI_REVIEW_SYSTEM_MAP.md
3. AI_REVIEW_HISTORY.md
4. DECISIONS.md
5. ROADMAP.md
6. ai-review/03-v3.0-架构设计.md
7. ai-review/04-v3.1-工程蓝图.md

---

## 当前项目状态

AI 校对体系已经具备：

- term-table
- prefilter
- low-score
- web-lookup
- format-guard
- punctuation
- notes
- writeback
- model-capabilities
- scheduler-profile（六维模型画像与自动调度器）
- persona-runtime（单模型人格分化运行时）
- arbiter（Stage 3 仲裁判定与终审裁决执行）
- feedback-collector（人工反馈闭环与质量标定）
- in-page stage dashboard（页面内直接可见阶段统计面板）
- metrics（Token、平均延迟与调用次数采集）
- Challenger 双模型挑战者模式
- Fast Pass 全链路高置信度早停

因此当前已经迈入：

『分层多 AI 认知审核体系（支持单模型 Persona 分化与多模型 Challenger/Arbiter 编排）』

---

## 为什么会设计多 AI 架构

历史上遇到的问题：

- 单模型容易过度挑刺。
- 单模型容易形成自身偏见。
- 文学问题不存在唯一正确答案。
- 不同模型在逻辑与文学上优势不同。

因此引出：

Gatekeeper → Stylist → Arbiter

认知分层方案。

---

## 已否决路线

- 多模型投票
- 多数决
- 全量串联审核
- 每行都进行仲裁

详见 DECISIONS.md。

---

## 当前最高优先级

不要先做 Arbiter。

不要先做四模型协同。

第一优先级为：

1. Fast Pass Unified（在现有执行器内接线）
2. Dual Model Challenger
3. Single Model Persona
4. StageMetrics 真实计数接线

只有 Challenger 验证有效后才进入 Arbiter。

---

## 核心代码入口

src/workbenches/translation-compare/ai/ai-proofread.js
src/workbenches/translation-compare/ai/model-capabilities.js
src/workbenches/translation-compare/ai/term-table.js
src/workbenches/translation-compare/ai/low-score.js
src/workbenches/translation-compare/ai/web-lookup.js

后续实现必须围绕这些入口扩展。

第一步已落地：src/workbenches/translation-compare/ai/stage-results.js 提供共享的 CritiqueResult 归一化和 StageMetrics 计数契约；ai-proofread 通过 clientStatus().stageMetrics 暴露快照。不要据此创建第二套校对主循环。

禁止建立第二套 AI 校对主循环。

---

## 文档位置

docs/architecture/

其中：

ai-review/01-v2.4-修订要点.md
ai-review/02-v2.4-重构版.md
ai-review/03-v3.0-架构设计.md
ai-review/04-v3.1-工程蓝图.md

保存完整设计演化历史。
