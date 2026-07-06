/**
 * Model-identifier matching helpers. Pure, zero-dependency string logic shared
 * by the API adapter (pi-ai registry disambiguation) and the core role-generator
 * (LLM-returned model-name resolution), so both apply the same boundary rules.
 */

/**
 * True when `prefix` is a boundary-terminated prefix of `longer`, i.e. `longer`
 * continues `prefix` with a variant/version separator rather than mid-token.
 * This keeps fuzzy matching from treating `gpt-5` and `gpt-5-mini` (or `gpt-4`
 * and `gpt-4o`) as the same model, and stops `gpt-5` from swallowing `gpt-50`.
 *
 * A boundary is: the next char is '-' or '.', OR a letter→digit transition
 * (e.g. `gpt` → `gpt4`), which marks an implicit version bump. `longer` must be
 * strictly longer than `prefix`.
 */
export function isPrefixAtBoundary(longer: string, prefix: string): boolean {
  if (prefix.length === 0 || longer.length <= prefix.length) return false;
  if (!longer.startsWith(prefix)) return false;
  const next = longer.charAt(prefix.length);
  if (next === '-' || next === '.') return true;
  const prevChar = prefix.charAt(prefix.length - 1);
  const prevIsDigit = prevChar >= '0' && prevChar <= '9';
  const nextIsDigit = next >= '0' && next <= '9';
  // A letter→digit transition is a version boundary; a digit→digit run is the same number.
  return nextIsDigit && !prevIsDigit;
}
