# BetweenLines

BetweenLines 是一个面向长篇文本的本地分析工作台。它把 EPUB、TXT 和其他文档中的正文整理成稳定、可追溯的段落与派生行单元，再由不同的领域工作台进行翻译比较、校对或叙事分析。

## 文档范围

本 README 面向使用者、评估项目的协作者和希望运行现有工作台的开发者，负责说明项目是什么、当前支持什么、如何安装运行以及结果保存在哪里。它只保留对外需要理解的架构概念。

编码代理和维护者还必须阅读 `AGENTS.md`。新增模块应放在哪里、哪些数据边界不可跨越、修改后必须执行哪些验证，以及 Git 和生成物纪律，都以 `AGENTS.md` 为准，不在本 README 中重复维护。

这个项目的重点不是把所有 AI 功能塞进一张表，而是建立一条可以被多个分析任务复用的文本基础设施：

- 格式转换、正文过滤和段落索引只做一次，保留原文的结构边界。
- 每个分析任务拥有自己的数据模型、提示词、缓存和工作台，结果不会互相覆盖。
- 句子或对话行是段落之上的派生视图，不会替换完整段落，也不会破坏翻译对齐的不变量。
- 输入、模型调用和生成物默认留在本机；项目快照可重复生成，并且不会把源文本或个人路径提交到仓库。

## 工作台

### Translation Compare

当前实现是原有的 TransComparator 工作流：一份原文加一到两份同级译文/版本文本，经过正文过滤、跨语言对齐和非原文差异比较后，生成 HTML 工作台、CSV 和 JSON。原文是准入边界；译本中的特典、附录、版权页、后记、译注等，如果原文没有对应内容，不进入最终比较。

三语模式中的两份非原文是同级材料。程序内部可以选择技术 pivot，但这不表示任何译本更权威。原文段落保持完整，非原文才允许为对齐、diff 和展示进行拆分或合并。

产物只包含所选模式真实存在的列。双语模式（原文 + 一份译文）不生成第三列的任何内容：`paragraphs.json` 没有 `tw` 键、导出日志不打印 `TW paragraphs: 0`、比较行不含 `tw`/`twCn`/`refinedScore`、CSV 表头、页面标签、控件和发给模型的提示词都只描述 A/B 两列。切换到双语模式后重新生成，工作台与导出文件即按新形状输出；行签名和项目标识不因这次裁剪而变化，已保存的备注仍然对应原来的行。

### Speaker Attribution

说话人归属工作台用于根据上下文确认“这句是谁说的”。它只处理带 `「…」` 或 `『…』` 的完整发话；引号中的多个句子保持为同一行，叙述行只作为上下文而不生成判断项。它支持单语输入；双语输入会先进行预对齐，并保留对齐证据较弱和未匹配行供人工复核。两份输入都是 EPUB 时，工作台会先按 spine 中 XHTML 文件名的完整稳定表头分段，例如 `S5_01_03-02`、`S6_24.06.07-02`；只有同表头的正文块才会进入同一轮行级对齐。目录、封面、版权页和后记等非正文块不会占用正文的对齐位置；没有任何共同表头时才退回整篇的单调对齐。生成的工作台提供分页、搜索、按判断/对齐状态筛选、归属证据查看、当前行 JSON prompt 复制、上下文查看、浏览器本地自动保存和确认结果导出，不会一次性渲染全部行；对照列与"主文本对照"开关、对齐版本概览只在双语输入时生成，单语工作台的数据文件里不会出现任何对照字段。

每行的“归属证据”是确定性启发式给出的审阅优先级，不是正确率：它按邻近叙述里是否出现说话动词、引用式 `と、Xは…` 和疑似称谓排序，把有明显可辨识证据的行提到高/中，把只能靠对话轮次推断的行标为弱，并建议人工结合上下文判断。双语模式下的“对齐证据”标签反映的是跨语言结构信号的强弱（共享片段、数字、句末结构、长度），在日/中等跨脚本输入下会按结构信号重新加权，不再被字符重叠整体压成“低”。

双语文本对照只展示可验证的信号，例如共享片段、数字、句末结构和长度；它不把跨语言字符重合当作语义结论。后续可以在不改变输入和对齐契约的前提下接入模型推断。

说话人结果不作为翻译备注，也不直接加成翻译比较表的一列；它使用独立的分析类型、结果模型和缓存身份。

## 共享管线

```text
输入文件
  -> EPUB/Pandoc 转换
  -> 正文范围过滤与媒体占位过滤
  -> 完整段落索引
  -> 派生句子/对话行（保留 parentParagraphId 和源文本偏移）
  -> 领域工作台分析
  -> 独立的 HTML / JSON / CSV 或其他结果
```

当前翻译比较仍然使用完整段落和跨语言对齐；派生行单元只为未来的句子级分析提供共享入口，不会改变现有段落编号或 alignment 语义。

## 目录结构

```text
public/                              浏览器页面、工作台脚本和样式
src/
  core/                              项目身份、签名和运行时存储布局
  storage/                           项目快照发布、切换、清理和读取
  ingest/                            输入选择、Pandoc/EPUB、正文过滤、段落和行单元
  ai/                                可复用 AI 传输、队列和缓存能力预留
  runtime/                           本地输入服务和生成流水线
  workbenches/
    translation-compare/             TransComparator 工作台、构建器和翻译专属 AI
    speaker-attribution/             说话人推断工作台
scripts/                             CLI、Python/PowerShell 工具和兼容入口
```

## 环境要求

- Node.js 18+
- Python 3.12+
- Pandoc（非 TXT 输入默认需要；EPUB 在 Pandoc 不可用时可回退到内置 reader）
- 可选：支持 CUDA/ROCm 的 PyTorch，用于跨语言对齐
- 可选：Claude、OpenAI-compatible 或 Ollama 本地接口，用于 AI 校对

首次初始化：

```powershell
npm run setup:env
```

需要跳过安装项或重建虚拟环境时：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -NoInstallPython
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -NoInstallPandoc
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -RecreateVenv
```

GPU 环境可先检测并安装匹配的 PyTorch：

```powershell
npm run detect:accelerator
npm run setup:accelerator
```

没有 GPU 时可以显式允许 CPU 对齐：

```powershell
$env:TRANS_COMPARATOR_ALLOW_CPU = "1"
npm run align:jp
```

## 快速开始：翻译比较

```powershell
npm run setup:env   # 仅首次
npm run setup
```

然后在浏览器打开终端显示的地址（通常是 `http://127.0.0.1:4317/`），为每个角色登记本机文件或解压目录，保存选择后点击“生成”。点击导入卡片后，选择菜单会在卡片内向下展开；“单个文件”和“EPUB 文件夹”使用同一种 Windows 选择界面、选择状态和写回提示。单个文件支持 EPUB、TXT、DOCX 等格式；解压目录必须是单本书的根目录，并包含 `META-INF/container.xml`。控制台会校验文件类型与 EPUB 结构；系统选择窗口不可用时，也可以粘贴本机路径。双语模式中 `A` 是原文、`B` 是非原文；三语模式中 `A` 是原文、`B` 和 `C` 是两份同级非原文。

也可以使用命令行：

```powershell
npm run check:pandoc                 # 检查 Pandoc
npm run export:paragraphs            # 转换并导出段落
npm run align:jp                     # 检查加速环境、导出并跨语言对齐
npm run build                        # 构建当前翻译比较工作台
npm run align:jp && npm run build    # 完整流程
npm run build:speaker                 # 构建说话人确认工作台
npm test                             # 运行 Node 测试
```

命令行可从目录推断输入，也可以显式指定文件：

```powershell
npm run export:paragraphs -- --input-dir "C:\path\to\texts"
npm run export:paragraphs -- --jp "C:\path\source.epub" --cn "C:\path\version-a.epub" --tw "C:\path\version-b.epub"
npm run export:paragraphs -- --work-id S1_01    # 配合 index-X 产物自动解析中日文件
```

若使用上游 `index-X` 项目（如同级目录 `../index-X` 或指定 `INDEX_X_DIR`）产物，简中译本来自 `index-X` 的打包 EPUB 或解压工作区（文件名形如 `[S1_01]...01X.epub`），日文原文来自其对齐的工作产物，台版原文作为同级非原文材料参与三语比较。脚本自动支持 index-X 的固定行模板（L1-L6）、`heading-lines` 标题、`ruby` 注音、`noteref` 译注标记以及 `Before_the_Prologue`（引子）与 `After_the_Epilogue`（尾声）章节结构。

若 Pandoc 不在 `PATH` 中，设置 `PANDOC_BIN` 指向 `pandoc.exe`。运行时数据目录可通过 `TRANSCOMPARATOR_DATA_DIR` 覆盖。

## 输出与隐私边界

`out/` 默认不提交到 Git，并按职责分区：

- `out/runtime/`：当前输入选择、遗留导入副本和临时工作目录。
- `out/.staging/`：尚未发布的生成任务。
- `out/projects/<projectKey>/snapshots/<snapshotId>/`：不可变项目快照和工作台产物。
- `out/active-project.json`：当前活动项目的小型指针。

项目默认保留最近两个快照。备注保存在浏览器 `localStorage`，不会写回源文本。不同分析结果分别保存，不会因为切换工作台而覆盖彼此。

控制台的「已生成项目」支持切换、应用新布局和删除。删除会永久移除 `out/projects/<projectKey>/` 下的快照与工作台页面，无法恢复；删除当前项目后会自动切换到最近保留的另一个项目，没有项目时清空 `out/active-project.json` 指针。源文本、已登记的输入选择和浏览器备注都不受影响，可以重新生成同名项目。

提交前确认以下内容没有进入版本控制：`.venv/`、`node_modules/`、`out/`、`.codegraph/`、源文本、模型缓存、绝对路径、API Key 和其他本机临时文件。

## 预筛选与 AI

当前翻译比较的预筛选是独立的确定性步骤：先统一繁简、全半角、空白和不可见字符，再对满足条件的正文计算相似度，只把仍需判断的行交给模型。AI 结果写入当前翻译比较快照对应的备注空间，人工备注和人工确认优先。

通过 `npm run setup` 启动的本地服务支持 Claude 原生 Messages API、OpenAI-compatible 服务和 Ollama 等本地接口。三语模式可选择校对 B 或 C，双语模式只校对 B；EPUB 注释标记（`noteref`）会原样保留，不参与翻译语义判断。

思考强度按模型自动适配：推理模型（如 o 系列、DeepSeek R1、QwQ、Kimi K3、Claude 3.7+ 思考模型等）会显示该模型自己声明的思考档位，只发送其支持的 `reasoning_effort` 或 `thinking` 预算，不支持 `temperature` 的模型不会附带采样参数；非推理模型仍使用 `temperature` 调整。档位来自内置模型清单、models.dev 元数据和名称启发式检测，绝不套用统一档位。

AI 校对带有错误率熔断保护：累计满 10 次结果后开始判定，最近 20 次调用中失败占比达到阈值时自动终止任务，避免接口持续报错时继续白跑。阈值在「校对设置」的「熔断阈值」中按百分比调整（默认 50%，范围 10%–100%），勾选旁边的「关闭」可完全停用该保护；两者都保存在浏览器本地，与并发等设置一致。接口配置或响应异常（如 401、返回非 JSON）不受该开关影响，仍会立即终止。熔断阈值随工作台页面生成，旧项目快照需重新运行 `npm run build` 才会看到该控件。

## 校对写回

翻译比较工作台的「写回」可以把勾选的修改结果直接写回原文件，说话人归属工作台也可以把说话人标记写回原文件。写回目标支持 TXT、XHTML/HTML、EPUB 文件和单本解压的 EPUB 目录。

写回总是修改输入选择中登记的路径：控制台通过「选择单个文件 / 选择解压的 EPUB 文件夹」直接登记本机原始路径（服务端弹出系统选择窗口），写回直接修改原始文件，与 git diff 立即可见；若选择窗口不可用，可用「粘贴本机路径」手动登记。早期版本遗留的浏览器上传导入副本（`out/runtime/imported-inputs/` 下）仍可正常读写，写回会如实提示目标是导入副本。

写回按工作台行文本在原文件中定位段落：纯文本段落直接替换；含 ruby 注音等内联标记的段落按块级文本匹配后整段替换，替换文本中的 ruby/加粗等内联标记会原样保留。多段合并行按 `\n\n` 拆分后逐段写回，允许跨 XHTML 文档；定位失败的行不会写入，并在结果中单独提示。EPUB 文件写回时会重新打包并保持 `mimetype` 条目规范。单行「写回」写回并确认该行；「批量写回 / 批量确认」作用于当前筛选结果。

备注和人工确认保存在浏览器本地，每条已核验记录带有所在行的内容签名。切换导入方式或重新对齐可能换到新的备注空间。首次打开尚未保存过的空间时，页面按行集或唯一行签名自动找回历史记录；已有记录（包括刻意清空的空间）不会自动搬入旧数据。「应用新布局」只更新页面，不改变行集和备注空间键。

「备注空间与找回」面板将本页记录与历史空间分开，铺满可用宽度并隐藏内部迁移标记，完整空间键和行号范围可在详情查看。点击「预览找回」可检查内容匹配、需核验、本页已有、未匹配的数量及样例；找回只补充空缺行，保留本页已有记录。没有完整行签名的旧记录可用至少三个唯一修订文本锚点推断行序；「按行号找回」在空间详情中单独选择。这两类推断结果都标记为「未校验」，不计入人工确认，写回与批量确认会跳过；逐行点击徽标或勾选人工确认后才解除。面板提供「清空本页」和「清空历史」，清空前会要求确认，建议先备份；清空本页不会删除历史，清空历史不会影响本页。

「导出本页」与「备份全部」均导出可重新导入的 JSON，包含尚未保存到本地的编辑。导入兼容旧版单空间及全空间备份；重复内容跳过，同名但内容不同的记录保存为副本，再由你预览找回。存储写满时保留来源空间和页面内存，持续显示未保存提示，可导出后手动清理已备份的历史空间，再重试保存。发现当前空间损坏或被其他页面修改时暂停保存，避免覆盖；导出备份会同时保留磁盘原始版本和本页内存记录。

本地存储按来源隔离：不同浏览器、不同浏览器配置档、不同端口，以及直接双击打开的 `file://` 页面，各持一份互不可见的备注。确认信息像是消失了，先回想当时是在哪个入口做的，在那一页导出 JSON，再回到这里导入即可。

## 常见问题

- **Pandoc 未安装**：运行 `npm run check:pandoc`，或设置 `PANDOC_BIN`。
- **输出混入后记、特典或版权页**：调整 `src/ingest/text-utils.js` 的正文结束规则，然后重新运行 `npm run align:jp && npm run build`。
- **章节标题进入正文**：补充 `src/ingest/text-utils.js` 的章节识别规则后重新生成。
- **对齐发生连锁错位**：检查快照中的 `paragraphs.json` 是否混入图片占位、页码、脚注或元信息，再重新运行对齐与构建。
- **确认信息像是被清空了**：备注只存在浏览器本地，并按「项目标识 + 行集签名」分区保存；重新对齐或更换导入方式会换一个分区，于是新页面读到的是空分区。打开工作台时程序会按行内容把旧分区的备注找回来并在状态栏报告条数，对不上的行不会被导入；原分区不会被删除，可在工作台的「备注空间与找回」里导出 JSON、导入 JSON 或按行号搬回。若各分区都对不上，多半是当时用了另一个浏览器、配置档或双击打开的 `file://` 页面，去那一处导出再导入。
- **直接双击 HTML**：可以查看静态结果，但输入导入、项目切换和 AI 校对需要通过 `npm run setup` 启动本地服务。

## 开源致谢

- [Pandoc](https://pandoc.org/)：格式转换。
- [OpenCC.js](https://github.com/nk2028/opencc-js)：中文简繁归一化。
- [jsdiff](https://github.com/kpdecker/jsdiff)：词级差异高亮。
- [JSZip](https://github.com/Stuk/jszip)、[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)、[html-to-text](https://github.com/html-to-text/node-html-to-text)：EPUB 诊断和 fallback 路径。
- [Sentence Transformers](https://www.sbert.net/)、[PyTorch](https://pytorch.org/) 和 [NumPy](https://numpy.org/)：跨语言对齐。
- [Claude API](https://platform.claude.com/docs/en/api/overview)、[Ollama](https://ollama.com/) 及 OpenAI-compatible 生态：可选 AI 辅助校对。
