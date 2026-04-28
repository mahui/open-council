/**
 * Prompt template construction for each debate phase.
 * Pure logic — no I/O dependencies (ARCH-01).
 */

export function buildBroadcastPrompt(
  question: string,
  role: string,
  systemPrompt: string,
  parentSynthesis?: string,
  historicalContext?: string,
): string {
  let prompt = '';

  if (systemPrompt) {
    prompt += `${systemPrompt}\n\n`;
  }

  // Background context from similar past debates (injected automatically when available)
  if (historicalContext) {
    prompt += `=== Background: related past discussions ===\n`;
    prompt += historicalContext;
    prompt += `\n=== End of background ===\n\n`;
    prompt += `Use the above as background context. Provide your own fresh analysis for the current question.\n\n`;
  }

  if (parentSynthesis) {
    prompt += `Previous discussion conclusion:\n${parentSynthesis}\n\n`;
    prompt += `Follow-up question: ${question}\n\n`;
  } else {
    prompt += `Question: ${question}\n\n`;
  }

  prompt += `You are participating in a multi-model debate as the "${role}".\n`;
  prompt += `Structure your response using the following sections — this structure helps peer reviewers compare responses fairly:\n\n`;

  prompt += `## Position\n`;
  prompt += `State your core claim in 1–2 sentences.\n\n`;

  prompt += `## Evidence\n`;
  prompt += `Provide 3–5 concrete supporting points. Be specific — use data, examples, or established principles.\n\n`;

  prompt += `## Strongest Counter-argument\n`;
  prompt += `State the most compelling objection to your position, then give your rebuttal.\n\n`;

  prompt += `## Confidence\n`;
  prompt += `Rate your confidence: High / Medium / Low. Explain what drives this rating and what evidence would change your mind.\n\n`;

  prompt += `## Conclusion\n`;
  prompt += `Give a clear, actionable recommendation or key takeaway.\n\n`;

  prompt += `Do NOT use any tools or run any commands — provide your written analysis directly.`;

  return prompt;
}

export function buildSynthesisPrompt(
  question: string,
  responses: Array<{ role: string; modelName: string; response: string }>,
): string {
  let prompt = `You are the Chairman synthesizing multiple expert perspectives on a question.\n\n`;
  prompt += `Original question: ${question}\n\n`;
  prompt += `Expert responses (each structured as Position / Evidence / Counter-argument / Confidence / Conclusion):\n\n`;

  for (const [i, r] of responses.entries()) {
    prompt += `--- Expert ${i + 1} (${r.role}) ---\n`;
    prompt += `${r.response}\n\n`;
  }

  prompt += `As Chairman, synthesize these perspectives by:\n`;
  prompt += `1. Identifying where experts' **Positions** converge and diverge\n`;
  prompt += `2. Evaluating the strength of **Evidence** across responses — note what's well-supported vs. asserted\n`;
  prompt += `3. Weighing shared **Counter-arguments** seriously — recurring objections deserve explicit acknowledgment\n`;
  prompt += `4. Calibrating overall confidence from experts' stated confidence levels\n`;
  prompt += `5. Producing a **unified Conclusion** that is more complete than any single expert's view\n\n`;
  prompt += `Provide a clear, well-structured synthesis.`;

  return prompt;
}

export function buildReviewPrompt(
  question: string,
  anonymizedResponses: Array<{ label: string; content: string }>,
): string {
  let prompt = `You are a peer reviewer evaluating anonymous responses to a question.\n\n`;
  prompt += `Original question: ${question}\n\n`;
  prompt += `Responses use a structured format: Position / Evidence / Strongest Counter-argument / Confidence / Conclusion.\n\n`;

  for (const r of anonymizedResponses) {
    prompt += `--- Response ${r.label} ---\n`;
    prompt += `${r.content}\n\n`;
  }

  prompt += `Score each response on these dimensions (1–10):\n`;
  prompt += `- accuracy: Are the claims factually correct? Is the evidence credible and well-sourced?\n`;
  prompt += `- completeness: Are key aspects covered? Is the counter-argument honestly acknowledged?\n`;
  prompt += `- practicality: Is the conclusion actionable? Is the confidence level well-calibrated?\n`;
  prompt += `- insight: How novel and deep is the analysis? Does it surface non-obvious considerations?\n`;
  prompt += `- overall: Overall quality across all dimensions\n\n`;

  prompt += `Return this JSON:\n`;
  prompt += `{\n`;
  prompt += `  "reviews": [\n`;
  prompt += `    {\n`;
  prompt += `      "label": "A",\n`;
  prompt += `      "scores": {\n`;
  prompt += `        "accuracy": <1-10>,\n`;
  prompt += `        "completeness": <1-10>,\n`;
  prompt += `        "practicality": <1-10>,\n`;
  prompt += `        "insight": <1-10>,\n`;
  prompt += `        "overall": <1-10>\n`;
  prompt += `      },\n`;
  prompt += `      "strengths": "...",\n`;
  prompt += `      "weaknesses": "...",\n`;
  prompt += `      "ranking": <position>\n`;
  prompt += `    }\n`;
  prompt += `  ]\n`;
  prompt += `}\n`;

  return prompt;
}

/**
 * Devil's Advocate variant of the review prompt.
 * Identical to the standard review but adds critical-auditor instructions:
 * the agent must surface risks, edge cases, and unstated assumptions in addition to normal scoring.
 */
export function buildDevilAdvocateReviewPrompt(
  question: string,
  anonymizedResponses: Array<{ label: string; content: string }>,
): string {
  const base = buildReviewPrompt(question, anonymizedResponses);

  const devilAdvocateAddendum = `

[Devil's Advocate — Additional Instructions]
Beyond the standard evaluation above, you also serve as a critical auditor. For each response:
1. Actively identify unstated assumptions and potential failure modes
2. Consider edge cases, second-order effects, and what could go wrong long-term
3. Challenge conclusions that appear overly optimistic or underspecified
4. Add a "devil_advocate_notes" field to each review entry listing the key risks found

Your scores should reflect these critical concerns — penalise responses that overlook significant risks even if they are well-structured.`;

  return base + devilAdvocateAddendum;
}

export function buildCrossExaminePrompt(
  question: string,
  role: string,
  ownResponse: string,
  otherResponses: Array<{ role: string; response: string }>,
  divergencePoints: string[],
  roundNumber: number,
): string {
  let prompt = `You are participating in Round ${roundNumber + 1} of a multi-model debate.\n`;
  prompt += `Your role: "${role}"\n`;
  prompt += `Original question: ${question}\n\n`;

  prompt += `=== Your previous response ===\n${ownResponse}\n\n`;

  prompt += `=== Other experts' responses ===\n`;
  for (const other of otherResponses) {
    prompt += `--- ${other.role} ---\n${other.response}\n\n`;
  }

  if (divergencePoints.length > 0) {
    prompt += `=== Key disagreements identified ===\n`;
    for (const point of divergencePoints) {
      prompt += `• ${point}\n`;
    }
    prompt += '\n';
  }

  prompt += `Instructions for this round:\n`;
  prompt += `1. Review the other experts' perspectives and the identified disagreements\n`;
  prompt += `2. Address any valid criticisms of your position — update your view if convinced\n`;
  prompt += `3. Challenge points where you disagree — explain WHY with evidence\n`;
  prompt += `4. Identify any new common ground or nuances discovered\n`;
  prompt += `5. Provide your REVISED analysis — be specific about what changed and what held firm\n\n`;
  prompt += `Focus on the substance of disagreements, not surface-level differences. `;
  prompt += `It's OK to change your mind if the evidence warrants it.`;

  return prompt;
}

export function extractDivergencePoints(
  consensus: { dimension_scores: Record<string, { score: number; divergence: number }> },
  responses: Array<{ role: string; response: string }>,
): string[] {
  const points: string[] = [];

  for (const [dim, { divergence }] of Object.entries(consensus.dimension_scores)) {
    if (divergence > 1.5) {
      points.push(`High divergence on "${dim}" (σ=${divergence.toFixed(1)}) — experts disagree significantly`);
    }
  }

  const conclusions = responses.map(r => {
    const lines = r.response.split('\n').filter(l => l.trim());
    const lastParagraph = lines.slice(-3).join(' ');
    return { role: r.role, conclusion: lastParagraph.substring(0, 200) };
  });

  if (conclusions.length >= 2) {
    points.push(
      `Expert positions: ${conclusions.map(c => `${c.role}: "${c.conclusion.substring(0, 80)}..."`).join(' vs ')}`,
    );
  }

  return points;
}
