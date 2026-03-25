/**
 * Pre-Synthesis Compression: "core preserve + periphery summarize" strategy.
 * Pure logic -- no I/O dependencies (ARCH-01).
 * No imports from providers, storage, ui, commands (ARCH-02).
 *
 * Design (PRD Phase 3.5):
 * - Triggered when total response length exceeds Chairman context threshold.
 * - Top 1-2 responses (by review score, or model priority for compare mode)
 *   are preserved in full text.
 * - Remaining responses get structural summaries.
 * - Code blocks (fenced with ```) are always preserved verbatim.
 * - Fallback: when LLM summarization is unavailable, truncate with
 *   head/tail line preservation.
 */

import type { ParsedReview } from './score-parser.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A response annotated with metadata for ranking. */
export interface ScoredResponse {
  readonly agentId: string;
  readonly modelName: string;
  readonly role: string;
  readonly content: string;
  /** Aggregate review score (higher = better). Undefined when no review data. */
  readonly reviewScore: number | undefined;
  /** Model priority from config (lower number = higher priority). */
  readonly modelPriority: number;
}

/** Classification of how a response should be treated during compression. */
export type CompressionAction = 'preserve' | 'summarize';

export interface CompressionPlanEntry {
  readonly agentId: string;
  readonly modelName: string;
  readonly role: string;
  readonly action: CompressionAction;
  readonly content: string;
}

export interface CompressionPlan {
  readonly entries: readonly CompressionPlanEntry[];
  readonly totalInputChars: number;
  readonly preservedChars: number;
  readonly triggered: boolean;
  readonly reason: string;
}

export interface CompressedResponse {
  readonly agentId: string;
  readonly modelName: string;
  readonly role: string;
  readonly content: string;
  readonly wasCompressed: boolean;
  readonly originalLength: number;
  readonly compressedLength: number;
}

export interface CompressionResult {
  readonly responses: readonly CompressedResponse[];
  readonly triggered: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Legacy interface (kept for backward compatibility with existing callers)
// ---------------------------------------------------------------------------

export interface LegacyCompressedResponse {
  agentIndex: number;
  original: string;
  compressed: string;
  was_compressed: boolean;
  original_length: number;
  compressed_length: number;
}

// ---------------------------------------------------------------------------
// Code block extraction and preservation
// ---------------------------------------------------------------------------

interface CodeBlock {
  readonly placeholder: string;
  readonly content: string;
}

/**
 * Extract fenced code blocks from text, replacing them with placeholders.
 * Code blocks are preserved verbatim during compression (PRD requirement).
 */
export function extractCodeBlocks(text: string): {
  text: string;
  blocks: readonly CodeBlock[];
} {
  const blocks: CodeBlock[] = [];
  let index = 0;

  const processed = text.replace(
    /```[\s\S]*?```/g,
    (match) => {
      const placeholder = `__CODE_BLOCK_${index}__`;
      blocks.push({ placeholder, content: match });
      index++;
      return placeholder;
    },
  );

  return { text: processed, blocks };
}

/**
 * Reinsert code blocks into text by replacing placeholders with original content.
 */
export function restoreCodeBlocks(
  text: string,
  blocks: readonly CodeBlock[],
): string {
  let result = text;
  for (const block of blocks) {
    result = result.replace(block.placeholder, block.content);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Threshold detection
// ---------------------------------------------------------------------------

/**
 * Determine whether compression should be triggered.
 *
 * @param responseLengths - Character lengths of each response
 * @param thresholdRatio - Ratio of context window that triggers compression (default 0.6)
 * @param contextWindowChars - Estimated context window in characters (default 100000,
 *   roughly ~25k tokens for mixed content)
 */
export function needsCompression(
  responseLengths: readonly number[],
  thresholdRatio: number = 0.6,
  contextWindowChars: number = 100_000,
): boolean {
  const total = responseLengths.reduce((sum, l) => sum + l, 0);
  return total > thresholdRatio * contextWindowChars;
}

// ---------------------------------------------------------------------------
// Review score aggregation
// ---------------------------------------------------------------------------

/**
 * Compute an aggregate review score for each agent from parsed reviews.
 * Returns a map of agentId -> average overall score across all reviewers.
 *
 * When no valid reviews exist, returns an empty map. The caller should
 * fall back to model priority ranking (compare mode behavior per PRD).
 */
export function aggregateReviewScores(
  reviews: readonly ParsedReview[],
  labelToAgentId: ReadonlyMap<string, string>,
): Map<string, number> {
  const scoreSums = new Map<string, { total: number; count: number }>();

  for (const review of reviews) {
    if (review.status === 'parse_error') continue;
    const agentId = labelToAgentId.get(review.label);
    if (!agentId) continue;

    const entry = scoreSums.get(agentId) ?? { total: 0, count: 0 };
    entry.total += review.scores.overall;
    entry.count += 1;
    scoreSums.set(agentId, entry);
  }

  const result = new Map<string, number>();
  for (const [agentId, { total, count }] of scoreSums) {
    if (count > 0) {
      result.set(agentId, total / count);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Compression plan construction
// ---------------------------------------------------------------------------

/**
 * Build a compression plan: decide which responses to preserve and which to summarize.
 *
 * Ranking criteria (PRD Phase 3.5):
 * 1. If review scores available (debate mode): sort by review score descending.
 * 2. If no review scores (compare mode): sort by model priority ascending (lower = better).
 *
 * @param preserveTopN - Number of top responses to preserve in full (default 2).
 */
export function buildCompressionPlan(
  responses: readonly ScoredResponse[],
  thresholdRatio: number = 0.6,
  contextWindowChars: number = 100_000,
  preserveTopN: number = 2,
): CompressionPlan {
  const totalChars = responses.reduce((sum, r) => sum + r.content.length, 0);
  const threshold = thresholdRatio * contextWindowChars;

  if (totalChars <= threshold) {
    return {
      entries: responses.map(r => ({
        agentId: r.agentId,
        modelName: r.modelName,
        role: r.role,
        action: 'preserve' as const,
        content: r.content,
      })),
      totalInputChars: totalChars,
      preservedChars: totalChars,
      triggered: false,
      reason: `Total length ${totalChars} chars within threshold ${Math.round(threshold)} chars`,
    };
  }

  // Sort: by review score (desc) if available, else by model priority (asc)
  const hasScores = responses.some(r => r.reviewScore !== undefined);
  const sorted = [...responses].sort((a, b) => {
    if (hasScores) {
      const scoreA = a.reviewScore ?? 0;
      const scoreB = b.reviewScore ?? 0;
      return scoreB - scoreA;
    }
    return a.modelPriority - b.modelPriority;
  });

  const effectiveTopN = Math.min(preserveTopN, sorted.length);
  let preservedChars = 0;

  const entries: CompressionPlanEntry[] = sorted.map((r, i) => {
    const action: CompressionAction = i < effectiveTopN ? 'preserve' : 'summarize';
    if (action === 'preserve') {
      preservedChars += r.content.length;
    }
    return {
      agentId: r.agentId,
      modelName: r.modelName,
      role: r.role,
      action,
      content: r.content,
    };
  });

  return {
    entries,
    totalInputChars: totalChars,
    preservedChars,
    triggered: true,
    reason: `Total length ${totalChars} chars exceeds threshold ${Math.round(threshold)} chars; preserving top ${effectiveTopN}, summarizing ${sorted.length - effectiveTopN}`,
  };
}

// ---------------------------------------------------------------------------
// Summarization prompt (for LLM-based summarization via InvocationAdapter)
// ---------------------------------------------------------------------------

/**
 * Build the prompt used to ask an agent to self-summarize its response.
 * The orchestrator sends this to the respective agent's model.
 *
 * Code blocks are appended verbatim after the summarization instructions
 * so the LLM knows to preserve them exactly (PRD requirement).
 */
export function buildSummarizationPrompt(
  question: string,
  originalResponse: string,
): string {
  const { text: textWithoutCode, blocks } = extractCodeBlocks(originalResponse);

  let prompt = '';
  prompt += `[System] Please convert the following response into a structured summary:\n`;
  prompt += `1. Core arguments (3-5 key points)\n`;
  prompt += `2. Key conclusions\n`;
  prompt += `3. Differentiating points compared to other approaches\n`;
  prompt += `4. Mentioned risks or limitations\n`;
  prompt += `Preserve all specific data and key arguments. Remove transitional text and redundant reasoning.\n`;
  prompt += `IMPORTANT: Code blocks must be preserved exactly as-is. Do not summarize or truncate them.\n\n`;
  prompt += `[User]\n`;
  prompt += `Original question: ${question}\n\n`;
  prompt += `Your original response:\n${textWithoutCode}\n`;

  if (blocks.length > 0) {
    prompt += `\n[Code blocks to preserve verbatim]\n`;
    for (const block of blocks) {
      prompt += `${block.content}\n\n`;
    }
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Structural truncation fallback
// ---------------------------------------------------------------------------

/**
 * Fallback compression when LLM summarization is unavailable or fails.
 * Keeps the first N lines and last N lines, compresses middle with a marker.
 *
 * @param content - The full response text
 * @param headLines - Number of lines to keep from the beginning (default 15)
 * @param tailLines - Number of lines to keep from the end (default 10)
 */
export function truncateWithMarker(
  content: string,
  headLines: number = 15,
  tailLines: number = 10,
): string {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (totalLines <= headLines + tailLines) {
    return content;
  }

  const head = lines.slice(0, headLines);
  const tail = lines.slice(totalLines - tailLines);
  const omittedCount = totalLines - headLines - tailLines;

  return [
    ...head,
    '',
    `[... ${omittedCount} lines omitted for brevity ...]`,
    '',
    ...tail,
  ].join('\n');
}

/**
 * Extract key structural lines (headers, bullets, bold) from a block of text.
 * Used to provide a brief summary of omitted content.
 */
function extractKeyPoints(lines: readonly string[]): string {
  const keyLines = lines.filter(line => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith('#') ||
      trimmed.startsWith('-') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith('\u2022') ||
      /^\d+\./.test(trimmed) ||
      /\*\*.+\*\*/.test(trimmed)
    );
  });

  if (keyLines.length === 0) {
    return `${lines.length} lines of supporting detail`;
  }

  return keyLines
    .slice(0, 3)
    .map(l => l.trim().replace(/^[-*\u2022#]+\s*/, '').slice(0, 60))
    .join('; ');
}

/**
 * Compress a single response using structural truncation with key-point extraction.
 * Preserves code blocks intact (extracts before truncation, restores after).
 */
function compressSingleResponseFallback(
  content: string,
  headLines: number = 15,
  tailLines: number = 10,
): string {
  const { text, blocks } = extractCodeBlocks(content);
  const lines = text.split('\n');
  const totalLines = lines.length;

  if (totalLines <= headLines + tailLines) {
    return content; // Short enough already
  }

  const topLines = lines.slice(0, headLines);
  const bottomLines = lines.slice(totalLines - tailLines);
  const middleLines = lines.slice(headLines, totalLines - tailLines);
  const omittedCount = middleLines.length;
  const keyPoints = extractKeyPoints(middleLines);

  const compressed = [
    ...topLines,
    '',
    `[... ${omittedCount} lines compressed. Key points: ${keyPoints}]`,
    '',
    ...bottomLines,
  ].join('\n');

  return restoreCodeBlocks(compressed, blocks);
}

// ---------------------------------------------------------------------------
// Apply compression plan with fallback truncation
// ---------------------------------------------------------------------------

/**
 * Apply structural truncation to responses according to a compression plan.
 * This is the fallback path when LLM-based summarization is not available or fails.
 *
 * Responses marked 'preserve' are kept in full.
 * Responses marked 'summarize' are truncated with head/tail preservation + code block safety.
 */
export function applyFallbackCompression(
  plan: CompressionPlan,
  headLines: number = 15,
  tailLines: number = 10,
): CompressionResult {
  if (!plan.triggered) {
    return {
      responses: plan.entries.map(e => ({
        agentId: e.agentId,
        modelName: e.modelName,
        role: e.role,
        content: e.content,
        wasCompressed: false,
        originalLength: e.content.length,
        compressedLength: e.content.length,
      })),
      triggered: false,
      reason: plan.reason,
    };
  }

  const responses: CompressedResponse[] = plan.entries.map(entry => {
    if (entry.action === 'preserve') {
      return {
        agentId: entry.agentId,
        modelName: entry.modelName,
        role: entry.role,
        content: entry.content,
        wasCompressed: false,
        originalLength: entry.content.length,
        compressedLength: entry.content.length,
      };
    }

    const compressed = compressSingleResponseFallback(entry.content, headLines, tailLines);
    return {
      agentId: entry.agentId,
      modelName: entry.modelName,
      role: entry.role,
      content: compressed,
      wasCompressed: true,
      originalLength: entry.content.length,
      compressedLength: compressed.length,
    };
  });

  return {
    responses,
    triggered: true,
    reason: plan.reason,
  };
}

// ---------------------------------------------------------------------------
// Convenience: one-shot compression pipeline (fallback path)
// ---------------------------------------------------------------------------

/**
 * One-shot compression combining ranking, planning, and fallback truncation.
 *
 * Use this when LLM summarization is not desired or has failed for all agents.
 * For LLM-based summarization, use buildCompressionPlan() + buildSummarizationPrompt()
 * and send prompts via InvocationAdapter in the orchestrator.
 */
export function compressResponses(
  responses: readonly ScoredResponse[],
  thresholdRatio: number = 0.6,
  contextWindowChars: number = 100_000,
  preserveTopN: number = 2,
): CompressionResult {
  const plan = buildCompressionPlan(
    responses,
    thresholdRatio,
    contextWindowChars,
    preserveTopN,
  );
  return applyFallbackCompression(plan);
}

// ---------------------------------------------------------------------------
// Legacy API (backward compatibility)
// ---------------------------------------------------------------------------

/**
 * Legacy compression function matching the original simple interface.
 * Retained for backward compatibility with existing callers.
 *
 * @deprecated Use compressResponses() with ScoredResponse[] for full functionality.
 */
export function compressResponsesLegacy(
  responses: Array<{ agentIndex: number; content: string }>,
  thresholdRatio: number = 0.6,
): LegacyCompressedResponse[] {
  if (responses.length === 0) return [];

  // Calculate median length as reference
  const lengths = responses.map(r => r.content.length).sort((a, b) => a - b);
  const medianLength = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const threshold = medianLength * (1 + thresholdRatio);

  return responses.map(r => {
    if (r.content.length <= threshold) {
      return {
        agentIndex: r.agentIndex,
        original: r.content,
        compressed: r.content,
        was_compressed: false,
        original_length: r.content.length,
        compressed_length: r.content.length,
      };
    }

    const compressed = compressSingleResponseFallback(r.content);
    return {
      agentIndex: r.agentIndex,
      original: r.content,
      compressed,
      was_compressed: true,
      original_length: r.content.length,
      compressed_length: compressed.length,
    };
  });
}
