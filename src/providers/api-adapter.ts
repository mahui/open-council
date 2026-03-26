import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult, HealthStatus, ProviderCredential, OnChunk } from '../types/provider.js';
import { InvocationError } from '../types/errors.js';
import type { CredentialManager } from './credentials/discovery.js';
import { throttle, recordSuccess, recordFailure, getProviderStatus } from './health.js';

export class ApiAdapter implements InvocationAdapter {
  constructor(private credentialManager: CredentialManager) {}

  async invoke(config: ModelConfig, prompt: string, onChunk?: OnChunk): Promise<InvocationResult> {
    const provider = config.provider!;

    // Circuit breaker: if provider is 'open', fail fast so AutoAdapter falls back to CLI
    const status = getProviderStatus(provider);
    if (status === 'open') {
      throw new InvocationError(config.name, 'api', `Provider ${provider} circuit open (too many failures), falling back to CLI`);
    }

    const credential = await this.credentialManager.getValidCredential(provider);

    // Adaptive throttle
    await throttle(provider);

    const start = Date.now();

    try {
      let result: InvocationResult;
      switch (provider) {
        case 'anthropic':
          result = await this.invokeAnthropic(config, prompt, credential.access_token, start, onChunk);
          break;
        case 'openai':
          result = await this.invokeOpenAI(config, prompt, credential, start, onChunk);
          break;
        case 'google':
          result = await this.invokeGoogle(config, prompt, credential, start, onChunk);
          break;
        default:
          throw new InvocationError(config.name, 'api', `Unsupported API provider: ${provider}`);
      }
      recordSuccess(provider);
      return result;
    } catch (err) {
      const is429 = err instanceof InvocationError && err.message.includes('429');
      recordFailure(provider, is429);
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
    accessToken: string, start: number, onChunk?: OnChunk,
  ): Promise<InvocationResult> {
    const isOAuth = accessToken.includes('sk-ant-oat');

    if (isOAuth) {
      return this.invokeAnthropicOAuth(config, prompt, accessToken, start, onChunk);
    }

    const client = new Anthropic({
      apiKey: accessToken,
      ...(config.api_base_url ? { baseURL: config.api_base_url } : {}),
    });

    if (onChunk) {
      const textParts: string[] = [];
      const stream = client.messages.stream({
        model: config.model!,
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          onChunk(event.delta.text);
          textParts.push(event.delta.text);
        }
      }
      const finalMessage = await stream.finalMessage();
      return {
        response: textParts.join(''),
        elapsed_ms: Date.now() - start,
        invocation_mode: 'api',
        http_status: 200,
        token_usage: {
          input_tokens: finalMessage.usage.input_tokens,
          output_tokens: finalMessage.usage.output_tokens,
        },
        timed_out: false,
      };
    }

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

  private async invokeAnthropicOAuth(
    config: ModelConfig, prompt: string,
    accessToken: string, start: number, onChunk?: OnChunk,
  ): Promise<InvocationResult> {
    const url = (config.api_base_url ?? 'https://api.anthropic.com') + '/v1/messages';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-dangerous-direct-browser-access': 'true',
    };

    const body = {
      model: config.model!,
      max_tokens: 8192,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new InvocationError(config.name, 'api', `Anthropic ${res.status}: ${errBody.substring(0, 300)}`);
    }

    // Parse SSE stream
    const textParts: string[] = [];
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    const reader = res.body?.getReader();
    if (!reader) throw new InvocationError(config.name, 'api', 'No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6)) as {
            type?: string;
            delta?: { type?: string; text?: string };
            usage?: { input_tokens: number; output_tokens: number };
            message?: { usage?: { input_tokens: number; output_tokens: number } };
          };
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            if (onChunk) onChunk(event.delta.text);
            textParts.push(event.delta.text);
          }
          if (event.type === 'message_delta' && event.usage) {
            usage = event.usage;
          }
          if (event.type === 'message_start' && event.message?.usage) {
            usage = { ...event.message.usage, output_tokens: 0 };
          }
        } catch { /* skip */ }
      }
    }

    return {
      response: textParts.join(''),
      elapsed_ms: Date.now() - start,
      invocation_mode: 'api',
      http_status: res.status,
      token_usage: usage,
      timed_out: false,
    };
  }

  private async invokeOpenAI(
    config: ModelConfig, prompt: string,
    credential: ProviderCredential, start: number, onChunk?: OnChunk,
  ): Promise<InvocationResult> {
    // Codex OAuth tokens use chatgpt.com/backend-api; API keys use api.openai.com
    const isOAuth = credential.source === 'file';
    const baseURL = isOAuth ? 'https://chatgpt.com/backend-api' : config.api_base_url;
    const client = new OpenAI({
      apiKey: credential.access_token,
      ...(baseURL ? { baseURL } : {}),
    });

    if (isOAuth) {
      // Codex OAuth → use chat completions API (backend-api doesn't support responses API)
      return this.invokeOpenAIOAuth(client, config, prompt, credential, start, onChunk);
    }

    if (onChunk) {
      const textParts: string[] = [];
      const stream = await client.responses.create({
        model: config.model!,
        input: prompt,
        stream: true,
      });
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          onChunk(event.delta);
          textParts.push(event.delta);
        }
      }
      return {
        response: textParts.join(''),
        elapsed_ms: Date.now() - start,
        invocation_mode: 'api',
        http_status: 200,
        timed_out: false,
      };
    }

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

  private async invokeOpenAIOAuth(
    client: OpenAI, config: ModelConfig, prompt: string,
    credential: ProviderCredential, start: number, onChunk?: OnChunk,
  ): Promise<InvocationResult> {
    // chatgpt.com/backend-api uses the responses API format
    const url = 'https://chatgpt.com/backend-api/responses';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.access_token}`,
      'Content-Type': 'application/json',
    };
    if (credential.account_id) {
      headers['Chatgpt-Account-Id'] = credential.account_id;
    }

    const body = {
      model: config.model!,
      input: prompt,
      stream: !!onChunk,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new InvocationError(config.name, 'api', `OpenAI ${res.status}: ${errBody.substring(0, 300)}`);
    }

    if (onChunk && res.body) {
      const textParts: string[] = [];
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const chunk = JSON.parse(line.slice(6)) as {
              type?: string;
              delta?: string;
            };
            if (chunk.type === 'response.output_text.delta' && chunk.delta) {
              onChunk(chunk.delta);
              textParts.push(chunk.delta);
            }
          } catch { /* skip */ }
        }
      }
      return {
        response: textParts.join(''),
        elapsed_ms: Date.now() - start,
        invocation_mode: 'api',
        http_status: res.status,
        timed_out: false,
      };
    }

    const data = await res.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
    const text = data.output_text
      ?? data.output?.flatMap(o => o.content?.map(c => c.text) ?? []).join('')
      ?? '';

    return {
      response: text,
      elapsed_ms: Date.now() - start,
      invocation_mode: 'api',
      http_status: res.status,
      timed_out: false,
    };
  }

  private async invokeGoogle(
    config: ModelConfig, prompt: string,
    credential: ProviderCredential, start: number, onChunk?: OnChunk,
  ): Promise<InvocationResult> {
    // env-sourced credentials are API keys; file-sourced (gemini-cli) are OAuth tokens
    if (credential.source === 'file') {
      return this.invokeGoogleOAuth(config, prompt, credential, start, onChunk);
    }

    if (onChunk) {
      const ai = new GoogleGenAI({ apiKey: credential.access_token });
      const textParts: string[] = [];
      let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;

      const stream = await ai.models.generateContentStream({
        model: config.model!,
        contents: prompt,
      });
      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) {
          onChunk(text);
          textParts.push(text);
        }
        if (chunk.usageMetadata) {
          usageMetadata = chunk.usageMetadata;
        }
      }
      return {
        response: textParts.join(''),
        elapsed_ms: Date.now() - start,
        invocation_mode: 'api',
        http_status: 200,
        token_usage: usageMetadata ? {
          input_tokens: usageMetadata.promptTokenCount ?? 0,
          output_tokens: usageMetadata.candidatesTokenCount ?? 0,
        } : undefined,
        timed_out: false,
      };
    }

    const ai = new GoogleGenAI({ apiKey: credential.access_token });
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

  private async invokeGoogleOAuth(
    config: ModelConfig, prompt: string,
    credential: ProviderCredential, start: number, onChunk?: OnChunk,
  ): Promise<InvocationResult> {
    // gemini-cli OAuth tokens work with Cloud Code Assist API, not the public Gemini API
    const url = 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';
    const reqBody = JSON.stringify({
      model: config.model!,
      project: credential.project_id,
      request: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 8192 },
      },
    });
    const headers = {
      Authorization: `Bearer ${credential.access_token}`,
      'Content-Type': 'application/json',
    };

    // Check quota before sending request
    const quotaWait = await this.checkGoogleQuota(credential, config.model!);
    if (quotaWait > 0) {
      if (onChunk) onChunk(`[waiting ${quotaWait}s for quota reset...]\n`);
      await new Promise(r => setTimeout(r, quotaWait * 1000));
    }

    // Retry on 429 — max 2 retries then let AutoAdapter fall back to CLI
    const maxRetries = 2;
    let res: Response | undefined;
    let lastError = '';
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      res = await fetch(url, { method: 'POST', headers, body: reqBody });
      if (res.status !== 429) break;
      lastError = await res.text();
      if (attempt === maxRetries) { res = undefined; break; }
      // Use server-suggested wait time
      const retryMatch = lastError.match(/after (\d+)s/);
      const waitSec = retryMatch ? Math.min(Number(retryMatch[1]) + 1, 30) : 12;
      if (onChunk) onChunk(`[rate limited, retrying in ${waitSec}s...]\n`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      res = undefined;
    }

    if (!res) {
      throw new InvocationError(config.name, 'api', `Google API 429: ${lastError.substring(0, 200)}`);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new InvocationError(config.name, 'api', `Google API ${res.status}: ${body}`);
    }

    // Stream SSE chunks in real time
    const textParts: string[] = [];
    let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;

    const reader = res!.body?.getReader();
    if (!reader) {
      throw new InvocationError(config.name, 'api', 'No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const chunk = JSON.parse(line.slice(6)) as {
            response?: {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
              usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
            };
          };
          const parts = chunk.response?.candidates?.[0]?.content?.parts;
          if (parts) {
            for (const p of parts) {
              if (p.text) {
                if (onChunk) onChunk(p.text);
                textParts.push(p.text);
              }
            }
          }
          if (chunk.response?.usageMetadata) {
            usageMetadata = chunk.response.usageMetadata;
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }

    return {
      response: textParts.join(''),
      elapsed_ms: Date.now() - start,
      invocation_mode: 'api',
      http_status: res!.status,
      token_usage: usageMetadata ? {
        input_tokens: usageMetadata.promptTokenCount ?? 0,
        output_tokens: usageMetadata.candidatesTokenCount ?? 0,
      } : undefined,
      timed_out: false,
    };
  }

  /** Check Google Cloud Code Assist quota, return seconds to wait (0 = ready) */
  private async checkGoogleQuota(
    credential: ProviderCredential, model: string,
  ): Promise<number> {
    try {
      const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.access_token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!res.ok) return 0;

      const data = await res.json() as {
        buckets?: Array<{
          tokenType?: string;
          modelId?: string;
          remainingFraction?: number;
          resetTime?: string;
        }>;
      };

      const bucket = data.buckets?.find(
        b => b.tokenType === 'REQUESTS' && b.modelId === model,
      );

      if (bucket && bucket.remainingFraction !== undefined && bucket.remainingFraction <= 0 && bucket.resetTime) {
        const resetMs = new Date(bucket.resetTime).getTime() - Date.now();
        return Math.max(0, Math.ceil(resetMs / 1000));
      }

      return 0;
    } catch {
      return 0;
    }
  }
}
