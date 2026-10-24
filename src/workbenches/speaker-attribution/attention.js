const ATTENTION_VERSION = "evidence-attention-v2";
const {
  SPEAKER_PROMPT_VERSION,
  speakerPrompt,
  speakerPromptFor,
  buildSpeakerSystemPrompt,
} = require("./ai/speaker-contract");
const { stripInvisible, unique } = require("../../core/text-helpers");
const { createSystemMessage } = require("../../ai/prompt-contract");

// 说话归属动词。最长/最具特异性的表层形式排在前面，以便
// 择一匹配能够优先锚定它们（例如「と言った」先于「言った」，「叫び返した」
// 先于「叫んだ」）。保留引用形式「と-」，是因为此时「と」是动词短语的一部分
// （「…」とXは言った），而单独的助词「と」则不作为名字与动词间的桥梁，
// 以免将「Xと話す」（和 X 说话）中的 X 误判为说话人。故意排除了独立的「回/答」：
// 普通叙述中的「回」会匹配到「回転」（旋转），「答」会匹配到「答えられない」（无法回答），
// 从而产生系统性的虚假线索。
const attributionCues = [
  // 中文
  "说道", "问道", "答道", "叫道", "喊道", "回应", "告诉", "解释", "补充", "说", "问", "回答", "称",
  // 日文引用 と- 形式
  "と言った", "と言う", "と答えた", "と尋ねた", "と叫んだ", "と呼びかけた", "と告げた", "と呟いた", "とつぶやいた",
  "と怒鳴った", "と続けた", "と付け加えた", "と声を上げた", "と声をあげた", "と話しかけた", "と聞き返した", "と話した", "と応えた", "と述べた",
  // 日文简体/原形形式
  "叫び返した", "言った", "言い返した", "言って", "言い", "言う", "答えた", "尋ねた", "叫んだ", "叫び", "叫ぶ",
  "呼びかけた", "告げた", "返事した", "呟いた", "呟く", "つぶやいた", "つぶやく", "怒鳴った", "続けた",
  "付け加えた", "声を上げた", "声をあげた", "話しかけた", "聞き返した", "話した", "话す", "应えた", "应える",
  "述べた", "述べる", "勧めた", "提案した",
  // 发话接续动作动词
  "飛び出した", "飛び出す", "駆け出した", "駆け出す", "駆け寄った", "立ち上がった", "頭をかきむしった",
  "ため息をついた", "溜息をついた", "苦笑した", "舌打ちした", "肩をすくめた",
  // 英文
  "said", "asked", "replied", "answered", "called", "told", "explained",
].join("|");
const cuePattern = new RegExp(`(?:${attributionCues})`, "iu");
// 人名字符仅包含汉字 / 片假名 / 拉丁字母。排除平假名，以防
// 连续名字串吞入助词（如「サラリと」）或副词假名（如「ついつい」）；
// 之后的 isLikelyCandidate 过滤器会进一步丢弃任何残留带有假名的捕获项。
const nameChars = "A-Za-z\\u30a0-\\u30ff\\u3400-\\u9fff";
// 仅使用表示主语的助词（は/が/も，以及作为促音强化成分的「っ」）连接
// 名字与其发话动词。排除宾语/受话人标记（を/に/へ/と），
// 这样「母に言った」（对母亲说）和「仲間と話した」（和同伴说话）
// 就不会将受话人/同伴提升为说话人。该桥接仅存在于
// 零宽正向前瞻中，因此捕获到的名字绝不包含助词本身。
const jpSubjectParticles = "はがもっ";
// 名字前的真实边界可防止引用的片假名短语（例如
// "すわマイリマシター、と言ったら"）被误认为说话人姓名。
// 紧贴副词的名字（如「ついつい山田は叫び返す」）属于为保证准确率而接受的极少数漏报。
const cueNamePattern = new RegExp(
  `(?:^|[，,、。；;：:\\s])([${nameChars}]{1,16}?)(?=(?:[${jpSubjectParticles}]*[\\s、,，]*)?(?:${attributionCues}))`,
  "giu",
);
// 句首引用形式「と」（"「…」と、Xは…"）即使后续没有发话动词，
// 也能将前置引用关联到 X（如「…」と、山田は足を止めた。）。此处的「と」位于
// 名字之前，因此不会与名字后表示“和”的「と」混淆。
// 此处的前瞻仅限于「は/が/も」——不包含「っ」——因此动词接续（如「と思って」、
// 「と笑って」、「と走って」）不会将动词词干误提升为候选人。
const quotativeNamePattern = new RegExp(
  `(?:^|[\\s、,，。；;：])(と[、,，]?\\s*)([${nameChars}]{1,16}?)(?=[はがも])`,
  "giu",
);
// 支持引用「と」之后带有伴随动作或修饰副词再引出主语（如「と頭をかきむしりながら山田は…」「と溜息をついて佐藤は…」）
const quotativeWithActionPattern = new RegExp(
  `(?:^|[\\s、,，。；;：])と[、,，]?\\s*(?:[^\\s、,，。]{1,24}?(?:ながら|て|つつ|風に|ように)[、,，]?\\s*)([${nameChars}]{1,16}?)(?=[はがも])`,
  "giu",
);
// 「と言ったら」/「と答えた」等以发话动词词根开头；
// 否则引用模式会将这些动词（言、答、…）误提升为候选人。
const speechVerbRoots = new Set(["言", "答", "叫", "問", "问", "述", "話", "话", "返", "呟", "喊", "道", "称", "回"]);
const speechVerbRootChars = "言答叫問问述話话返呟喊道称回";
const quotativeCuePattern = new RegExp(
  `(?:^|[\\s、,，。；;：])と[、,，]?\\s*(?:[^\\s、,，。]{1,24}?(?:ながら|て|つつ|風に|ように)[、,，]?\\s*)?(?![${speechVerbRootChars}])[${nameChars}]{1,16}?(?=[はがも])`,
  "giu",
);
// 「と、Xは/が<动作>」接续中常见的非人物主语（如门、身体部位、自然现象等）。
// 它们频繁出现在引用/副词性「と」之后，但并非发话主体，
// 因此将其从候选人列表中排除。
const nonPersonNouns = new Set([
  "ドア", "扉", "窓", "顔", "頭", "手", "足", "声", "音", "目", "気", "心", "胸", "背中", "体", "肩", "首",
  "空", "街", "部屋", "教室", "天井", "床", "瞬間", "矢先", "時", "中", "前", "後", "側", "方", "所",
  "光", "影", "風", "雨", "空気", "電話", "机", "壁", "地面", "水", "火", "時間", "場所", "息", "涙",
  "汗", "髪", "口", "鼻", "耳", "指", "腕", "脚", "膝", "爪", "唇", "瞳", "眼", "舌", "牙", "翼",
]);
const candidateStopWords = new Set([
  "然后", "于是", "但是", "因为", "所以", "只是", "自己", "现在", "什么", "怎么", "それ", "これ", "そして", "しかし",
  "there", "then", "that", "this", "what", "when", "said", "asked",
  "他", "她", "它", "我", "你", "您", "彼", "彼女", "誰", "谁",
  "俺", "僕", "私", "君", "自分", "儂", "我", "奴",
  "停下", "脚步", "看着", "看向", "走近", "转身", "回头", "沉默", "声音", "人", "その",
]);


function normalize(value) {
  return stripInvisible(value).trim();
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function isLikelyCandidate(raw, cleaned) {
  if (!cleaned || candidateStopWords.has(cleaned.toLowerCase())) return false;
  if (nonPersonNouns.has(cleaned)) return false;
  // 叙述性副词短语在「言う/答える」之前往往以日文助词结尾；
  // 在移除助词后，剩余的平假名是强烈的假阳性信号。
  if (!/[A-Za-z]/u.test(raw) && /[\u3040-\u309f]/u.test(cleaned)) return false;
  return true;
}

// EPUB 的 ruby 标签在隐藏注音的同时保持汉字形式可见，
// 因此在匹配前先剥离这些标签。紧接在闭引号后面的引用「と」
// （如「…」と山田は言った）会被吸收，从而使名字获得清晰的边界。
function cleanedNarrative(text) {
  return normalize(text)
    .replace(/<ruby>(.*?)<rt>.*?<\/rt><\/ruby>/giu, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[「『].*?[」』][、,，]?\s*と/gu, " ")
    .replace(/[「『].*?[」』]/gu, " ")
    .replace(/[\u3000\s]+/gu, " ");
}

function stripTrailingParticles(name) {
  return name
    .replace(/[はがのにをもとへで]$/u, "")
    .replace(/(?:说|問|问|答|道|曰)$/u, "");
}

function extractCandidateNames(text) {
  const value = cleanedNarrative(text);
  const candidates = [];
  for (const match of value.matchAll(cueNamePattern)) {
    const raw = match[1].trim();
    const name = stripTrailingParticles(raw);
    if (isLikelyCandidate(raw, name)) candidates.push(name);
  }
  for (const match of value.matchAll(quotativeNamePattern)) {
    const raw = match[2].trim();
    const name = stripTrailingParticles(raw);
    if (speechVerbRoots.has(name)) continue;
    if (isLikelyCandidate(raw, name)) candidates.push(name);
  }
  for (const match of value.matchAll(quotativeWithActionPattern)) {
    const raw = match[1].trim();
    const name = stripTrailingParticles(raw);
    if (speechVerbRoots.has(name)) continue;
    if (isLikelyCandidate(raw, name)) candidates.push(name);
  }
  return unique(candidates).slice(0, 8);
}

function contextSignals(item = {}, distance = 0, target = false) {
  const text = normalize(item.text).replace(/<[^>]+>/g, " ");
  const reasons = [];
  const candidates = target || item.isQuotedDialogue || /^[「『]/u.test(text) ? [] : extractCandidateNames(text);
  const hasCue = !target && cuePattern.test(text);
  const hasQuotative = !target && quotativeCuePattern.test(text);
  if (target) reasons.push("目标发话");
  else if (distance === 1 && item.relation !== "context-after") reasons.push("紧邻目标的前文");
  else if (distance === 1) reasons.push("紧邻目标的后文");
  else reasons.push(`相邻上下文 ${distance} 行`);
  if (hasCue) reasons.push("包含说话动作词");
  if (hasQuotative) reasons.push("引用式「と、Xは」");
  if (candidates.length) reasons.push(`提取候选：${candidates.join("、")}`);
  if (/^[\s\u3000]*[A-Za-z\u3040-\u30ff\u3400-\u9fff]{1,16}[，,、:：]/u.test(text)) reasons.push("疑似称谓开头");
  return { text, candidates, hasCue, hasQuotative, reasons };
}

function scoreContextUnit(item = {}, index = 0, targetIndex = 0) {
  const target = item.relation === "target" || index === targetIndex;
  const distance = Math.abs(index - targetIndex);
  const signals = contextSignals(item, distance, target);
  if (target) {
    return {
      id: item.id || `context-${index + 1}`,
      text: signals.text,
      relation: item.relation || "target",
      distance: 0,
      weight: 1,
      reasons: signals.reasons,
      candidates: [],
      hasCue: false,
      hasQuotative: false,
    };
  }

  let weight = 0.52 / Math.max(1, distance);
  if (index < targetIndex) weight += 0.08;
  if (signals.hasCue) weight += 0.28;
  if (signals.hasQuotative) weight += 0.26;
  if (signals.candidates.length) weight += 0.18;
  if (item.isQuotedDialogue) weight += 0.05;
  return {
    id: item.id || `context-${index + 1}`,
    text: signals.text,
    relation: item.relation || "context",
    distance,
    weight: Number(clamp(weight).toFixed(4)),
    reasons: signals.reasons,
    candidates: signals.candidates,
    hasCue: signals.hasCue,
    hasQuotative: signals.hasQuotative,
  };
}

function buildSpeakerAttention(row = {}, options = {}) {
  const context = Array.isArray(options.context) ? options.context : (Array.isArray(row.context) ? row.context : []);
  const maxItems = Math.max(2, Math.min(8, Number(options.maxItems) || 5));
  // 没有显式 target 的调用方仍然可能提供上下文；不要把第一条叙述
  // 错当成目标发话，否则它会获得满权重并污染候选人排序。
  const targetIndex = context.findIndex((item) => item.relation === "target");
  const scored = context.map((item, index) => scoreContextUnit(item, index, targetIndex));
  const target = scored.find((item) => item.relation === "target") || {
    id: row.id || "target",
    text: normalize(row.sourceText || ""),
    relation: "target",
    distance: 0,
    weight: 1,
    reasons: ["目标发话"],
    candidates: [],
  };
  const selected = [target, ...scored
    .filter((item) => item.id !== target.id)
    .sort((left, right) => right.weight - left.weight || left.distance - right.distance)
    .slice(0, maxItems - 1)]
    .sort((left, right) => (left.distance - right.distance) || (left.relation === "target" ? -1 : 1));
  const candidateMap = new Map();
  for (const item of selected) {
    for (const candidate of item.candidates) {
      const current = candidateMap.get(candidate) || { name: candidate, score: 0, evidenceIds: [] };
      current.score += item.weight * (item.relation === "target" ? 0 : 1);
      if (!current.evidenceIds.includes(item.id)) current.evidenceIds.push(item.id);
      candidateMap.set(candidate, current);
    }
  }
  const candidates = [...candidateMap.values()]
    .map((candidate) => ({ ...candidate, score: Number(clamp(candidate.score / Math.max(1, selected.length - 1)).toFixed(4)) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);
  const alignmentScore = Number(row.alignment?.score);
  const alignmentSignal = Number.isFinite(alignmentScore) ? clamp(alignmentScore) : 0.5;
  const contextItems = selected.slice(1);
  // 证据分数取决于临近叙述单元中实际带有发话动词、引用形式「と」
  // 或具名候选人的数量，以及它们的邻近程度。
  // 临近文本全是不相关叙述的行会保持在低分；具有明确归属证据的行
  // 则会提升至中分/高分。
  const strongItemIds = new Set();
  for (const item of contextItems) {
    if (item.hasCue || item.hasQuotative || item.candidates.length) strongItemIds.add(item.id);
  }
  const strongCount = strongItemIds.size;
  const candidateCount = contextItems.filter((item) => item.candidates.length).length;
  const nearestStrong = contextItems
    .filter((item) => strongItemIds.has(item.id))
    .reduce((nearest, item) => Math.min(nearest, item.distance), Infinity);
  let evidenceScore = 0;
  if (contextItems.length) {
    evidenceScore = 0.30
      + Math.min(0.5, strongCount * 0.17)
      + (nearestStrong === 1 ? 0.06 : 0)
      + (candidateCount ? 0.04 : 0);
  }
  evidenceScore = clamp(evidenceScore);
  // 候选人的存在是最强的单一信号，因此即使是较弱的候选人也能拉高分数；
  // 其强度随后会缩放此分数。在没有任何具名候选人的情况下，
  // 仅凭发话动词上下文该行仍可达到“medium（中）”。
  const candidateSignal = candidates.length
    ? clamp(0.34 + candidates[0].score * 1.1)
    : 0;
  const score = clamp(evidenceScore * 0.62 + candidateSignal * 0.28 + alignmentSignal * 0.10);
  const level = score >= 0.58 ? "high" : (score >= 0.34 ? "medium" : "low");
  const beforeChars = context.reduce((sum, item) => sum + normalize(item.text).length, 0);
  const afterChars = selected.reduce((sum, item) => sum + item.text.length, 0);
  return {
    version: ATTENTION_VERSION,
    score: Number(score.toFixed(4)),
    level,
    focus: selected,
    candidates,
    needsMoreContext: !candidates.length && level === "low",
    budget: {
      inputItems: context.length,
      selectedItems: selected.length,
      inputChars: beforeChars,
      selectedChars: afterChars,
      reduction: beforeChars ? Number((1 - afterChars / beforeChars).toFixed(4)) : 0,
    },
  };
}

function buildSpeakerPrompt(row = {}, options = {}) {
  const attention = options.attention || buildSpeakerAttention(row, options);
  const mode = options.mode || (normalize(row.parallelText || "") ? "bilingual" : "monolingual");
  const contract = speakerPromptFor(mode);
  const system = options.customSystem
    ? buildSpeakerSystemPrompt({ mode, customSystem: options.customSystem })
    : contract.system;
  const payload = {
    task: "speaker-attribution",
    mode,
    attentionVersion: attention.version,
    outputSchema: contract.outputSchema,
    target: {
      index: row.index,
      sourceText: normalize(row.sourceText || ""),
      ...(mode === "bilingual" || normalize(row.parallelText || "")
        ? { parallelText: normalize(row.parallelText || "") }
        : {}),
    },
    attention: {
      level: attention.level,
      score: attention.score,
      candidates: attention.candidates,
      focusedContext: attention.focus,
      needsMoreContext: attention.needsMoreContext,
    },
    ...(mode === "bilingual"
      ? {
          alignment: {
            status: row.alignment?.status || "",
            relation: row.alignment?.relation || "",
            score: row.alignment?.score ?? null,
            comparison: row.comparison || null,
          },
        }
      : {}),
  };
  const user = JSON.stringify(payload, null, 2);
  return {
    version: SPEAKER_PROMPT_VERSION,
    mode,
    system,
    user,
    messages: [
      createSystemMessage(system, system.length),
      { role: "user", content: user },
    ],
    text: `${system}\n\n${user}`,
  };
}

function buildAttentionPlan(rows = [], options = {}) {
  const levelRank = { high: 0, medium: 1, low: 2 };
  const ordered = rows
    .map((row, index) => ({
      index: row.index || index + 1,
      level: row.attention?.level || "low",
      score: Number(row.attention?.score) || 0,
      needsMoreContext: Boolean(row.attention?.needsMoreContext),
      promptChars: buildSpeakerPrompt(row, { attention: row.attention }).user.length,
    }))
    .sort((left, right) => (levelRank[left.level] - levelRank[right.level]) || right.score - left.score || left.index - right.index);
  const counts = ordered.reduce((result, item) => {
    result[item.level] = (result[item.level] || 0) + 1;
    if (item.needsMoreContext) result.needsMoreContext += 1;
    return result;
  }, { high: 0, medium: 0, low: 0, needsMoreContext: 0 });
  const maxRows = Math.max(1, Math.min(5000, Number(options.maxRows) || ordered.length));
  const queue = ordered.slice(0, maxRows);
  return {
    version: ATTENTION_VERSION,
    strategy: "evidence-priority-v1",
    counts,
    queue: queue.map((item) => item.index),
    queued: queue.length,
    totalPromptChars: queue.reduce((sum, item) => sum + item.promptChars, 0),
  };
}

module.exports = {
  ATTENTION_VERSION,
  SPEAKER_PROMPT_VERSION,
  buildSpeakerAttention,
  buildAttentionPlan,
  buildSpeakerPrompt,
  buildSpeakerSystemPrompt,
  extractCandidateNames,
  scoreContextUnit,
  speakerPrompt,
  speakerPromptFor,
};
