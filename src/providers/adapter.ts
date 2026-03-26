import { execSync } from 'node:child_process';
import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult, HealthStatus, OnChunk } from '../types/provider.js';
import { ModelUnavailableError } from '../types/errors.js';
import type { ApiAdapter } from './api-adapter.js';
import type { CliAdapter } from './cli-adapter.js';

/** Maps provider to CLI binary + args for fallback */
const CLI_FALLBACKS: Record<string, { binary: string; args: (model: string) => string[] }> = {
  anthropic: { binary: 'claude', args: (m) => ['-p', '--model', m] },
  openai:    { binary: 'codex',  args: (m) => ['exec', '-m', m, '-c', 'approval_policy="never"', '--json'] },
  google:    { binary: 'gemini', args: (_m) => ['-p'] },
};

function hasBinary(name: string): boolean {
  try { execSync(`which ${name}`, { stdio: 'pipe' }); return true; } catch { return false; }
}

export class AutoAdapter implements InvocationAdapter {
  constructor(
    private apiAdapter: ApiAdapter,
    private cliAdapter: CliAdapter,
  ) {}

  async invoke(config: ModelConfig, prompt: string, onChunk?: OnChunk): Promise<InvocationResult> {
    // 1. Try configured invocation mode
    if (config.invocation === 'api' || config.invocation === 'auto') {
      const apiHealth = await this.apiAdapter.healthCheck(config);
      if (apiHealth.level === 'healthy') {
        try {
          return await this.apiAdapter.invoke(config, prompt, onChunk);
        } catch (apiError) {
          // API failed — try CLI fallback before giving up
          const fallbackResult = await this.tryCliFallback(config, prompt, onChunk);
          if (fallbackResult) {
            if (onChunk) onChunk(`\n[degraded: fell back to CLI]\n`);
            return fallbackResult;
          }
          throw apiError; // no fallback available, rethrow original
        }
      }
    }

    if (config.invocation === 'cli' || config.invocation === 'auto') {
      const cliHealth = await this.cliAdapter.healthCheck(config);
      if (cliHealth.level !== 'unavailable') {
        return this.cliAdapter.invoke(config, prompt, onChunk);
      }
    }

    // 2. Neither configured mode worked — try any available CLI fallback
    const fallbackResult = await this.tryCliFallback(config, prompt, onChunk);
    if (fallbackResult) return fallbackResult;

    throw new ModelUnavailableError(config.name, 'No available invocation mode');
  }

  async healthCheck(config: ModelConfig): Promise<HealthStatus> {
    if (config.invocation === 'api' || config.invocation === 'auto') {
      const apiHealth = await this.apiAdapter.healthCheck(config);
      if (apiHealth.level === 'healthy') return apiHealth;
    }

    if (config.invocation === 'cli' || config.invocation === 'auto') {
      return this.cliAdapter.healthCheck(config);
    }

    // Check CLI fallback availability
    const fallback = config.provider ? CLI_FALLBACKS[config.provider] : undefined;
    if (fallback && hasBinary(fallback.binary)) {
      return { level: 'degraded', message: `CLI fallback available (${fallback.binary})`, checked_at: new Date().toISOString() };
    }

    return {
      level: 'unavailable',
      message: 'No invocation mode configured',
      checked_at: new Date().toISOString(),
    };
  }

  private async tryCliFallback(
    config: ModelConfig, prompt: string, onChunk?: OnChunk,
  ): Promise<InvocationResult | null> {
    const fallback = config.provider ? CLI_FALLBACKS[config.provider] : undefined;
    if (!fallback || !hasBinary(fallback.binary)) return null;

    // Build a CLI config from the API config
    const cliConfig: ModelConfig = {
      ...config,
      invocation: 'cli',
      binary: fallback.binary,
      args: fallback.args(config.model ?? config.name),
      input_mode: 'arg',
    };

    try {
      return await this.cliAdapter.invoke(cliConfig, prompt, onChunk);
    } catch {
      return null; // CLI also failed
    }
  }
}
