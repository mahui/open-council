/**
 * Prompt template construction for each debate phase.
 * Pure logic — no I/O dependencies (ARCH-01).
 */

export function buildBroadcastPrompt(
  question: string,
  role: string,
  systemPrompt: string,
  parentSynthesis?: string,
): string {
  let prompt = '';

  if (systemPrompt) {
    prompt += `${systemPrompt}\n\n`;
  }

  if (parentSynthesis) {
    prompt += `Previous discussion conclusion:\n${parentSynthesis}\n\n`;
    prompt += `Follow-up question: ${question}\n\n`;
  } else {
    prompt += `Question: ${question}\n\n`;
  }

  prompt += `You are participating in a multi-model debate as the "${role}". `;
  prompt += `Provide a thorough, detailed analysis (at least several paragraphs). `;
  prompt += `Be specific, use evidence or examples, and structure your response with clear sections. `;
  prompt += `Do NOT use any tools or run any commands — just provide your written analysis directly.`;

  return prompt;
}

export function buildSynthesisPrompt(
  question: string,
  responses: Array<{ role: string; modelName: string; response: string }>,
): string {
  let prompt = `You are the Chairman synthesizing multiple expert perspectives on a question.\n\n`;
  prompt += `Original question: ${question}\n\n`;
  prompt += `The following experts have provided their analyses:\n\n`;

  for (const [i, r] of responses.entries()) {
    prompt += `--- Expert ${i + 1} (${r.role}) ---\n`;
    prompt += `${r.response}\n\n`;
  }

  prompt += `As Chairman, please:\n`;
  prompt += `1. Synthesize the key insights from all experts\n`;
  prompt += `2. Identify points of agreement and disagreement\n`;
  prompt += `3. Provide a balanced, comprehensive conclusion\n`;
  prompt += `4. Note any important caveats or limitations\n`;
  prompt += `\nProvide a clear, well-structured synthesis.`;

  return prompt;
}

export function buildReviewPrompt(
  question: string,
  anonymizedResponses: Array<{ label: string; content: string }>,
): string {
  let prompt = `You are a peer reviewer evaluating anonymous responses to a question.\n\n`;
  prompt += `Original question: ${question}\n\n`;
  prompt += `Please review each response and provide scores.\n\n`;

  for (const r of anonymizedResponses) {
    prompt += `--- Response ${r.label} ---\n`;
    prompt += `${r.content}\n\n`;
  }

  prompt += `For each response, provide a JSON evaluation:\n`;
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
