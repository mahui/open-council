import { OFFICIAL_BASE_URL } from '../../config/schema.js';
import type { ModelConfig } from '../../types/config.js';
import { AnthropicClient } from './anthropic-client.js';
import { OpenAIClient } from './openai-client.js';
import type { ProtocolClient } from './types.js';

export type { GenRequest, NormalizedEvent, NormalizedResult, ProtocolClient } from './types.js';
export { AnthropicClient } from './anthropic-client.js';
export { OpenAIClient } from './openai-client.js';

/**
 * Build the ProtocolClient for a model: pick the SDK by `protocol`, resolve the endpoint
 * (`base_url` → official when omitted), and pass the already-resolved API key + timeout.
 */
export function makeProtocolClient(config: ModelConfig, apiKey: string, timeoutMs: number): ProtocolClient {
  const baseURL = config.base_url ?? OFFICIAL_BASE_URL[config.protocol];
  if (config.protocol === 'anthropic') {
    return new AnthropicClient(apiKey, baseURL, timeoutMs);
  }
  return new OpenAIClient(apiKey, baseURL, timeoutMs);
}
