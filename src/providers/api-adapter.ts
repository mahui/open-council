import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../types/provider.js';
import { InvocationError } from '../types/errors.js';
import type { CredentialManager } from './credentials/discovery.js';

export class ApiAdapter implements InvocationAdapter {
  constructor(private credentialManager: CredentialManager) {}

  async invoke(config: ModelConfig, prompt: string): Promise<InvocationResult> {
    const credential = await this.credentialManager.getValidCredential(config.provider!);
    const start = Date.now();

    try {
      switch (config.provider) {
        case 'anthropic':
          return await this.invokeAnthropic(config, prompt, credential.access_token, start);
        case 'openai':
          return await this.invokeOpenAI(config, prompt, credential.access_token, start);
        case 'google':
          return await this.invokeGoogle(config, prompt, credential.access_token, start);
        default:
          throw new InvocationError(config.name, 'api', `Unsupported API provider: ${config.provider}`);
      }
    } catch (err) {
      if (err instanceof InvocationError) throw err;
      throw new InvocationError(
        config.name, 'api',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async healthCheck(config: ModelConfig): Promise<HealthStatus> {
    const now = new Date().toISOString();
    if (!config.provider) {
      return { level: 'unavailable', message: 'No provider configured', checked_at: now };
    }

    try {
      const hasCredential = this.credentialManager.hasCredential(config.provider);
      if (!hasCredential) {
        return { level: 'unavailable', message: `No credentials for ${config.provider}`, checked_at: now };
      }
      return { level: 'healthy', message: 'Credentials available', checked_at: now };
    } catch {
      return { level: 'unavailable', message: 'Credential check failed', checked_at: now };
    }
  }

  private async invokeAnthropic(
    config: ModelConfig, prompt: string,
    accessToken: string, start: number,
  ): Promise<InvocationResult> {
    const client = new Anthropic({
      apiKey: accessToken,
      ...(config.api_base_url ? { baseURL: config.api_base_url } : {}),
    });

    const response = await client.messages.create({
      model: config.model!,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return {
      response: text,
      elapsed_ms: Date.now() - start,
      invocation_mode: 'api',
      http_status: 200,
      token_usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      timed_out: false,
    };
  }

  private async invokeOpenAI(
    config: ModelConfig, prompt: string,
    accessToken: string, start: number,
  ): Promise<InvocationResult> {
    const client = new OpenAI({
      apiKey: accessToken,
      ...(config.api_base_url ? { baseURL: config.api_base_url } : {}),
    });

    const response = await client.responses.create({
      model: config.model!,
      input: prompt,
    });

    return {
      response: response.output_text,
      elapsed_ms: Date.now() - start,
      invocation_mode: 'api',
      http_status: 200,
      token_usage: response.usage ? {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      } : undefined,
      timed_out: false,
    };
  }

  private async invokeGoogle(
    config: ModelConfig, prompt: string,
    accessToken: string, start: number,
  ): Promise<InvocationResult> {
    const ai = new GoogleGenAI({ apiKey: accessToken });

    const response = await ai.models.generateContent({
      model: config.model!,
      contents: prompt,
    });

    return {
      response: response.text ?? '',
      elapsed_ms: Date.now() - start,
      invocation_mode: 'api',
      http_status: 200,
      token_usage: response.usageMetadata ? {
        input_tokens: response.usageMetadata.promptTokenCount ?? 0,
        output_tokens: response.usageMetadata.candidatesTokenCount ?? 0,
      } : undefined,
      timed_out: false,
    };
  }
}
