import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../types/provider.js';
import { ModelUnavailableError } from '../types/errors.js';
import type { ApiAdapter } from './api-adapter.js';
import type { CliAdapter } from './cli-adapter.js';

export class AutoAdapter implements InvocationAdapter {
  constructor(
    private apiAdapter: ApiAdapter,
    private cliAdapter: CliAdapter,
  ) {}

  async invoke(config: ModelConfig, prompt: string): Promise<InvocationResult> {
    // 1. If API credentials available, prefer API mode
    if (config.invocation === 'api' || config.invocation === 'auto') {
      const apiHealth = await this.apiAdapter.healthCheck(config);
      if (apiHealth.level === 'healthy') {
        return this.apiAdapter.invoke(config, prompt);
      }
    }

    // 2. Fall back to CLI mode
    if (config.invocation === 'cli' || config.invocation === 'auto') {
      const cliHealth = await this.cliAdapter.healthCheck(config);
      if (cliHealth.level !== 'unavailable') {
        return this.cliAdapter.invoke(config, prompt);
      }
    }

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

    return {
      level: 'unavailable',
      message: 'No invocation mode configured',
      checked_at: new Date().toISOString(),
    };
  }
}
