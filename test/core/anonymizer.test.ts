import { describe, it, expect } from 'vitest';
import { Anonymizer } from '../../src/core/anonymizer.js';

describe('Anonymizer', () => {
  it('should anonymize responses with labels A, B, C', () => {
    const anonymizer = new Anonymizer();
    const responses = [
      { agentIndex: 0, content: 'Response from first agent' },
      { agentIndex: 1, content: 'Response from second agent' },
      { agentIndex: 2, content: 'Response from third agent' },
    ];

    const anonymized = anonymizer.anonymize(responses);

    expect(anonymized).toHaveLength(3);
    // Labels should be A, B, C
    const labels = anonymized.map(a => a.label).sort();
    expect(labels).toEqual(['A', 'B', 'C']);
  });

  it('should remove model self-identification (Layer 1)', () => {
    const anonymizer = new Anonymizer();
    const responses = [
      { agentIndex: 0, content: "I'm Claude and I think Redis is great." },
      { agentIndex: 1, content: "As an AI assistant created by Google, here's my view." },
    ];

    const anonymized = anonymizer.anonymize(responses);

    for (const a of anonymized) {
      expect(a.content).not.toContain("I'm Claude");
      expect(a.content).not.toContain('created by Google');
    }
  });

  it('should normalize formatting (Layer 3)', () => {
    const anonymizer = new Anonymizer();
    const responses = [
      { agentIndex: 0, content: '# Big Heading\n* item 1\n* item 2' },
    ];

    const anonymized = anonymizer.anonymize(responses);
    // Headings should be normalized to ###
    expect(anonymized[0]!.content).toContain('### ');
    // List markers should be normalized to -
    expect(anonymized[0]!.content).toContain('- item');
  });

  it('should shuffle responses (Layer 2)', () => {
    const anonymizer = new Anonymizer();
    const responses = Array.from({ length: 10 }, (_, i) => ({
      agentIndex: i,
      content: `Response ${i}`,
    }));

    // Run multiple times and check that order changes at least once
    const orders: number[][] = [];
    for (let i = 0; i < 10; i++) {
      const anonymized = anonymizer.anonymize(responses);
      orders.push(anonymized.map(a => a.original_agent_index));
    }

    // At least some orderings should differ from identity
    const identity = Array.from({ length: 10 }, (_, i) => i);
    const allIdentical = orders.every(
      o => o.every((v, i) => v === identity[i]),
    );
    expect(allIdentical).toBe(false);
  });

  it('should maintain deanonymization mapping', () => {
    const anonymizer = new Anonymizer();
    const responses = [
      { agentIndex: 0, content: 'Response A' },
      { agentIndex: 1, content: 'Response B' },
    ];

    const anonymized = anonymizer.anonymize(responses);
    const agents = [
      { agent_id: 'agent-0' },
      { agent_id: 'agent-1' },
    ];

    const mapping = anonymizer.deanonymize(anonymized, agents);
    expect(mapping.size).toBe(2);
    // Each label should map to a valid agent_id
    for (const [_, agentId] of mapping) {
      expect(['agent-0', 'agent-1']).toContain(agentId);
    }
  });
});
