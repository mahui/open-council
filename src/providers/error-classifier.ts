/**
 * Error classification for API invocations.
 *
 * The official SDKs throw structured error objects: `Anthropic.APIError` / `OpenAI.APIError`
 * carry a numeric `.status`, and `RateLimitError` is a dedicated 429 subclass. So status-driven
 * classification is the *primary* path — we match `instanceof APIError` first and read `.status`.
 * Free-form string/keyword matching is kept only as a fallback for non-APIError failures (a bare
 * text error from some compatibility gateway, or a raw network error object).
 */
import { APIError as AnthropicAPIError, RateLimitError as AnthropicRateLimitError } from '@anthropic-ai/sdk';
import { APIError as OpenAIAPIError, RateLimitError as OpenAIRateLimitError } from 'openai';
import type { ApiErrorClass } from '../types/provider.js';
import { InvocationTimeoutError } from '../types/errors.js';

/** Whether an error is a structured SDK APIError (either SDK). */
function isApiError(err: unknown): err is AnthropicAPIError | OpenAIAPIError {
  return err instanceof AnthropicAPIError || err instanceof OpenAIAPIError;
}

/** Network-level error codes that indicate a transient, retryable connection problem. */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * Extract a numeric HTTP status from an unknown error, checking common shapes exposed by
 * SDK error objects (Anthropic/OpenAI `.status`, others `.statusCode`, fetch-ish `.response.status`).
 * Returns undefined when no structured status is present.
 */
export function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;

  if (typeof e['status'] === 'number') return e['status'];
  if (typeof e['statusCode'] === 'number') return e['statusCode'];

  const response = e['response'];
  if (typeof response === 'object' && response !== null) {
    const rs = (response as Record<string, unknown>)['status'];
    if (typeof rs === 'number') return rs;
  }
  return undefined;
}

/**
 * Best-effort status extraction from a free-form error message. Fallback only, for gateways
 * that throw a bare text error: a bare leading code ("429 {...}") or a parenthesised code
 * ("... error (503): ...").
 */
function statusFromMessage(message: string): number | undefined {
  // Parenthesised: "(503)"
  const paren = message.match(/\((\d{3})\)/);
  if (paren?.[1]) return Number(paren[1]);
  // Leading or word-boundary 4xx/5xx: "429 {..." or "HTTP 503"
  const bare = message.match(/\b([45]\d\d)\b/);
  if (bare?.[1]) return Number(bare[1]);
  return undefined;
}

function classifyStatus(status: number): ApiErrorClass | undefined {
  if (status === 429) return 'retryable';
  if (status >= 500 && status <= 599) return 'retryable';
  if (status === 408) return 'retryable'; // request timeout — server-side, transient
  if (status >= 400 && status <= 499) return 'permanent'; // 401/403/400/404/422 etc.
  return undefined;
}

/** Keywords in an error message that signal a transient/retryable condition. */
const RETRYABLE_KEYWORDS = [
  'overloaded',
  'rate limit',
  'rate_limit',
  'ratelimit',
  'too many requests',
  'temporarily unavailable',
  'service unavailable',
  'bad gateway',
  'gateway timeout',
  'timed out', // network-level timeout string (distinct from our InvocationTimeoutError)
  'socket hang up',
  'network',
  'fetch failed',
  'connection error',
  'connection reset',
  'econnreset',
  'etimedout',
  'epipe',
  'econnrefused',
  'enotfound',
];

/** Keywords that signal a permanent, caller-side failure (auth / bad request). */
const PERMANENT_KEYWORDS = [
  'invalid api key',
  'invalid_api_key',
  'incorrect api key',
  'unauthorized',
  'authentication',
  'permission',
  'forbidden',
  'invalid request',
  'invalid_request',
  'not found',
  'unsupported',
];

/**
 * Classify an error into a retry/circuit-breaker category.
 *
 * Order of precedence:
 *  1. InvocationTimeoutError → 'timeout' (never retried — already burned the deadline).
 *  2. Structured SDK APIError status (primary path).
 *  3. Status code off any other error object (`.status`/`.statusCode`/`.response.status`).
 *  4. Status code parsed out of the message (bare-text gateway fallback).
 *  5. Network error code (err.code).
 *  6. Keyword matching on the message.
 *  7. Default → 'permanent' (don't amplify load by retrying something we don't understand).
 */
export function classifyError(err: unknown): ApiErrorClass {
  if (err instanceof InvocationTimeoutError) return 'timeout';

  // 2. Structured SDK APIError — status is authoritative. A statusless APIError
  // (APIConnectionError / APIConnectionTimeoutError) is a transient network fault → retryable.
  if (isApiError(err)) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    if (status !== undefined) {
      const byStatus = classifyStatus(status);
      if (byStatus) return byStatus;
    } else {
      return 'retryable';
    }
  }

  // 3. Structured status off any other error shape
  const structured = extractStatus(err);
  if (structured !== undefined) {
    const byStatus = classifyStatus(structured);
    if (byStatus) return byStatus;
  }

  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // 4. Status parsed from message (bare-text gateway fallback)
  const parsed = statusFromMessage(message);
  if (parsed !== undefined) {
    const byStatus = classifyStatus(parsed);
    if (byStatus) return byStatus;
  }

  // 5. Network error code
  if (typeof err === 'object' && err !== null) {
    const code = (err as Record<string, unknown>)['code'];
    if (typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code)) return 'retryable';
  }

  // 6. Keyword matching — permanent auth/request errors win over generic retryable words
  // to avoid retrying a doomed call (e.g. "unauthorized" should not be retried).
  if (PERMANENT_KEYWORDS.some(k => message.includes(k))) return 'permanent';
  if (RETRYABLE_KEYWORDS.some(k => message.includes(k))) return 'retryable';

  // 7. Unknown → permanent (fail fast rather than retry-storm).
  return 'permanent';
}

/**
 * Whether a failure is a rate-limit / overload signal that should widen the adaptive throttle.
 * A subset of retryable errors — used purely to grow the inter-request delay, independent of
 * the retry decision.
 */
export function isRateLimit(err: unknown): boolean {
  if (err instanceof AnthropicRateLimitError || err instanceof OpenAIRateLimitError) return true;
  const status = extractStatus(err);
  if (status === 429) return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b429\b/.test(message)) return true;
  return (
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('ratelimit') ||
    message.includes('too many requests') ||
    message.includes('overloaded')
  );
}
