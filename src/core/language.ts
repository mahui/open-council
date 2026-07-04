/**
 * Shared language detection for prompt building.
 * Pure logic — no I/O dependencies (ARCH-01).
 *
 * Used by role-generator and prompt-builder so that every phase's prompt can
 * instruct the model to respond in the same language as the user's question.
 */

/**
 * Detect the dominant language of a piece of text.
 * Returns a human-readable language name suitable for embedding directly in a
 * prompt instruction (e.g. "Respond in 中文").
 *
 * Heuristic: if more than 10% of characters are CJK (Chinese/Japanese kana),
 * treat the text as 中文; otherwise default to English.
 */
export function detectLanguage(text: string): string {
  const cjk = text.match(/[一-鿿぀-ゟ゠-ヿ]/g);
  if (cjk && cjk.length > text.length * 0.1) return '中文';
  return 'English';
}
