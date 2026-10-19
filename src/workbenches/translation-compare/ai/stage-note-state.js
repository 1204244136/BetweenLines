// 同一份纯函数同时供服务端队列和页面统计使用；工厂可直接序列化进快照。
function createStageNoteTools() {
  const marker = /^\[(AI校对|规则预筛|相似度预筛|对照表)\]/;
  const fieldHeader = /^(?:语义是否相同|是否需要修改|快速直通|Gatekeeper初审|(?:初审|复审|仲裁)(?:改案|建议)|修改结果|修改后|修改后文本|质量评分|评分|翻译得分|质量分级|质量等级|分级|严重程度|问题严重程度|建议改法|分析|原因|问题|分析过程|说话人|格式自动规范化|低分归因|线上查证|标点自动规范化)[：:]|^(?:Stylist复审|Arbiter仲裁)(?:\[.*?\])?：|^(?:(?:Stylist复审|文学复审|Arbiter仲裁|终审仲裁)调用(?:失败|异常)|调用失败|调用异常)[：:]|^调用失败（|^校对已终止[。：]/;

  function splitNoteFields(value) {
    const fields = [];
    const lines = String(value || "").split(/(\r?\n)/);
    let current = "";
    let multiline = false;
    for (let index = 0; index < lines.length; index += 2) {
      const line = lines[index];
      if (marker.test(line.trim()) || fieldHeader.test(line.trim())) {
        if (current.trim()) fields.push(current.trim());
        current = line;
        multiline = /^(?:Gatekeeper初审|(?:初审|复审|仲裁)(?:改案|建议)|修改结果|修改后|修改后文本|建议改法|分析|原因|问题|分析过程|格式自动规范化|低分归因|线上查证|标点自动规范化)：|^(?:Stylist复审|Arbiter仲裁)(?:\[.*?\])?：/.test(line.trim());
      } else if (line.trim() && !multiline) {
        if (current.trim()) fields.push(current.trim());
        current = line;
        multiline = true;
      } else {
        current += line;
      }
      current += lines[index + 1] || "";
    }
    if (current.trim()) fields.push(current.trim());
    return fields;
  }

  function splitAiNoteParts(value) {
    const text = String(value || "");
    const chunks = [];
    let offset = 0;
    for (const [index, piece] of text.split(/(\r?\n(?:[ \t]*\r?\n)+)/).entries()) {
      if (index % 2 === 0 && piece.trim()) {
        chunks.push({ start: offset + piece.length - piece.trimStart().length,
          end: offset + piece.trimEnd().length, text: piece.trim() });
      }
      offset += piece.length;
    }
    const parts = [];
    for (let index = 0; index < chunks.length; index += 1) {
      if (!chunks[index].text.startsWith("[AI校对]")) {
        parts.push(chunks[index].text);
        continue;
      }
      let limit = index + 1;
      while (limit < chunks.length && !marker.test(chunks[limit].text)) limit += 1;
      let end = index;
      for (let next = index + 1; next < limit; next += 1) {
        if (chunks[next].text.split(/\r?\n/).some((line) => fieldHeader.test(line.trim()))) end = next;
      }
      const start = chunks[index].start;
      const note = text.slice(start, chunks[end].end);
      const fields = splitNoteFields(note);
      const last = fields.at(-1) || "";
      if (/^(修改结果|修改后|修改后文本)：/.test(last)) {
        const valueStart = start + note.lastIndexOf(last) + last.indexOf("：") + 1;
        const normalize = (value) => value.trim().replace(/\r\n/g, "\n");
        const revision = normalize(text.slice(valueStart, chunks[end].end));
        const candidates = fields.slice(0, -1).filter((field) => /^(初审|复审|仲裁)(改案|建议)：/.test(field))
          .map((field) => normalize(field.slice(field.indexOf("：") + 1)))
          .filter((candidate) => candidate.startsWith(revision + "\n"));
        // 旧备注的末尾改案没有结束标记，只收齐与独立阶段改案完全一致的续段。
        // 未匹配的尾文仍是人工备注，不能混入可写回正文。
        for (let next = end + 1; candidates.length && next < limit; next += 1) {
          const expanded = normalize(text.slice(valueStart, chunks[next].end));
          if (candidates.includes(expanded)) {
            end = next;
            break;
          }
          if (!candidates.some((candidate) => candidate.startsWith(expanded + "\n"))) break;
        }
      }
      parts.push(text.slice(start, chunks[end].end));
      index = end;
    }
    return parts;
  }

  function latestAiNotePart(value) {
    const text = String(value || "");
    const parts = splitAiNoteParts(text);
    const aiParts = parts.filter((part) => part.startsWith("[AI校对]"));
    return aiParts.length ? aiParts[aiParts.length - 1] : text;
  }

  function stageNoteState(value) {
    const text = latestAiNotePart(value).trim();
    const lines = splitNoteFields(text);
    const automated = /^\[(AI校对|规则预筛|相似度预筛|对照表)\]/.test(lines[0] || "");
    const field = (name) => lines.find((line) => line.startsWith(name + "："))?.slice(name.length + 1).trim() || "";
    const modify = field("是否需要修改");
    const stage1 = field("Gatekeeper初审");
    const stage1Revision = field("初审改案") || field("初审建议");
    const stage2Revision = field("复审改案") || field("复审建议");
    const revision = field("修改结果");
    const stage2 = lines.map((line) => line.match(/^Stylist复审(?:\[(.*?)\])?：([\s\S]*)$/)).find(Boolean);
    const stage3 = lines.map((line) => line.match(/^Arbiter仲裁(?:\[(.*?)\])?：([\s\S]*)$/)).find(Boolean);
    // 下游失败保留上一阶段结论，不能把整行当成没有初审结果的失败行。
    const errors = {};
    for (const line of lines[0]?.startsWith("[AI校对]") ? lines.slice(1) : []) {
      if (/^(Stylist复审|文学复审)调用(?:失败|异常)[：:]/.test(line)) errors.stage2 = line;
      else if (/^(Arbiter仲裁|终审仲裁)调用(?:失败|异常)[：:]/.test(line)) errors.stage3 = line;
      else if (/^(调用失败|调用异常|校对已终止[。：])/.test(line)) errors.stage1 = line;
    }
    const failed = Boolean(errors.stage1) || (Object.keys(errors).length > 0 &&
      !Boolean(modify || stage1 || stage1Revision || stage2 || stage3));
    const decisionText = lines.filter((line) => !Object.values(errors).includes(line)).join("\n");
    const candidate = automated && !failed && Boolean(modify === "是" || stage1Revision ||
      (stage1 && !stage1.includes("无需修改") && /修改|建议/.test(stage1)) ||
      /存疑/.test(stage1) || modify === "待终审" || modify === "待人工确认" || modify === "人工确认" ||
      /存疑转人工|初审存疑/.test(decisionText));
    // 单独的阶段名不是完成证据；必须有明确结论或对应阶段的改案。
    const reviewed = automated && !failed && !errors.stage2 && Boolean(stage2 && (
      /^(采纳|调整|驳回|提交仲裁|升级仲裁|保留原译|复审方案|accept|modify|reject|escalate)$/.test(stage2[1] || "") ||
      stage2Revision || revision || stage3
    ));
    const arbitrated = automated && !failed && !errors.stage2 && !errors.stage3 && Boolean(stage3);
    const diverged = reviewed && Boolean(
      modify === "待终审" ||
      /调整|驳回|仲裁|^(modify|reject|escalate)$/.test(stage2[1] || "") ||
      /提交仲裁|分歧|escalate/.test(decisionText) ||
      (stage1Revision && stage2Revision && stage1Revision !== stage2Revision)
    );
    return { text, candidate, reviewed, arbitrated, diverged, failed, errors,
      pendingReview: candidate && !reviewed && !arbitrated,
      pendingArbitration: diverged && !arbitrated };
  }

  return { latestAiNotePart, stageNoteState, splitAiNoteParts, splitNoteFields };
}

module.exports = { createStageNoteTools, ...createStageNoteTools() };
