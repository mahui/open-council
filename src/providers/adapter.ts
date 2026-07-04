import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult, HealthStatus, OnChunk } from '../types/provider.js';
import { ModelUnavailableError } from '../types/errors.js';
import type { ApiAdapter } from './api-adapter.js';
import type { CliAdapter } from './cli-adapter.js';
import { hasBinary } from './utils.js';

const DEBUG = !!process.env['COUNCIL_DEBUG'];

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[auto-adapter] ${msg}\n`);
}

/**
 * Result of mapping generation params to a binary's CLI flags: `args` are the flags we are
 * confident the binary accepts; `skipped` names params we deliberately dropped because no
 * safe flag mapping exists. Dropping is intentional — a wrong flag makes the CLI error out
 * and defeats the whole point of the fallback.
 */
interface MappedParams {
  args: string[];
  skipped: string[];
}

interface CliFallback {
  binary: string;
  args: (model: string) => string[];
  /**
   * Map reasoning_effort / temperature / max_tokens onto the binary's supported flags.
   * Conservative by design: only emit a flag when the binary is known to accept it; otherwise
   * record the param in `skipped` so it can be logged rather than guessed at.
   */
  mapParams?: (config: ModelConfig) => MappedParams;
}

/** Maps provider to CLI binary + args (and optional generation-param mapping) for fallback */
const CLI_FALLBACKS: Record<string, CliFallback> = {
  // claude (Claude Code CLI) exposes no flags for temperature / max_tokens / reasoning effort,
  // so we map none and let mapCliParams log that they were skipped.
  anthropic: { binary: 'claude', args: (m) => ['-p', '--model', m] },
  openai:    {
    binary: 'codex',
    args: (m) => ['exec', '-m', m, '-c', 'approval_policy="never"', '--json'],
    // codex accepts dotted config overrides via `-c key=value` (same mechanism already used for
    // approval_policy). `model_reasoning_effort` is a documented codex config key, so mapping it
    // is safe. There is no confidently-known codex CLI key for per-request temperature or max
    // output tokens, so those are skipped rather than risk an unknown-key error.
    mapParams: (config): MappedParams => {
      const args: string[] = [];
      const skipped: string[] = [];
      if (config.reasoning_effort !== undefined) {
        args.push('-c', `model_reasoning_effort="${config.reasoning_effort}"`);
      }
      if (config.temperature !== undefined) skipped.push('temperature');
      if (config.max_tokens !== undefined) skipped.push('max_tokens');
      return { args, skipped };
    },
  },
  google:    { binary: 'gemini', args: (_m) => ['-p'] },
};

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

    // Map reasoning_effort / temperature / max_tokens to whatever flags this binary supports.
    // Extra flags go before the prompt (input_mode 'arg' appends the prompt as the final arg).
    const paramArgs = this.mapCliParams(fallback, config);

    // Build a CLI config from the API config
    const cliConfig: ModelConfig = {
      ...config,
      invocation: 'cli',
      binary: fallback.binary,
      args: [...fallback.args(config.model ?? config.name), ...paramArgs],
      input_mode: 'arg',
    };

    try {
      return await this.cliAdapter.invoke(cliConfig, prompt, onChunk);
    } catch {
      return null; // CLI also failed
    }
  }

  /**
   * Resolve the generation-param flags for a CLI fallback, logging anything that could not be
   * mapped. Conservative: when a binary has no mapping (or a param has no safe flag), we omit it
   * and record why in debug output rather than guessing a flag that might make the CLI error out.
   */
  private mapCliParams(fallback: CliFallback, config: ModelConfig): string[] {
    const hasParams =
      config.reasoning_effort !== undefined ||
      config.temperature !== undefined ||
      config.max_tokens !== undefined;

    if (!fallback.mapParams) {
      if (hasParams) {
        debug(
          `CLI fallback ${fallback.binary}: no known flag mapping for generation params — ` +
          `skipping reasoning_effort/temperature/max_tokens`,
        );
      }
      return [];
    }

    const { args, skipped } = fallback.mapParams(config);
    if (args.length > 0) {
      debug(`CLI fallback ${fallback.binary}: mapped params → ${args.join(' ')}`);
    }
    if (skipped.length > 0) {
      debug(
        `CLI fallback ${fallback.binary}: skipped unsupported params [${skipped.join(', ')}] ` +
        `(no confident flag mapping — omitted to avoid CLI error)`,
      );
    }
    return args;
  }
}
