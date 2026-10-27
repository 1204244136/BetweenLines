# BetweenLines

BetweenLines 是一个面向长篇文本的本地分析工作台。它把 EPUB、TXT 和其他文档中的正文整理为可追溯的段落，再用于翻译比较、AI 辅助校对或说话人归属分析。

输入和审阅记录保存在本机。启用远程 AI 时，参与判断的正文与上下文会发送给你配置的提供商；AI 结论不会自动修改源文件。

不同作品可以分别配置译名、说话习惯和校对规范。默认使用通用小说规范，作品专有规则通过选用档案和导入辅助表格提供。

## 文档怎么读

| 读者与目的 | 入口 |
| --- | --- |
| 使用、安装或评估项目 | 本 README：功能、基本流程、输入输出与限制 |
| 准备辅助资料 | [译名表与说话习惯表](docs/usage/auxiliary-tables.md)：列名、格式、示例与导入注意 |
| 使用模型审阅 | [预筛选与 AI 校对](docs/usage/ai-review.md)：预设、阶段启停、续跑、统计与异常处理 |
| 保存审阅成果、修改原文件 | [备注与写回](docs/usage/notes-and-writeback.md)：备份、找回、人工确认与写回 |
| 让编码模型或维护者修改项目 | [AGENTS.md](AGENTS.md)：必守规则与按任务读取的领域文档入口 |

**README 和用户指南回答“如何使用、会得到什么”；AGENTS 和它引用的契约回答“修改实现时必须保证什么”。** 公共行为变化应更新用户文档；内部字段、算法、存储边界和验证要求由对应契约维护。AGENTS 保持简短，只保留跨任务规则与必要导航，避免把整份实现说明重复加载到模型上下文。

## 可以做什么

### 翻译比较（TransComparator）

选择一份原文与一到两份译文或版本文本，生成带差异高亮的 HTML 工作台、CSV 和 JSON。原文段落保持完整；没有匹配译文的原文仍单独显示，译文列留空。两份非原文是同级材料，不表示其中一份更权威。

工作台顶部以四个标签切换控制区，浅蓝底表示当前展开项；再次点击可收起，标签旁的徽标持续显示各区状态，长状态可悬停查看：

- **预筛选**：用规则和相似度粗筛，集中查看并确认通过行。
- **AI 辅助校对**：配置模型预设，运行事实初审、文学复审与终审仲裁。
- **筛选与批处理**：按结果筛选、调整列显示、批量确认或写回。
- **备注空间与找回**：保存人工备注、修改结果与确认记录，备份或找回历史记录。

双语模式只显示原文与一份非原文，三语模式显示三列。原文决定比较范围：译本独有的特典、附录、版权页、后记等不会进入最终比较。短引子、正文叙述和符合正文边界的尾声仍会保留。

未设置显示标签的新输入按「原文 A / 非原文 B / 非原文 C」区分文本角色；已有项目保留保存的标签。

### 说话人归属（Speaker Attribution）

根据上下文判断“这句是谁说的”。支持单语输入，或原文加一份对照文本；只把「…」、『…』中的完整发话作为判断项，叙述作为上下文。

页面提供分页、搜索、按判断与对齐状态筛选、证据查看、当前行 prompt 复制、本地记录和结果导出。证据标签用于安排审阅优先级，不表示判断正确率；对齐较弱或未匹配的行仍保留供人工核对。说话人结果与翻译备注分别保存。

## 环境要求

- Node.js 18+
- Python 3.12+
- Pandoc（非 TXT 输入默认需要；EPUB 在 Pandoc 不可用时可回退到内置 reader）
- 可选：支持 CUDA/ROCm 的 PyTorch，用于跨语言对齐
- 可选：Claude、OpenAI-compatible 或 Ollama 本地接口，用于 AI 校对

## 快速开始

```powershell
npm run setup:env                    # 首次初始化
npm run setup                        # 启动本地服务
```

Windows 上也可以直接双击仓库根目录的 `start-setup.bat`：它等价于 `npm run setup`，并在本地服务开始监听后自动打开控制台页面；服务未就绪时不会提前打开，因此不会看到「拒绝连接」的错误页。

GPU 环境可先检测并安装匹配的 PyTorch：

```powershell
npm run detect:accelerator
npm run setup:accelerator
```

需要跳过安装项或重建虚拟环境时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -NoInstallPython
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -RecreateVenv
```

没有 GPU 时可以显式允许 CPU 对齐：

```powershell
$env:TRANS_COMPARATOR_ALLOW_CPU = "1"
npm run align:jp
```

在浏览器打开终端显示的地址（通常是 `http://127.0.0.1:4317/`），为每个角色登记本机文件或解压目录，保存选择后点击“生成”。单个文件支持 EPUB、TXT、DOCX 等格式；解压目录必须是单本书的根目录，并包含 `META-INF/container.xml`。控制台会校验文件类型与 EPUB 结构；系统选择窗口不可用时可粘贴本机路径。双语模式中 `A` 是原文、`B` 是非原文；三语模式中 `A` 是原文、`B` 和 `C` 是两份同级非原文。

每个导入入口（原文 / 主文本 / 参考文本）各自记住自己的默认目录：再次点击同一张卡片时，系统选择窗口直接停在这个入口上次用的位置，三个入口互不干扰（首次使用仍需各自导航一次）；粘贴本机路径登记的入口同样计入。

## 从生成到审阅

1. **选工作台与模式**：翻译比较选择双语或三语；说话人归属选择单语或双语。
2. **登记本机输入**：分别选择文件或单本解压的 EPUB 目录，按需选择辅助表格。
3. **保存并生成**：在控制台查看进度，完成后打开工作台，先检查开头、章节边界和低置信度行。
4. **审阅并确认**：运行预筛或 AI，检查修改结果，必要时编辑，再显式确认或写回原文件。

### 辅助表格要先准备什么

支持 XLSX、CSV、TSV、JSON，按通用中英文表头识别列，列顺序不限。

| 表格 | 最少需要 | 作用 |
| --- | --- | --- |
| 译名表 | `原文`＋`译名`，也可用 `source`＋`target` | 为 AI 提供项目采用的译名，标出纯术语、术语注入与术语冲突 |
| 说话习惯表 | `角色`，另有 `口癖`、`项目写法`、`备注` 中至少一列 | 提供角色口癖、语气和特殊写法，支持仅用角色与备注描述规则 |

首行放表头，不要放说明行或合并表头。XLSX 优先读取名为 `data` 的工作表，否则读第一张；CSV / TSV 使用 UTF-8。说话习惯表的项目写法留空与填 `-` 含义不同。修改表或选择后，重新生成工作台。

完整列名、空值规则、公式与工作表限制、最小示例见 [辅助表格导入](docs/usage/auxiliary-tables.md)。

### 如何运行 AI

保持控制台服务运行，进入工作台「校对设置」，填写连接与模型，按需保存为预设。每张阶段卡片选中预设后还要点「添加」才会适用。

- **单阶段开始 / 停止**只控制该阶段；复审和仲裁处理启动时已有的候选。
- **一键开始**将已启用阶段按行衔接，**一键停止**停止全部运行阶段。
- **继续剩下的**保留已完成记录，直接补跑尚未完成的阶段；人工确认的行跳过。

最终结论为建议修改或无需修改；待终审和异常表示仍未完成。并发会在所设上限内自动调节，持续限流可能进入冷却，故障行可在任务结束后查看原因并续跑。模型超时后提供商可能仍在处理，因此不会自动重试超时行。

详细步骤及统计含义见 [预筛选与 AI 校对](docs/usage/ai-review.md)。模型判断仍需人工复核，尤其是专名、对齐较弱行和缺少上下文的句子。

### 保存、备份与写回

从控制台打开的翻译工作台自动把备注保存到电脑。重新生成、应用布局、删除工作台项目都保留长期备注。关闭页面前留意保存状态；出现「尚未保存」时先重试或导出备份。

写回会修改登记的原始文件。自动备份默认关闭，可在工作台写回操作区开启；备份失败或无法唯一定位目标时，不写入该行。翻译写回支持 UTF-8 TXT、XHTML / HTML、EPUB 文件及解压目录；说话人标注支持后三种带段落标签的格式。

「批量写回 / 批量确认」作用于当前筛选结果；「确认自动不改」确认全书中无需修改的条目，不受当前筛选限制。操作前核对确认框里的条数、范围与备份状态。

找回历史记录、导出 JSON、备份恢复和写回失败的处理方式见 [备注与写回](docs/usage/notes-and-writeback.md)。

## 项目与输出位置

控制台的「已生成项目」可切换项目、应用新布局或删除。应用布局只更新翻译页面；正文或对齐有变化时应重新生成。删除项目会移除该项目的快照与页面，长期备注和原始输入保留。

| 内容 | 默认位置 |
| --- | --- |
| 翻译 HTML、CSV、JSON | `out/projects/<projectKey>/snapshots/<snapshotId>/` |
| 说话人 HTML、JSON | `out/runtime/speaker-attribution/` |
| 翻译长期备注 | `out/notes/translation-compare/` |
| 输入登记、AI 运行结果等本机状态 | `out/runtime/` |

说话人输出独立于翻译项目切换和「应用新布局」，需重新生成说话人工作台；命令行可用 `BETWEENLINES_SPEAKER_OUTPUT_DIR` 指定输出目录。

本机源文本、辅助表格、写回备份、`out/`、`.env` 和 `profiles/local/` 私有档案默认不纳入 Git。现有本机文件可继续在原处使用，无需为了公开代码清空项目。工作台 HTML 和报告包含实际正文，输入选择、日志或备注备份也可能含本机路径，分享前需检查。忽略规则不会移除已提交内容，公开前仍需核对 Git 历史。

## 命令行使用

也可以不使用控制台，直接按步骤运行：

```powershell
npm run check:pandoc                 # 检查 Pandoc
npm run export:paragraphs            # 转换并导出段落
npm run align:jp                     # 检查加速环境、导出并跨语言对齐
npm run build                        # 构建当前翻译比较工作台
npm run align:jp && npm run build    # 完整流程
npm run build:speaker -- --source "C:\path\source.epub" # 构建单语说话人工作台
npm run check:accelerator            # 检查 Python/PyTorch 加速环境
npm run layout                      # 对活动翻译项目应用新布局
```

命令行可从目录推断输入，也可以显式指定文件或 index-X 作品编号：

```powershell
npm run export:paragraphs -- --input-dir "C:\path\to\texts"
npm run export:paragraphs -- --jp "C:\path\source.epub" --cn "C:\path\version-a.epub" --tw "C:\path\version-b.epub"
npm run export:paragraphs -- --work-id S1_01
npm run build:speaker -- --source "C:\path\source.epub" --parallel "C:\path\translation.epub"
npm run layout -- --project=<projectKey>
```

`align:jp` 已包含段落导出，完整流程无需先单独运行 `export:paragraphs`。`layout` 只重新渲染翻译项目的页面，不重新读取源文本或对齐；说话人工作台需要重新运行 `build:speaker`。`check:gpu` 是 `check:accelerator` 的兼容别名。工具的职责、输入和副作用见 [覆盖登记](docs/contracts/documentation-tools.md)。

说话人工作台也可在生成时启用模型推断：添加 `--ai --protocol compatible --base-url <接口地址> --model <模型>`，API Key 可通过 `BETWEENLINES_AI_API_KEY` 设置。`--protocol` 支持 `local`、`claude`、`compatible`，可选 `--provider` 仅用于命名供应商；启用后会调用配置的模型，未添加 `--ai` 时只生成待判断工作台。

配合 `index-X` 项目时，可使用同级 `../index-X`，或用 `INDEX_X_DIR` 指定位置，脚本可按作品编号发现输入；普通文件输入不要求使用该项目的命名方式。正文按章节与结构边界提取。若旧结果混入非正文、缺少开头，或两种语言从不同情节开始，需要重新生成；仅刷新或应用布局不会修复既有对齐。

若 Pandoc 不在 `PATH` 中，设置 `PANDOC_BIN` 指向 `pandoc.exe`。运行时数据目录可通过 `TRANSCOMPARATOR_DATA_DIR` 覆盖。

## 常见问题与限制

- **Pandoc 未安装**：运行 `npm run check:pandoc`，或用 `PANDOC_BIN` 指定位置。
- **更新后页面没变化**：翻译项目「应用新布局」后 F5；说话人工作台重新生成后 F5。若服务端也更新，先重启控制台服务。
- **旧确认或备注不见了**：先切回对应项目，用「预览找回」或导出 / 导入；旧浏览器记录尚未迁移时，回原浏览器、配置档或端口处理，见 [备注找回](docs/usage/notes-and-writeback.md#找回旧记录与备份)。
- **写回无法定位或存在多处同文**：该行保留供复核。核对源文件是否在生成后被修改，必要时重新生成，见 [写回定位失败](docs/usage/notes-and-writeback.md#无法定位时如何处理)。
- **直接双击 HTML**：可查看静态结果；导入、写回、项目切换、AI 和磁盘备注保存需要通过本地控制台服务使用。

工作台使用分页，整份行数据仍包含在 HTML 中，超大文本会增加页面体积。跨语言相似度只是对齐线索，简繁归一化也不能消除翻译风格差异。请检查开头、章节边界、低置信度行及最终改案。

## 参与维护

修改实现前先读 [AGENTS.md](AGENTS.md)，按其中的任务入口读取领域契约。维护验证使用 `npm test` 和 `npm run check:docs`；具体测试范围、提交要求与更新生效方式由模型文档维护。完整职责登记见 [文档与工具覆盖](docs/contracts/documentation-tools.md)。

## 开源致谢

- [Pandoc](https://pandoc.org/)：格式转换。
- [OpenCC.js](https://github.com/nk2028/opencc-js)：中文简繁归一化。
- [jsdiff](https://github.com/kpdecker/jsdiff)：词级差异高亮。
- [JSZip](https://github.com/Stuk/jszip)、[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)、[html-to-text](https://github.com/html-to-text/node-html-to-text)：EPUB 诊断和 fallback 路径。
- [Sentence Transformers](https://www.sbert.net/)、[PyTorch](https://pytorch.org/) 和 [NumPy](https://numpy.org/)：跨语言对齐。
- [Claude API](https://platform.claude.com/docs/en/api/overview)、[Ollama](https://ollama.com/) 及 OpenAI-compatible 生态：可选 AI 辅助校对。
