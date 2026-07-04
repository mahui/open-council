import { describe, it, expect } from 'vitest';
import { detectLanguage } from '../../src/core/language.js';

describe('detectLanguage', () => {
  it('detects pure Chinese text as 中文', () => {
    expect(detectLanguage('这是一个关于系统架构设计的问题')).toBe('中文');
  });

  it('detects pure English text as English', () => {
    expect(detectLanguage('What is the best way to design a scalable system?')).toBe('English');
  });

  it('detects a mixed Chinese/English question dominated by Chinese as 中文', () => {
    expect(detectLanguage('这个 API 应该如何设计才能兼顾扩展性和维护性')).toBe('中文');
  });

  it('detects a mostly-English question with a few Chinese words as English', () => {
    // Only "缓存" (2 CJK chars) among a much longer English sentence — well under 10%.
    expect(detectLanguage(
      'Should we use Redis for 缓存 in this high-throughput distributed system architecture?',
    )).toBe('English');
  });

  it('treats Japanese kana as CJK per the documented heuristic', () => {
    // Pure hiragana — the regex explicitly includes the Hiragana/Katakana ranges.
    expect(detectLanguage('こんにちは')).toBe('中文');
  });

  it('falls back to English for empty input', () => {
    expect(detectLanguage('')).toBe('English');
  });

  it('falls back to English for text with no letters at all (numbers/punctuation)', () => {
    expect(detectLanguage('1234567890 !@#$%^&*()')).toBe('English');
  });

  it('stays English exactly at the 10% CJK boundary (strict > required)', () => {
    // 1 CJK char out of 10 total chars = exactly 10% — the check is `>`, not `>=`.
    const text = '你' + 'a'.repeat(9);
    expect(text.length).toBe(10);
    expect(detectLanguage(text)).toBe('English');
  });

  it('switches to 中文 just above the 10% CJK boundary', () => {
    // 2 CJK chars out of 10 total chars = 20%, clearing the strict `>` threshold.
    const text = '你你' + 'a'.repeat(8);
    expect(text.length).toBe(10);
    expect(detectLanguage(text)).toBe('中文');
  });
});
