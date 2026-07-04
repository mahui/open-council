import { describe, it, expect } from 'vitest';
import {
  buildBroadcastPrompt,
  buildSynthesisPrompt,
  buildReviewPrompt,
  buildDevilAdvocateReviewPrompt,
  buildCrossExaminePrompt,
  extractDivergencePoints,
} from '../../src/core/prompt-builder.js';
import type { AnswerReviewSummary } from '../../src/core/review-aggregator.js';

function summary(overrides: Partial<AnswerReviewSummary>): AnswerReviewSummary {
  return {
    reviewed_agent_id: 'a1',
    role: 'Analyst',
    avg_overall: 7.5,
    strengths: [],
    weaknesses: [],
    devil_advocate_notes: [],
    reviewer_count: 2,
    ...overrides,
  };
}

describe('buildBroadcastPrompt', () => {
  it('should include question and role', () => {
    const prompt = buildBroadcastPrompt('What is Redis?', 'analyst', '');
    expect(prompt).toContain('What is Redis?');
    expect(prompt).toContain('analyst');
  });

  it('should include system prompt when provided', () => {
    const prompt = buildBroadcastPrompt('Test', 'engineer', 'You are an engineer.');
    expect(prompt).toContain('You are an engineer.');
  });

  it('should include parent synthesis for follow-up', () => {
    const prompt = buildBroadcastPrompt(
      'Can you elaborate?',
      'analyst',
      '',
      'Previous conclusion here.',
    );
    expect(prompt).toContain('Previous conclusion here.');
    expect(prompt).toContain('Follow-up question');
  });

  it('should not include follow-up context when no parent synthesis', () => {
    const prompt = buildBroadcastPrompt('Simple question', 'analyst', '');
    expect(prompt).not.toContain('Follow-up');
    expect(prompt).not.toContain('Previous');
  });

  it('uses English section headings and instructs English by default', () => {
    const prompt = buildBroadcastPrompt('What is Redis?', 'analyst', '');
    expect(prompt).toContain('## Position');
    expect(prompt).toContain('## Strongest Counter-argument');
    expect(prompt).toContain('Respond entirely in English');
  });

  it('follows the question language: Chinese headings + instruction', () => {
    const prompt = buildBroadcastPrompt('如何设计一个缓存系统？这是一个很长的中文问题需要深入分析', '分析师', '');
    expect(prompt).toContain('## 立场');
    expect(prompt).toContain('## 最强反驳');
    expect(prompt).toContain('## 结论');
    expect(prompt).toContain('Respond entirely in 中文');
  });

  it('honors an explicit language override', () => {
    const prompt = buildBroadcastPrompt('English question', 'analyst', '', undefined, undefined, '中文');
    expect(prompt).toContain('## 立场');
    expect(prompt).toContain('Respond entirely in 中文');
  });
});

describe('buildSynthesisPrompt', () => {
  it('should include all expert responses', () => {
    const responses = [
      { role: 'analyst', modelName: 'claude', response: 'Analysis A' },
      { role: 'engineer', modelName: 'gemini', response: 'Analysis B' },
    ];
    const prompt = buildSynthesisPrompt('What is Redis?', responses);
    expect(prompt).toContain('What is Redis?');
    expect(prompt).toContain('Analysis A');
    expect(prompt).toContain('Analysis B');
    expect(prompt).toContain('Expert 1');
    expect(prompt).toContain('Expert 2');
    expect(prompt).toContain('Chairman');
  });

  it('works without review summaries (backward compatible)', () => {
    const prompt = buildSynthesisPrompt('Q', [
      { role: 'analyst', modelName: 'claude', response: 'A' },
    ]);
    expect(prompt).not.toContain('Peer review of this answer');
  });

  it('includes peer-review criticism when a summary is provided', () => {
    const responses = [
      {
        role: 'analyst',
        modelName: 'claude',
        response: 'Analysis A',
        reviewSummary: summary({ avg_overall: 6.2, weaknesses: ['Ignores cost'], reviewer_count: 3 }),
      },
    ];
    const prompt = buildSynthesisPrompt('Q', responses);
    expect(prompt).toContain('Peer review of this answer');
    expect(prompt).toContain('6.2/10');
    expect(prompt).toContain('Ignores cost');
    expect(prompt).toContain('3 reviewer');
  });

  it('follows Chinese language for the synthesis instruction', () => {
    const prompt = buildSynthesisPrompt(
      '这个中文问题足够长以触发中文语言检测逻辑判断',
      [{ role: '分析师', modelName: 'claude', response: 'A' }],
    );
    expect(prompt).toContain('Respond entirely in 中文');
  });
});

describe('buildReviewPrompt language', () => {
  it('keeps JSON field names English but routes free text to the question language', () => {
    const prompt = buildReviewPrompt('这个中文问题需要足够长才能被检测为中文语言环境', [
      { label: 'A', content: 'x' },
    ]);
    expect(prompt).toContain('"strengths"');
    expect(prompt).toContain('"weaknesses"');
    expect(prompt).toContain('in 中文');
    expect(prompt).toContain('Keep all JSON field names in English');
  });
});

describe('buildDevilAdvocateReviewPrompt', () => {
  it('adds devil_advocate_notes instructions and follows language', () => {
    const prompt = buildDevilAdvocateReviewPrompt('Q', [{ label: 'A', content: 'x' }], '中文');
    expect(prompt).toContain('devil_advocate_notes');
    expect(prompt).toContain('Devil\'s Advocate');
    expect(prompt).toContain('write its value in 中文');
  });
});

describe('buildCrossExaminePrompt', () => {
  const others = [{ role: 'engineer', response: 'Engineer view' }];

  it('is backward compatible without review summaries', () => {
    const prompt = buildCrossExaminePrompt('Q', 'analyst', 'my answer', others, [], 0);
    expect(prompt).toContain('my answer');
    expect(prompt).toContain('Engineer view');
    expect(prompt).not.toContain("Peer reviewers' assessment of your answer");
  });

  it('presents the full aggregated critique of the author\'s own answer without naming reviewers', () => {
    const own = summary({
      role: 'Analyst',
      avg_overall: 5.5,
      weaknesses: ['Ignores latency', 'No fallback plan'],
      devil_advocate_notes: ['Assumes infinite budget'],
      reviewer_count: 2,
    });
    const prompt = buildCrossExaminePrompt('Q', 'analyst', 'my answer', others, [], 0, own);
    expect(prompt).toContain("Peer reviewers' assessment of your answer");
    expect(prompt).toContain('Ignores latency');
    expect(prompt).toContain('No fallback plan');
    expect(prompt).toContain('Assumes infinite budget');
    expect(prompt).toContain('reviewer identities are withheld');
    expect(prompt).not.toContain('reviewer_agent_id');
  });

  it('shows only a one-line signal for other experts\' answers', () => {
    const otherWithReview = [
      {
        role: 'engineer',
        response: 'Engineer view',
        reviewSummary: summary({ role: 'engineer', avg_overall: 8.1, weaknesses: ['Too narrow'] }),
      },
    ];
    const prompt = buildCrossExaminePrompt('Q', 'analyst', 'my answer', otherWithReview, [], 0);
    expect(prompt).toContain('8.1/10');
    expect(prompt).toContain('top critique: Too narrow');
  });

  it('requires the revised answer to keep the structured format', () => {
    const prompt = buildCrossExaminePrompt('Q', 'analyst', 'my answer', others, [], 0);
    expect(prompt).toContain('## Position');
    expect(prompt).toContain('## Evidence');
    expect(prompt).toContain('## Strongest Counter-argument');
    expect(prompt).toContain('## Confidence');
    expect(prompt).toContain('## Conclusion');
  });

  it('follows Chinese language with translated structure headings', () => {
    const prompt = buildCrossExaminePrompt('Q', 'analyst', 'my answer', others, [], 0, undefined, '中文');
    expect(prompt).toContain('## 立场');
    expect(prompt).toContain('## 结论');
    expect(prompt).toContain('Respond entirely in 中文');
  });
});

describe('extractDivergencePoints', () => {
  const consensusNoDivergence = { dimension_scores: {} };

  it('derives semantic divergence points from aggregated weaknesses', () => {
    const summaries: AnswerReviewSummary[] = [
      summary({ role: 'Analyst', weaknesses: ['Overlooks scaling limits'] }),
      summary({ role: 'Engineer', weaknesses: ['No cost analysis'] }),
    ];
    const points = extractDivergencePoints(consensusNoDivergence, [], summaries);
    expect(points.some(p => p.includes('Overlooks scaling limits'))).toBe(true);
    expect(points.some(p => p.includes('No cost analysis'))).toBe(true);
    expect(points.some(p => p.includes('Analyst'))).toBe(true);
  });

  it('keeps dimension σ as a supplementary signal', () => {
    const consensus = { dimension_scores: { accuracy: { score: 6, divergence: 2.0 } } };
    const points = extractDivergencePoints(consensus, []);
    expect(points.some(p => p.includes('High divergence on "accuracy"'))).toBe(true);
  });

  it('falls back to contrasting conclusions when no review data', () => {
    const responses = [
      { role: 'analyst', response: 'Conclusion: go with Redis' },
      { role: 'engineer', response: 'Conclusion: use Postgres' },
    ];
    const points = extractDivergencePoints(consensusNoDivergence, responses);
    expect(points.some(p => p.includes('Expert positions'))).toBe(true);
  });
});

describe('buildReviewPrompt', () => {
  it('should include anonymized responses with labels', () => {
    const responses = [
      { label: 'A', content: 'Response Alpha' },
      { label: 'B', content: 'Response Beta' },
    ];
    const prompt = buildReviewPrompt('Test question', responses);
    expect(prompt).toContain('Response A');
    expect(prompt).toContain('Response B');
    expect(prompt).toContain('Response Alpha');
    expect(prompt).toContain('Response Beta');
    expect(prompt).toContain('accuracy');
    expect(prompt).toContain('JSON');
  });
});
