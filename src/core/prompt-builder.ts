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

  prompt += `Please provide your analysis from the perspective of "${role}". `;
  prompt += `Be thorough, specific, and support your points with evidence or examples.`;

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
