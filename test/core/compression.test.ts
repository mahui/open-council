import { describe, it, expect } from 'vitest';
import {
  compressResponses,
  compressResponsesLegacy,
  needsCompression,
  extractCodeBlocks,
  restoreCodeBlocks,
  truncateWithMarker,
  buildCompressionPlan,
  buildSummarizationPrompt,
  applyFallbackCompression,
  type ScoredResponse,
} from '../../src/core/compression.js';

describe('needsCompression', () => {
  it('should return false when total length is within threshold', () => {
    expect(needsCompression([100, 200, 300], 0.6, 10000)).toBe(false);
  });

  it('should return true when total length exceeds threshold', () => {
    expect(needsCompression([40000, 30000, 20000], 0.6, 100000)).toBe(true);
  });
});

describe('extractCodeBlocks', () => {
  it('should extract fenced code blocks', () => {
    const text = 'Before\n```js\nconst x = 1;\n```\nAfter';
    const { text: processed, blocks } = extractCodeBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(processed).toContain('__CODE_BLOCK_0__');
    expect(processed).not.toContain('const x');
    expect(blocks[0]!.content).toContain('const x = 1;');
  });
});

describe('restoreCodeBlocks', () => {
  it('should restore code blocks from placeholders', () => {
    const blocks = [{ placeholder: '__CODE_BLOCK_0__', content: '```js\ncode\n```' }];
    const result = restoreCodeBlocks('Text __CODE_BLOCK_0__ more', blocks);
    expect(result).toContain('```js\ncode\n```');
  });
});

describe('truncateWithMarker', () => {
  it('should not truncate short content', () => {
    const short = 'Line 1\nLine 2\nLine 3';
    expect(truncateWithMarker(short)).toBe(short);
  });

  it('should truncate long content with marker', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}`).join('\n');
    const result = truncateWithMarker(lines, 5, 3);
    expect(result).toContain('Line 0');
    expect(result).toContain('Line 49');
    expect(result).toContain('lines omitted');
  });
});

describe('buildCompressionPlan', () => {
  it('should not trigger compression for small inputs', () => {
    const responses: ScoredResponse[] = [
      { agentId: 'a', modelName: 'claude', role: 'analyst', content: 'Short', reviewScore: 8, modelPriority: 100 },
    ];
    const plan = buildCompressionPlan(responses, 0.6, 100000);
    expect(plan.triggered).toBe(false);
    expect(plan.entries[0]!.action).toBe('preserve');
  });

  it('should trigger compression for large inputs', () => {
    const longContent = 'x'.repeat(80000);
    const responses: ScoredResponse[] = [
      { agentId: 'a', modelName: 'claude', role: 'analyst', content: longContent, reviewScore: 9, modelPriority: 100 },
      { agentId: 'b', modelName: 'gemini', role: 'engineer', content: longContent, reviewScore: 7, modelPriority: 90 },
    ];
    const plan = buildCompressionPlan(responses, 0.6, 100000, 1);
    expect(plan.triggered).toBe(true);
    // Top 1 should be preserved, second should be summarized
    const preserved = plan.entries.filter(e => e.action === 'preserve');
    const summarized = plan.entries.filter(e => e.action === 'summarize');
    expect(preserved).toHaveLength(1);
    expect(summarized).toHaveLength(1);
  });

  it('should rank by model priority (ascending) instead of review score when no response has a review score', () => {
    const longContent = 'x'.repeat(80000);
    const responses: ScoredResponse[] = [
      { agentId: 'a', modelName: 'claude', role: 'analyst', content: longContent, reviewScore: undefined, modelPriority: 50 },
      { agentId: 'b', modelName: 'gemini', role: 'engineer', content: longContent, reviewScore: undefined, modelPriority: 10 },
    ];
    const plan = buildCompressionPlan(responses, 0.6, 100000, 1);
    expect(plan.triggered).toBe(true);
    // Lower modelPriority (10, "gemini") ranks first and is preserved; the
    // higher-priority-number ("claude", 50) is summarized instead.
    const preserved = plan.entries.find(e => e.action === 'preserve')!;
    expect(preserved.agentId).toBe('b');
  });
});

describe('compressResponses', () => {
  it('should pass through small responses unchanged', () => {
    const responses: ScoredResponse[] = [
      { agentId: 'a', modelName: 'claude', role: 'analyst', content: 'Short answer', reviewScore: undefined, modelPriority: 100 },
    ];
    const result = compressResponses(responses);
    expect(result.triggered).toBe(false);
    expect(result.responses[0]!.wasCompressed).toBe(false);
  });

  it('should compress the lowest-ranked responses and preserve the top N when triggered', () => {
    // Each response has 40 lines so head(15) + tail(10) truncation actually kicks in.
    const longLines = (marker: string) =>
      Array.from({ length: 40 }, (_, i) => `${marker} line ${i}`).join('\n');
    const responses: ScoredResponse[] = [
      { agentId: 'a', modelName: 'claude', role: 'analyst', content: 'x'.repeat(30000) + longLines('A'), reviewScore: 9, modelPriority: 100 },
      { agentId: 'b', modelName: 'gemini', role: 'engineer', content: 'x'.repeat(30000) + longLines('B'), reviewScore: 7, modelPriority: 90 },
      { agentId: 'c', modelName: 'gpt', role: 'critic', content: 'x'.repeat(30000) + longLines('C'), reviewScore: 5, modelPriority: 80 },
    ];
    const result = compressResponses(responses, 0.6, 100_000, 2);

    expect(result.triggered).toBe(true);
    const preserved = result.responses.filter(r => !r.wasCompressed);
    const summarized = result.responses.filter(r => r.wasCompressed);
    // Top 2 by review score (a, b) preserved; lowest (c) summarized.
    expect(preserved.map(r => r.agentId).sort()).toEqual(['a', 'b']);
    expect(summarized.map(r => r.agentId)).toEqual(['c']);
    expect(summarized[0]!.compressedLength).toBeLessThan(summarized[0]!.originalLength);
  });
});

describe('applyFallbackCompression', () => {
  it('should pass entries through unchanged when the plan was not triggered', () => {
    const plan = buildCompressionPlan([
      { agentId: 'a', modelName: 'claude', role: 'analyst', content: 'short', reviewScore: 8, modelPriority: 100 },
    ], 0.6, 100_000);
    const result = applyFallbackCompression(plan);
    expect(result.triggered).toBe(false);
    expect(result.responses[0]!.wasCompressed).toBe(false);
    expect(result.responses[0]!.content).toBe('short');
  });

  it('should extract key bullet points and preserve code blocks verbatim when summarizing', () => {
    const middleLines = Array.from({ length: 30 }, (_, i) => `filler detail line ${i}`);
    // Insert bullet/header markers so extractKeyPoints has real key lines to surface.
    middleLines[5] = '- Key architectural tradeoff';
    middleLines[10] = '## Important heading';
    // A code block placed in the HEAD (kept verbatim) region — code blocks that
    // fall inside the omitted *middle* region are dropped along with the rest of
    // that region, so only head/tail placement is actually "preserved".
    const head = Array.from({ length: 15 }, (_, i) => `head ${i}`);
    head[2] = '```js\nconst code = 1;\n```';
    const longContent = [
      ...head,
      ...middleLines,
      ...Array.from({ length: 10 }, (_, i) => `tail ${i}`),
    ].join('\n');

    const plan = buildCompressionPlan([
      { agentId: 'a', modelName: 'claude', role: 'analyst', content: 'x'.repeat(70000), reviewScore: 9, modelPriority: 100 },
      { agentId: 'b', modelName: 'gemini', role: 'engineer', content: longContent, reviewScore: 1, modelPriority: 90 },
    ], 0.6, 100_000, 1);
    expect(plan.triggered).toBe(true);

    const result = applyFallbackCompression(plan);
    const summarizedEntry = result.responses.find(r => r.agentId === 'b')!;
    expect(summarizedEntry.wasCompressed).toBe(true);
    expect(summarizedEntry.content).toContain('Key architectural tradeoff');
    expect(summarizedEntry.content).toContain('lines compressed');
    // The fenced code block (in the preserved head region) must survive verbatim.
    expect(summarizedEntry.content).toContain('```js\nconst code = 1;\n```');
  });
});

describe('buildSummarizationPrompt', () => {
  it('should build a summarization instruction containing the question and response', () => {
    const prompt = buildSummarizationPrompt('What is Redis?', 'Redis is an in-memory data store.');
    expect(prompt).toContain('What is Redis?');
    expect(prompt).toContain('Redis is an in-memory data store.');
    expect(prompt).toContain('Core arguments');
    expect(prompt).not.toContain('Code blocks to preserve verbatim');
  });

  it('should append extracted code blocks for verbatim preservation', () => {
    const original = 'Here is the fix:\n```ts\nconst x = 1;\n```\nThat should work.';
    const prompt = buildSummarizationPrompt('How to fix this?', original);
    expect(prompt).toContain('Code blocks to preserve verbatim');
    expect(prompt).toContain('```ts\nconst x = 1;\n```');
    expect(prompt).not.toContain('const x = 1;\n```\nThat'); // code stripped from the body text
  });
});

describe('compressResponsesLegacy', () => {
  it('should not compress short responses', () => {
    const responses = [
      { agentIndex: 0, content: 'Short response' },
      { agentIndex: 1, content: 'Another short one' },
    ];
    const result = compressResponsesLegacy(responses);
    expect(result).toHaveLength(2);
    expect(result[0]!.was_compressed).toBe(false);
  });

  it('should compress a response much longer than the median (triggering fallback truncation)', () => {
    const shortOne = 'short';
    const longLines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const responses = [
      { agentIndex: 0, content: shortOne },
      { agentIndex: 1, content: shortOne },
      { agentIndex: 2, content: longLines },
    ];
    const result = compressResponsesLegacy(responses);
    const longEntry = result.find(r => r.agentIndex === 2)!;
    expect(longEntry.was_compressed).toBe(true);
    expect(longEntry.compressed_length).toBeLessThan(longEntry.original_length);
    expect(longEntry.compressed).toContain('line 0');
    expect(longEntry.compressed).toContain('line 39');
  });

  it('should return empty array for empty input', () => {
    expect(compressResponsesLegacy([])).toEqual([]);
  });
});
