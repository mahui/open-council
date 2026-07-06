/**
 * Protocol-neutral contract for a single line-protocol client (anthropic | openai).
 *
 * The api-adapter reliability skeleton (timeout / retry / circuit breaker / truncation /
 * usage bookkeeping) is written against this interface, so the two SDK-specific clients
 * are the *only* place that knows about `@anthropic-ai/sdk` vs `openai` shapes. Adding a
 * third protocol means adding one more ProtocolClient, not touching the adapter.
 */
import type { ReasoningEffort } from '../../types/config.js';

/** A single streamed text increment, already decoded from the provider's event shape. */
export interface NormalizedEvent {
  textDelta: string;
}

/** The final, protocol-neutral outcome of a stream/complete call. */
export interface NormalizedResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * The model stopped because it hit its max_tokens / length ceiling: the content is real
   * but clipped. anthropic `stop_reason === 'max_tokens'` | openai `finish_reason === 'length'`.
   */
  truncated: boolean;
}

/** Everything a client needs to issue one generation request. */
export interface GenRequest {
  model: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  /** Aborted by the adapter's idle-timeout guard; SDKs honour this natively. */
  signal: AbortSignal;
}

export interface ProtocolClient {
  /** Streaming call: invoke `onEvent` per text increment, resolve with the final result. */
  stream(req: GenRequest, onEvent: (e: NormalizedEvent) => void): Promise<NormalizedResult>;
  /** Non-streaming call: resolve with the one-shot normalized result. */
  complete(req: GenRequest): Promise<NormalizedResult>;
}
