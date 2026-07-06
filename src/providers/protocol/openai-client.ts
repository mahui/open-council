import OpenAI from 'openai';
import type { GenRequest, NormalizedEvent, NormalizedResult, ProtocolClient } from './types.js';

/**
 * Placeholder key for no-auth endpoints (ollama / vLLM / LM Studio bound to localhost). The
 * OpenAI SDK refuses to construct with an empty apiKey; these servers ignore the header, so a
 * dummy value lets the call through unchanged.
 */
const NO_AUTH_KEY = 'no-auth';

/**
 * openai line-protocol client. Wraps `openai` `chat.completions.create`. Also serves every
 * OpenAI-compatible endpoint (DeepSeek / Moonshot / gateways / local servers) via `baseURL`.
 *
 * `maxRetries: 0` is mandatory (design R6) — see AnthropicClient for the rationale.
 *
 * Compatibility note (design R7): some compatible endpoints reject `stream_options` /
 * `reasoning_effort` / `max_tokens`. We send the official fields; an endpoint that rejects
 * them surfaces a structured error which the adapter's error-classifier treats as permanent.
 * Graceful degradation for these fields is intentionally localised to this one class.
 */
export class OpenAIClient implements ProtocolClient {
  private readonly sdk: OpenAI;

  constructor(apiKey: string, baseURL: string, timeoutMs: number) {
    this.sdk = new OpenAI({ apiKey: apiKey || NO_AUTH_KEY, baseURL, maxRetries: 0, timeout: timeoutMs });
  }

  async stream(req: GenRequest, onEvent: (e: NormalizedEvent) => void): Promise<NormalizedResult> {
    const stream = await this.sdk.chat.completions.create(
      {
        model: req.model,
        messages: [{ role: 'user', content: req.prompt }],
        max_tokens: req.maxTokens,
        stream: true,
        // include_usage → the final (choice-less) chunk carries prompt/completion token counts.
        stream_options: { include_usage: true },
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      },
      { signal: req.signal },
    );

    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
        onEvent({ textDelta: choice.delta.content });
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      // The usage-bearing chunk (include_usage) has an empty choices array.
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }
    }

    return { text, inputTokens, outputTokens, truncated: finishReason === 'length' };
  }

  async complete(req: GenRequest): Promise<NormalizedResult> {
    const res = await this.sdk.chat.completions.create(
      {
        model: req.model,
        messages: [{ role: 'user', content: req.prompt }],
        max_tokens: req.maxTokens,
        stream: false,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      },
      { signal: req.signal },
    );

    const choice = res.choices[0];
    return {
      text: choice?.message.content ?? '',
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      truncated: choice?.finish_reason === 'length',
    };
  }
}
