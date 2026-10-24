# 共享 AI 层

本目录提供已被领域工作台复用的 AI 基础能力。连接参数和 HTTP 请求属于共享层；翻译判断、说话人结果及各自的备注/缓存格式由领域工作台维护。

| 模块 | 职责 |
|---|---|
| `connection-config.js` | 统一规范化接口协议与供应商身份 |
| `llm-client.js` | 共享请求、响应解析、出站地址校验、等待预算与取消 |
| `token-usage.js` | 归一化接口 token 用量与缓存读取、写入、未报告状态，不持有任务统计 |
| `task-queue.js` | 有界任务派发、取消及进度回调 |
| `prompt-contract.js` | 不带领域字段的 Prompt 组装、JSON 输出约束与进程内稳定前缀标记 |

翻译的三阶段队列、并发策略与熔断仍属于翻译工作台；共享任务队列不另立一套翻译阶段状态。共享层不得反向加载某个工作台的任务执行器或将其 schema 强加给其他工作台。

运行与配置说明见根 [README.md](../../README.md)。共享传输和连接约束见 [AGENTS.md](../../AGENTS.md) 及 [AI 校对契约](../../docs/contracts/ai-proofread-contract.md)；本文件只记录模块职责。
