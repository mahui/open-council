/**
 * Prompt template construction for each debate phase.
 * Pure logic — no I/O dependencies (ARCH-01).
 */

import { detectLanguage } from './language.js';
import type { AnswerReviewSummary } from './review-aggregator.js';

export { detectLanguage };

/**
 * Canonical structured-answer section headings, per language. Broadcast and
 * cross-examine share this so revised answers keep a format the reviewers were
 * told to expect (Position / Evidence / Strongest Counter-argument / Confidence
 * / Conclusion), only translated.
 */
interface SectionHeadings {
  position: string;
  evidence: string;
  counter: string;
  confidence: string;
  conclusion: string;
}

function sectionHeadings(language: string): SectionHeadings {
  if (language === '中文') {
    return {
      position: '立场',
      evidence: '论据',
      counter: '最强反驳',
      confidence: '置信度',
      conclusion: '结论',
    };
  }
  return {
    position: 'Position',
    evidence: 'Evidence',
    counter: 'Strongest Counter-argument',
    confidence: 'Confidence',
    conclusion: 'Conclusion',
  };
}

/** A short, structure-agnostic instruction to answer in the target language. */
function respondInLanguage(language: string): string {
  return `Respond entirely in ${language}. Write your section headings in ${language} as well.`;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function buildBroadcastPrompt(
  question: string,
  role: string,
  systemPrompt: string,
  parentSynthesis?: string,
  historicalContext?: string,
  language?: string,
): string {
  const lang = language ?? detectLanguage(question);
  const h = sectionHeadings(lang);
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

  prompt += `## ${h.position}\n`;
  prompt += `State your core claim in 1–2 sentences.\n\n`;

  prompt += `## ${h.evidence}\n`;
  prompt += `Provide 3–5 concrete supporting points. Be specific — use data, examples, or established principles.\n\n`;

  prompt += `## ${h.counter}\n`;
  prompt += `State the most compelling objection to your position, then give your rebuttal.\n\n`;

  prompt += `## ${h.confidence}\n`;
  prompt += `Rate your confidence: High / Medium / Low. Explain what drives this rating and what evidence would change your mind.\n\n`;

  prompt += `## ${h.conclusion}\n`;
  prompt += `Give a clear, actionable recommendation or key takeaway.\n\n`;

  prompt += `${respondInLanguage(lang)}\n`;
  prompt += `Do NOT use any tools or run any commands — provide your written analysis directly.`;

  return prompt;
}

export function buildSynthesisPrompt(
  question: string,
  responses: Array<{ role: string; modelName: string; response: string; reviewSummary?: AnswerReviewSummary }>,
  language?: string,
): string {
  const lang = language ?? detectLanguage(question);
  let prompt = `You are the Chairman synthesizing multiple expert perspectives on a question.\n\n`;
  prompt += `Original question: ${question}\n\n`;
  prompt += `Expert responses (each structured as Position / Evidence / Counter-argument / Confidence / Conclusion):\n\n`;

  for (const [i, r] of responses.entries()) {
    prompt += `--- Expert ${i + 1} (${r.role}) ---\n`;
    prompt += `${r.response}\n\n`;
    if (r.reviewSummary && r.reviewSummary.reviewer_count > 0) {
      const s = r.reviewSummary;
      prompt += `[Peer review of this answer — avg overall ${s.avg_overall.toFixed(1)}/10 from ${s.reviewer_count} reviewer(s)]\n`;
      if (s.weaknesses.length > 0) {
        prompt += `Key criticisms: ${s.weaknesses.map(w => truncate(w, 160)).join(' | ')}\n`;
      }
      if (s.devil_advocate_notes.length > 0) {
        prompt += `Risks flagged: ${s.devil_advocate_notes.map(n => truncate(n, 160)).join(' | ')}\n`;
      }
      prompt += '\n';
    }
  }

  prompt += `As Chairman, synthesize these perspectives by:\n`;
  prompt += `1. Identifying where experts' **Positions** converge and diverge\n`;
  prompt += `2. Evaluating the strength of **Evidence** across responses — note what's well-supported vs. asserted\n`;
  prompt += `3. Weighing shared **Counter-arguments** seriously — recurring objections deserve explicit acknowledgment\n`;
  prompt += `4. Calibrating overall confidence from experts' stated confidence levels\n`;
  prompt += `5. Weighing each answer by its peer-review reception where provided — higher-rated answers with fewer serious criticisms deserve more weight\n`;
  prompt += `6. Producing a **unified Conclusion** that is more complete than any single expert's view\n\n`;
  prompt += `${respondInLanguage(lang)}\n`;
  prompt += `Provide a clear, well-structured synthesis.`;

  return prompt;
}

export function buildReviewPrompt(
  question: string,
  anonymizedResponses: Array<{ label: string; content: string }>,
  language?: string,
): string {
  const lang = language ?? detectLanguage(question);
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
  prompt += `}\n\n`;

  // The JSON keys are a structural protocol and MUST stay in English; only the
  // free-text values (strengths/weaknesses) follow the question's language.
  prompt += `Keep all JSON field names in English exactly as shown. Write the free-text values of "strengths" and "weaknesses" in ${lang}.\n`;

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
  language?: string,
): string {
  const lang = language ?? detectLanguage(question);
  const base = buildReviewPrompt(question, anonymizedResponses, lang);

  const devilAdvocateAddendum = `

[Devil's Advocate — Additional Instructions]
Beyond the standard evaluation above, you also serve as a critical auditor. For each response:
1. Actively identify unstated assumptions and potential failure modes
2. Consider edge cases, second-order effects, and what could go wrong long-term
3. Challenge conclusions that appear overly optimistic or underspecified
4. Add a "devil_advocate_notes" field to each review entry listing the key risks found (keep the field name in English; write its value in ${lang})

Your scores should reflect these critical concerns — penalise responses that overlook significant risks even if they are well-structured.`;

  return base + devilAdvocateAddendum;
}

export function buildCrossExaminePrompt(
  question: string,
  role: string,
  ownResponse: string,
  otherResponses: Array<{ role: string; response: string; reviewSummary?: AnswerReviewSummary }>,
  divergencePoints: string[],
  roundNumber: number,
  ownReviewSummary?: AnswerReviewSummary,
  language?: string,
): string {
  const lang = language ?? detectLanguage(question);
  const h = sectionHeadings(lang);
  let prompt = `You are participating in Round ${roundNumber + 1} of a multi-model debate.\n`;
  prompt += `Your role: "${role}"\n`;
  prompt += `Original question: ${question}\n\n`;

  prompt += `=== Your previous response ===\n${ownResponse}\n\n`;

  // Full peer critique of the author's OWN answer — de-identified aggregate so
  // they can defend or revise, without revealing which reviewer said what.
  if (ownReviewSummary && ownReviewSummary.reviewer_count > 0) {
    const s = ownReviewSummary;
    prompt += `=== Peer reviewers' assessment of your answer ===\n`;
    prompt += `(Aggregated from ${s.reviewer_count} reviewer(s); reviewer identities are withheld.)\n`;
    prompt += `Average overall score: ${s.avg_overall.toFixed(1)}/10\n`;
    if (s.weaknesses.length > 0) {
      prompt += `Weaknesses raised:\n`;
      for (const w of s.weaknesses) prompt += `• ${truncate(w, 300)}\n`;
    }
    if (s.devil_advocate_notes.length > 0) {
      prompt += `Risks flagged by the critical auditor:\n`;
      for (const n of s.devil_advocate_notes) prompt += `• ${truncate(n, 300)}\n`;
    }
    prompt += '\n';
  }

  prompt += `=== Other experts' responses ===\n`;
  for (const other of otherResponses) {
    prompt += `--- ${other.role} ---\n${other.response}\n`;
    // For OTHERS' answers, only a one-line signal to avoid over-steering the
    // second round with review noise.
    if (other.reviewSummary && other.reviewSummary.reviewer_count > 0) {
      const s = other.reviewSummary;
      const topWeakness = s.weaknesses[0] ?? s.devil_advocate_notes[0];
      const critique = topWeakness ? ` · top critique: ${truncate(topWeakness, 120)}` : '';
      prompt += `[peer review: avg overall ${s.avg_overall.toFixed(1)}/10${critique}]\n`;
    }
    prompt += '\n';
  }

  if (divergencePoints.length > 0) {
    prompt += `=== Key disagreements identified ===\n`;
    for (const point of divergencePoints) {
      prompt += `• ${point}\n`;
    }
    prompt += '\n';
  }

  prompt += `Instructions for this round:\n`;
  prompt += `1. Review the peer assessment of your own answer and the other experts' perspectives\n`;
  prompt += `2. Address any valid criticisms of your position — update your view if convinced\n`;
  prompt += `3. Challenge points where you disagree — explain WHY with evidence\n`;
  prompt += `4. Identify any new common ground or nuances discovered\n`;
  prompt += `5. Provide your REVISED analysis — be specific about what changed and what held firm\n\n`;
  prompt += `Keep your revised answer in the same structured format so reviewers can compare it against the previous round:\n`;
  prompt += `## ${h.position}\n## ${h.evidence}\n## ${h.counter}\n## ${h.confidence}\n## ${h.conclusion}\n\n`;
  prompt += `Focus on the substance of disagreements, not surface-level differences. `;
  prompt += `It's OK to change your mind if the evidence warrants it.\n`;
  prompt += respondInLanguage(lang);

  return prompt;
}

/**
 * Derive human-readable divergence points for the cross-examine round.
 *
 * Primary source: aggregated peer *weaknesses* (semantic disagreements about
 * specific answers). Supplementary: dimensions with high score dispersion (σ).
 * Falls back to contrasting conclusions when neither is available.
 */
export function extractDivergencePoints(
  consensus: { dimension_scores: Record<string, { score: number; divergence: number }> },
  responses: Array<{ role: string; response: string }>,
  reviewSummaries?: readonly AnswerReviewSummary[],
): string[] {
  const points: string[] = [];

  // Primary: semantic divergence from aggregated peer critique.
  if (reviewSummaries) {
    for (const summary of reviewSummaries) {
      const critiques = [...summary.weaknesses, ...summary.devil_advocate_notes];
      if (critiques.length === 0) continue;
      points.push(`On "${summary.role}"'s answer, peers flagged: ${truncate(critiques[0]!, 200)}`);
    }
  }

  // Supplementary: dimensions where scores disperse the most.
  for (const [dim, { divergence }] of Object.entries(consensus.dimension_scores)) {
    if (divergence > 1.5) {
      points.push(`High divergence on "${dim}" (σ=${divergence.toFixed(1)}) — experts disagree significantly`);
    }
  }

  // Fallback: contrast the experts' conclusions when nothing else surfaced.
  if (points.length === 0) {
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
  }

  return points;
}
