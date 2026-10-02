// 同一份纯函数同时供服务端队列和页面统计使用；工厂可直接序列化进快照。
function createStageNoteTools() {
  function latestAiNotePart(value) {
    const text = String(value || "");
    const parts = text.split(/\r?\n(?:[ \t]*\r?\n)+/).map((part) => part.trim()).filter(Boolean);
    const aiParts = parts.filter((part) => part.startsWith("[AI校对]"));
    return aiParts.length ? aiParts[aiParts.length - 1] : text;
  }

  function stageNoteState(value) {
    const text = latestAiNotePart(value).trim();
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const automated = /^\[(AI校对|规则预筛|相似度预筛|对照表)\]/.test(lines[0] || "");
    const field = (name) => lines.find((line) => line.startsWith(name + "："))?.slice(name.length + 1).trim() || "";
    const modify = field("是否需要修改");
    const stage1 = field("Gatekeeper初审");
    const stage1Revision = field("初审改案") || field("初审建议");
    const stage2Revision = field("复审改案") || field("复审建议");
    const revision = field("修改结果");
    const stage2 = lines.map((line) => line.match(/^Stylist复审(?:\[(.*?)\])?：(.*)$/)).find(Boolean);
    const stage3 = lines.map((line) => line.match(/^Arbiter仲裁(?:\[(.*?)\])?：(.*)$/)).find(Boolean);
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
      /调整|驳回|仲裁|^(modify|reject|escalate)$/.test(stage2[1] || "") ||
      /提交仲裁|分歧|escalate/.test(decisionText) ||
      (stage1Revision && stage2Revision && stage1Revision !== stage2Revision)
    );
    return { text, candidate, reviewed, arbitrated, diverged, failed, errors,
      pendingReview: candidate && !reviewed && !arbitrated,
      pendingArbitration: diverged && !arbitrated };
  }

  return { latestAiNotePart, stageNoteState };
}

module.exports = { createStageNoteTools, ...createStageNoteTools() };
