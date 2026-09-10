# AGENTS.md

本文档面向在 BetweenLines 仓库中读代码、改代码和运行验证的编码代理与维护者。当前翻译比较工作台称为 TransComparator。

## 文档职责

`README.md` 是对外文档，面向使用者、协作者和首次运行项目的人，说明产品意义、当前工作台、环境安装、命令和输出位置。它不规定内部实现，也不替代本文件的验证清单。

`AGENTS.md` 是仓库内的实现契约，面向需要修改代码的 agent 和维护者，规定模块归属、数据不变量、生成物边界、修改纪律和验证方式。它不是用户手册；用户操作说明、功能介绍和公开限制应写在 `README.md`。

两份文档都描述同一个项目，但职责不同：公共行为变化需要同步更新 README，内部路径或验证规则变化只更新 AGENTS；如果一个改动同时影响两者，应分别从各自读者的角度记录一次，不要整段复制。

## 实现所依赖的领域契约

BetweenLines 共享本地、文件型文本处理和分析能力；当前的 TransComparator 翻译比较工作台可以处理最多三份文本：

- 一份原文，通常是源语言文本（日文）。
- 一到两份非原文文本，可以是不同译本、校订本或地区版本。

上游材料对齐约定：
本项目使用的源文件（除台版外）均来自 `index-X` 项目（同级目录 `../index-X` 或环境变量 `INDEX_X_DIR`）的相关产物：
- 简中文本来自 `index-X` 构建生成的 EPUB 档案或解压工作区（`output/epubs/` 或 `EPUB/` 目录，文件名形如 `[S1_01]...01X.epub`）。
- 日文原文来自 `index-X` 维护的对齐工作源（`.cache/epub-work/japanese-text/` 或同步镜像）。
- 台版文本作为同级的非原文对照材料，来自独立的台版出版物。

index-X 结构与命名规范契约：
- 作品编号：`S1`（旧约）、`S2`（新约，含 `S2_22r`）、`S3`（创约）、`S4`（少女共栖）、`S5`（外典三段式 `S5_AA_BB`）、`S6`（日期短篇 `S6_YY.MM.DD`）。
- 正文文档命名：`<表头>_<语义后缀>.xhtml`，内容序从 `-01` 开始。
- 章节结构：序章前无标题正文聚合为内容序 `01` 的 `Before_the_Prologue`（引子）；后记作者署名后的正文聚合为 `After_the_Epilogue`（尾声）。
- 准入与边界：`Afterwords`（后记/あとがき）不进入翻译比较与说话人推断；紧接后记的 `After_the_Epilogue`（尾声）属于正文故事叙述，必须进入比较与推断。附录/版权页/介绍页为硬性截止边界。
- 格式契约：正文套用统一固定行模板（L1-L6），支持 `heading-lines` 多层标题、`<ruby>` 注音、以及 `<a epub:type="noteref"><sup>㊟</sup></a>` 译注标记。

非原文文本在产品语义上是同级材料。可以为了实现选择其中一份作为技术 pivot，但不要在 UI、文档或变量说明中暗示它比另一份更权威。

原文是准入边界：如果某段内容不存在于原文，哪怕某个译本或地区版本收录了它，也不应进入最终比较。典型例子是特典、电子书附录、版权页、后记、译注和制作信息。

## 不变量

- 原文段落不可拆分。原文只能以完整段落为单位参与 `1:1`、`1:2`、`2:1`、`2:2` 或更大合并组。
- 非原文段落可以为对齐、diff 和展示进行拆分或合并。
- 产物必须按比较模式生成：双语模式的 `input-selection.json`、`paragraphs.json`、`jp-align.json`、`translation-compare.{json,csv,html}`、AI 提示词和控制台日志里都不允许出现第三列（`tw`、`台版`、`参考文本`、`非原文 C`）的键、标签、空占位或 hidden 控件；三语模式则必须完整保留三列。判断依据是"该模式是否真的有这一列"，不是"有没有值"。
- 上述模式裁剪不得改变 `projectKey`、`rowsSignature` 或 `signature`：它们是浏览器备注与写回定位的键，只能因源文本或对齐结果真实变化而变化。
- 不要重新引入没有 reuse tracking 的 naive paragraph-number fallback。
- 不要让同一个原文长段落被 semantic groups 和 fallback 重复使用。
- 修改 text cleaning、heading detection 或正文过滤后，必须重新生成 `paragraphs.json`、`jp-align.json` 和最终工作台。
- 源文本文件和生成物不应提交到仓库，除非用户明确要求。

## 当前 Pipeline

1. `src/ingest/text-utils.js`
   - 集中配置输入文件路径和输入模式。
   - TXT 以 UTF-8 直接读取。
   - 非 TXT 优先通过 Pandoc 转成完整 linear plain text。
   - 对 Pandoc 输出执行正文范围过滤、媒体占位过滤和段落切分。
   - 识别章节/行间标题，并将其排除在正文段落之外。
   - 通过 OpenCC 在需要时做中文简繁归一化。

2. `src/ingest/pandoc-utils.js`
   - 封装 Pandoc 调用。
   - 将 EPUB、DOCX、HTML、ODT、Markdown、RTF 等 Pandoc 支持格式转为 plain text。
   - 只负责格式转换，不负责判断哪些内容应进入比较。

3. `src/ingest/epub-utils.js`
   - EPUB 默认走 Pandoc。
   - 内置 OPF/nav/spine reader 保留为诊断和 fallback 路径。
   - 不要把 EPUB 专用逻辑扩展成所有格式的主路径。

4. `scripts/export-paragraphs.js`（兼容 CLI；实际输入逻辑在 `src/ingest/`）
   - 加载最多三份源文件。
   - 写入当前构建目录的 `paragraphs.json` 和输入选择快照。
   - `src/ingest/input-selection.js` 的 `validateSelection` 只保留该模式的列：双语模式的 `files`/`labels`/`startMarkers` 里不出现 `tw` 键（不是空串、不是默认标签）。
   - `src/ingest/text-utils.js` 的 `loadParagraphs` 双语模式只返回 `cn`/`jp`，不写空 `tw` 数组；控制台也只按 `activeLangs()` 打印段落计数。
   - 被 `npm run align:jp` 自动调用。

5. `src/workbenches/translation-compare/align_jp.py`（`scripts/align_jp.py` 为兼容 CLI 入口）
   - 使用 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` 做跨语言语义对齐。
   - 当 `torch.cuda.is_available()` 为 true 时使用 CUDA/ROCm 暴露的加速后端，否则使用 CPU，除非 accelerator guard 阻止。
   - 写入当前构建目录的 `jp-align.json`，其中 `groups` 是唯一对齐数据；组内区间只用 `pivotStart`/`pivotEnd` 命名（不再有 `tw*` 别名，也不再写无消费方的段落级 `mapping`）。
   - 双语模式 pivot 固定为 `cn`，日志按模式称呼该列（译文 / 非原文）。

6. `src/workbenches/translation-compare/build-compare.js`
   - 三语模式对齐两份非原文文本；双语模式不做该步，直接把主文本段落作为技术 pivot 单元。
   - 读取跨语言 `groups`（`pivotStart`/`pivotEnd`，兼容旧快照的 `twStart`/`twEnd`）。
   - 按技术 pivot interval 合并不同方向的对齐组。
   - 行字段、`counts`、CSV 列、页面标签和内嵌行数据都由 `rowFieldsFor(mode)` 决定：双语行不携带 `tw`/`twCn`/`twChars`/`refinedScore`，页面也不渲染不属于该模式的控件（不是 `hidden`）。裁剪只删字段，不改变 `signature`/`rowsSignature` 的取值。
   - 输出 HTML、CSV、JSON。
   - `notes-spaces.js` 为翻译备注的纯函数辅助模块，注入生成页面并由 Node 测试复用；备注空间键与行内容签名保持原契约。备份保留原始数据，导入同名空间只创建副本；找回保留当前行已有记录，不能通过释放来源空间应对配额不足。
   - `recoveredUnverified` 记录不能携带当前行的 `rowSig` 或计入人工确认；文本锚点与按行号找回都必须保持此标记，只有逐行核验可解除。页面必须提供清空当前空间和清空历史空间的显式操作，均需确认且不能误删另一类空间。验证执行 `node --test scripts/notes-spaces.test.js scripts/build-compare.test.js`，其中使用生成页面的 VM 交互回归，不使用浏览器截图。

7. `src/core/storage-layout.js`、`src/storage/project-store.js`、`src/runtime/generation-pipeline.js`
   - 将运行时输入、隔离 staging 和不可变项目快照划分到不同目录。
   - 控制台生成成功后以目录 rename 发布快照，再原子更新 `out/active-project.json`。
   - 项目切换只更新活动指针和小型输入选择，不复制大型生成物。
   - `out/projects/<projectKey>/snapshots/<snapshotId>/` 是已发布生成物的唯一事实来源。

8. `src/ingest/line-units.js`、`src/workbenches/`
   - 完整段落是共享的稳定源索引。
   - 句子/对话行只能作为带 `parentParagraphId` 和源文本偏移的派生单元。
   - 说话人归属的待判断行只抽取完整的 `「…」`、`『…』` 发话；不得按引号内部的句末标点拆行。叙述句仅用于上下文，不得生成说话人判断行。
   - 翻译比较与说话人推断必须使用独立的工作台数据模型、结果和备注空间。
   - `src/workbenches/translation-compare/ai/` 的预筛选、提示词和校对结果属于翻译工作台；未来共享 AI 传输能力放在 `src/ai/`，不要反向污染领域模型。

9. `src/workbenches/speaker-attribution/`
   - `speaker-selection.js` 支持单语 `--source` 和双语 `--source` + `--parallel` 输入。
   - 双语 TXT/文档模式使用 `prealign.js` 的整篇单调预对齐；双 EPUB 模式必须先按 XHTML 文件名中的完整稳定表头分段，再在同表头正文块内运行 `prealign.js`。没有共同表头时才允许整篇 fallback；未匹配行必须保留并标记状态。
   - `build-workbench.js` 只生成说话人专属 JSON/HTML 和浏览器本地确认空间，不复用翻译比较的 rows 或 notes；双语对比时以原文为准入边界，无原文行的主文本发话（`source: null`）直接剔除，不进入工作台行与归属确认流程。
   - 持久化的 `alignment` 只保留摘要（版本、计数、`headerAnchors`）；预对齐中间 `rows` 不落盘——每行的 source/parallel/comparison 已经在 `rows` 里带上下文保存一次，重复保存会让工作台 JSON 成倍膨胀。裁剪不得改变 `analysisKey`，否则浏览器确认结果会失去对应关系。
   - 单语模式不生成 `parallel`/`parallelText`/`comparison` 行字段、`parallel*Count` 统计与 `files.parallel`，页面也不渲染"主文本对照"开关和对齐版本概览；双语模式保留全部对照证据。
   - `attention.js` 是说话人专属的确定性证据注意力层：上下文必须保留完整引号发话，只对引号外叙述做句子切分；按邻近度、说话动作词、疑似称谓和对齐信号压缩 prompt 输入。注意力权重是排序依据，不得当作模型事实；候选不足时必须允许 `unknown` / `needsContext`。

## 文件归属与扩展规则

- `src/core/`、`src/storage/`、`src/ingest/`：共享能力。修改时必须检查所有工作台和项目快照调用方。
- `src/workbenches/<name>/`：领域工作台。工作台拥有自己的结果模型、构建器、提示词、缓存和备注空间，不得复用另一工作台的 rows 或 notes 作为数据模型。
- `src/ai/`：未来可复用的 AI 传输、队列、取消和缓存原语；翻译专属逻辑留在 `src/workbenches/translation-compare/ai/`。
- `src/runtime/`：本地服务和生成编排，只负责连接输入、共享能力和工作台，不在这里堆积领域判断。
- `scripts/`：命令行、Python/PowerShell 工具和旧路径兼容入口。兼容入口只转发，不复制业务实现。
- `public/`：浏览器资源。不要把服务端存储、对齐或 AI 领域逻辑移入前端文件。

README 中的目录树用于帮助外部读者建立概念；本节才是新增或移动实现时的路径依据。

## 正文过滤原则

Pandoc 会忠实输出完整 linear text；过滤职责属于共享 ingest 层，当前实现位于 TransComparator 使用的 `src/ingest/`。

正文过滤应优先使用块级边界，而不是全文关键词扫描。正文中可能自然出现“版权”“特典”“图片”等词，不能因此截断。

常见应过滤内容：

- 后记、あとがき、後記。
- 特典、番外、电子书限定附录。
- 版权页、colophon、copyright、出版/发行信息。
- Pandoc 产生的媒体占位，例如 `[]`、`[图片]`、`[p051]`。
- 目录、封面、制作信息、译注等非正文块。

如果过滤规则不确定，宁可保留内容并让后续原文准入和 alignment 排除，也不要过早删除可能是真正文段的文本。

## 对齐标签

类似 `A-B 1:2 / C-B 2:2` 的标签含义：

- `A-B`：文本 A 到文本 B 的对齐。
- `C-B`：文本 C 到文本 B 的对齐。
- `1:2`：左侧 1 个段落对应右侧 2 个段落。
- `2:3` 等更大组表示相邻冲突被合并为稳定区间。

涉及原文时，任何组合都必须保留完整原文段落。

## 生成文件与重型文件

`.codegraph/` 是 CodeGraph 目录索引插件的本地索引依赖，不属于可清理生成物。不要删除、移动或重建该目录，除非用户明确要求重新生成 CodeGraph 索引。

`out/` 的存储边界：

- `runtime/` 只保存当前输入、浏览器导入文件和命令行临时工作目录。
- `.staging/` 只保存尚未发布的控制台生成任务。
- `projects/` 只保存不可变项目快照。
- 顶层只允许 `active-project.json` 指针，不要重新引入顶层 `paragraphs.json`、`jp-align.json` 或 `translation-compare.*`。

除非用户明确要求，不要提交或复制：

- `.venv/`
- `node_modules/`
- `out/`
- `*.txt`、`*.epub`、`*.docx` 等源文本文件
- 下载的 model caches
- 本机安装脚本或临时环境文件

源文件路径应集中维护在 `src/ingest/text-utils.js`。公开发布前不要写入个人目录、真实作品名或其他隐私信息。

## 修改纪律

- 优先使用确定性的本地 scripts，不要手工改 spreadsheet。
- 变更输入格式、正文过滤、heading detection 或段落切分后，必须重新运行导出和对齐。
- 修改 alignment 后，必须验证空原文、重复长原文和行数异常。
- 不要把技术 pivot 描述成主从关系。
- commit 信息应使用中文并遵守 Conventional Commits 风格。
- 不要使用破坏性 git 命令，除非用户明确要求。
- 如果工作树已有用户或其他 agent 的改动，必须保留并与之协作。
- 修改后不要进行浏览器截图验证，因为本地 Playwright 运行时缺少 `playwright-core`。

## 本地测试输入

如需使用真实样本进行本地验证，请在仓库之外自行准备三类测试输入，并把本机路径保存在忽略文件或环境变量中，不要写进仓库：

- EPUB：简中 EPUB 的单本解压目录或 `.epub` 文件。
- 日文原文：日文侧对齐工作源目录。
- 台版原文：台版出版物的单本解压目录。

这些路径仅供本机测试输入定位。不要把源文件、绝对路径、样本目录名或生成物复制或写入仓库，也不要写进代码默认配置。公开发布前应确认 README、AGENTS、日志和提交内容没有泄露本机路径或作品信息。

## 验证清单

基础导出：

```powershell
npm run check:pandoc
npm run export:paragraphs
```

完整生成：

```powershell
npm run align:jp
npm run build
```

检查段落数量和末尾内容（按模式取列，双语快照没有 `tw` 键）：

```powershell
node -e "const fs=require('fs'); const {getActiveProject,resolveProjectArtifact}=require('./scripts/project-store'); const a=getActiveProject(); if(!a) throw Error('没有活动项目'); const p=JSON.parse(fs.readFileSync(resolveProjectArtifact(a.id,'paragraphs.json',{snapshotId:a.snapshotId}),'utf8')); const cols=['jp','cn','tw'].filter((l)=>Array.isArray(p[l])); console.log(JSON.stringify({mode:p.comparisonMode,cols,counts:Object.fromEntries(cols.map((l)=>[l,p[l].length])),last:Object.fromEntries(cols.map((l)=>[l,p[l].at(-1)?.text]))},null,2));"
```

检查最终行：

```powershell
node -e "const fs=require('fs'); const {getActiveProject,resolveProjectArtifact}=require('./scripts/project-store'); const a=getActiveProject(); if(!a) throw Error('没有活动项目'); const data=JSON.parse(fs.readFileSync(resolveProjectArtifact(a.id,'translation-compare.json',{snapshotId:a.snapshotId}),'utf8')); const map=new Map(); data.rows.forEach((r,i)=>{if([...r.jp].length>=18){if(!map.has(r.jp))map.set(r.jp,[]);map.get(r.jp).push(i+1)}}); const dup=[...map.entries()].filter(([,v])=>v.length>1).slice(0,5).map(([jp,rows])=>({rows,jp:jp.slice(0,80)})); const counts={}; for(const r of data.rows)counts[r.relation]=(counts[r.relation]||0)+1; const mode=data.project.comparisonMode; const thirdColumn=mode==="bilingual"&&data.rows.some((r)=>["tw","twCn","twChars","refinedScore"].some((k)=>k in r)); console.log(JSON.stringify({mode,rows:data.rows.length,counts:Object.keys(data.counts),rowKeys:Object.keys(data.rows[0]||{}),bilingualLeakage:thirdColumn,emptySource:data.rows.filter(r=>!r.jp).length,duplicateLongParagraphs:dup.length,relations:counts,dup},null,2));"
```

一般期望：

- 原文列不应大量为空。
- 同一长原文段落不应意外重复。
- Pandoc 媒体占位不应成为正文段落。
- 特典、后记、版权页不应进入最终比较。
- `bilingualLeakage` 必须为 `false`；双语快照的 `counts`/`rowKeys` 不应出现 `tw`、`twCn`、`twChars`、`refinedScore`。

## 常见故障定位

原文重复：检查是否重新引入了无 reuse tracking 的 fallback，或技术 pivot interval 合并是否漏掉重叠组。

原文为空：检查活动项目快照中的 `jp-align.json` 是否过期，或正文过滤是否改变了段落索引。

章节标题污染正文：补充 `chapterPatterns`，然后重新生成全部输出。

插图附近错位：先确认 `splitParagraphs` 是否过滤了 media-only blocks，再看 grouped moves 是否需要扩大或加局部重对齐。

Pandoc 输出混入非正文：优先调整转换后的块级正文边界规则，不要回退到按整篇文本关键词扫描。

双语产物出现第三列内容（`TW paragraphs: 0`、`counts.tw`、行里的 `tw`/`twCn`/`refinedScore`、页面上的"台版/参考文本"）：先确认活动快照是否由旧版本生成——模式裁剪只对新构建生效，重新运行 `npm run align:jp && npm run build` 即可；若重新生成后仍存在，检查是哪一层又把 `tw` 加了回来（`validateSelection`、`loadParagraphs`、`rowFieldsFor`/`exportRows`、`makeHtml` 的 `pageLabels`）。

## 当前限制

- UI 是静态 HTML table，尚未针对超大型文本做虚拟滚动或分页。
- 备注按 row index 存储，已核验记录同时带 `rowSig`；新空间只自动找回有行集或唯一行签名证据的记录。缺少签名的历史记录通过预览找回，行序推断必须逐行核验，不能当作可靠内容匹配。
- 跨语言 embeddings 只是校对辅助，不是最终权威 alignment。
- OpenCC 有助于比较中文变体，但无法归一化翻译风格差异。
