# CURRENT_SYSTEM

本文件只记录已经实现的事实。

## 已实现模块

- term-table（术语层）
- rule prefilter
- similarity prefilter
- ai-proofread
- model-capabilities
- low-score
- web-lookup
- format-guard
- punctuation
- notes-spaces
- writeback
- AI 预设系统
- 智能并发调度
- staged review contracts（stage-results.js：CritiqueResult 归一化与 StageMetrics 状态快照）
- scheduler-profile（模型六维画像系统与 Auto Scheduler 调度器）
- persona-runtime（单模型人格分化运行时：Gatekeeper、Stylist、Arbiter 独立会话与阶梯推理档位）
- arbiter（Stage 3 仲裁触发判定、确定性化解与 Chief Arbiter 终审裁决执行）
- feedback-collector（人工反馈闭环、操作追踪与各阶段/模型质量校准统计）
- 页面内可见阶段统计面板（ai-stage-dashboard：在工作台直接展示各阶段指标、Fast Pass 比例、Critique 分布与 Token/延迟指标）

## 当前主状态机

term-table
→ prefilter
→ Stage 1 Gatekeeper
→ Fast Pass 早停判定
→ Stage 2 Stylist 复审（多阶段/Challenger/Persona 模式）
→ Low Score Attribution
→ Web Lookup
→ Arbitration Trigger Check
→ Stage 3 Arbiter 终审裁决
→ format guard
→ punctuation
→ script guard
→ notes
→ writeback
→ feedback collector

目前 Fast Pass 已实现全面早停：确定性预筛、纯术语行以及 Gatekeeper 无需修改的高置信度行均计入 fastPassHits 与 stage1Passed，直接跳过 Stylist 与 Arbiter 调用以节省 Token 与时间。

在进入多阶段校对时，初审建议修改的行会转入 Stage 2 Stylist 进行文学复审与同行评议（Peer Critique），产出规范的 CritiqueResult（accept / modify / reject / escalate）。当 Gatekeeper 与 Stylist 存在立场对立或修改分歧时，自动触发 Stage 3 Arbiter 进行终审仲裁，产出权威的 ArbitrationResult。

系统已具备完整的性能与 Token 指标采集（promptTokens, completionTokens, totalTokens, latencyMs, modelCalls, averageLatencyMs），并随 clientStatus().metrics 实时透出。

客户端拥有页面内直接可见的阶段统计面板（#aiStageDashboard），与 stageMetrics 及 metrics 保持实时同步刷新。

本文件禁止写未来规划。
