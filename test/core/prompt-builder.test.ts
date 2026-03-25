import { describe, it, expect } from 'vitest';
import { buildBroadcastPrompt, buildSynthesisPrompt, buildReviewPrompt } from '../../src/core/prompt-builder.js';

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
