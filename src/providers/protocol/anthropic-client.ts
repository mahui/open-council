import Anthropic from '@anthropic-ai/sdk';
import type { ReasoningEffort } from '../../types/config.js';
import type { GenRequest, NormalizedEvent, NormalizedResult, ProtocolClient } from './types.js';

/**
 * Map reasoning effort to an extended-thinking token budget. Undefined effort → no thinking
 * block at all (a plain completion). Every budget stays comfortably below the reasoning-tiered
 * max_tokens the adapter picks, so thinking never crowds out the visible answer.
 */
const THINKING_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
};

/**
 * anthropic line-protocol client. Wraps `@anthropic-ai/sdk` `messages.create`.
 *
 * `maxRetries: 0` is mandatory (design R6): retries are owned exclusively by the adapter's
 * `withRetry` so that (a) a mid-stream failure is never silently re-emitted, (b) the circuit
 * breaker sees each genuine failure exactly once. Letting the SDK retry underneath would
 * double-retry and hide failures from the breaker.
 */
export class AnthropicClient implements ProtocolClient {
  private readonly sdk: Anthropic;

  constructor(apiKey: string, baseURL: string, timeoutMs: number) {
    this.sdk = new Anthropic({ apiKey, baseURL, maxRetries: 0, timeout: timeoutMs });
  }

  async stream(req: GenRequest, onEvent: (e: NormalizedEvent) => void): Promise<NormalizedResult> {
    const thinking = this.thinkingConfig(req.reasoningEffort);
    const stream = await this.sdk.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        messages: [{ role: 'user', content: req.prompt }],
        stream: true,
        // Thinking forces temperature=1, so only pass temperature when not reasoning.
        ...(thinking ? { thinking } : req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
      { signal: req.signal },
    );

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | null = null;

    for await (const event of stream) {
      if (event.type === 'message_start') {
        inputTokens = event.message.usage.input_tokens ?? 0;
        outputTokens = event.message.usage.output_tokens ?? 0;
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          text += event.delta.text;
          onEvent({ textDelta: event.delta.text });
        }
      } else if (event.type === 'message_delta') {
        // output_tokens on message_delta is the running total for the response.
        outputTokens = event.usage.output_tokens ?? outputTokens;
        if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
      }
    }

    return { text, inputTokens, outputTokens, truncated: stopReason === 'max_tokens' };
  }

  async complete(req: GenRequest): Promise<NormalizedResult> {
    const thinking = this.thinkingConfig(req.reasoningEffort);
    const message = await this.sdk.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        messages: [{ role: 'user', content: req.prompt }],
        ...(thinking ? { thinking } : req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
      { signal: req.signal },
    );

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      text,
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
      truncated: message.stop_reason === 'max_tokens',
    };
  }

  private thinkingConfig(
    effort: ReasoningEffort | undefined,
  ): { type: 'enabled'; budget_tokens: number } | undefined {
    if (!effort) return undefined;
    return { type: 'enabled', budget_tokens: THINKING_BUDGET[effort] };
  }
}
