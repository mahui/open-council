import { describe, it, expect } from 'vitest';
import {
  compressResponses,
  compressResponsesLegacy,
  needsCompression,
  extractCodeBlocks,
  restoreCodeBlocks,
  truncateWithMarker,
  buildCompressionPlan,
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

  it('should return empty array for empty input', () => {
    expect(compressResponsesLegacy([])).toEqual([]);
  });
});
