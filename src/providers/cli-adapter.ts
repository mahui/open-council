import { spawn } from 'node:child_process';
import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../types/provider.js';
import { InvocationError } from '../types/errors.js';

export class CliAdapter implements InvocationAdapter {
  async invoke(config: ModelConfig, prompt: string): Promise<InvocationResult> {
    if (!config.binary) {
      throw new InvocationError(config.name, 'cli', 'No binary configured');
    }

    const args = [...(config.args ?? []), ...(config.model_args ?? [])];

    // For arg input mode, append prompt as last argument
    if (config.input_mode === 'arg') {
      args.push(prompt);
    }

    const start = Date.now();

    return new Promise((resolve, reject) => {
      const child = spawn(config.binary!, args, {
        env: { ...process.env, ...config.env },
        timeout: config.timeout_seconds * 1000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      // input_mode handling
      if (config.input_mode === 'stdin') {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      child.on('close', (code) => {
        const elapsed = Date.now() - start;
        resolve({
          response: this.cleanOutput(stdout),
          elapsed_ms: elapsed,
          invocation_mode: 'cli',
          exit_code: code ?? 1,
          stderr: stderr || undefined,
          timed_out: timedOut,
        });
      });

      child.on('error', (err) => {
        reject(new InvocationError(config.name, 'cli', err.message));
      });

      // Handle timeout
      setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, config.timeout_seconds * 1000);
    });
  }

  async healthCheck(config: ModelConfig): Promise<HealthStatus> {
    const now = new Date().toISOString();
    if (!config.binary) {
      return { level: 'unavailable', message: 'No binary configured', checked_at: now };
    }

    try {
      const result = await this.checkBinaryExists(config.binary);
      if (result) {
        return { level: 'healthy', message: `Binary ${config.binary} found`, checked_at: now };
      }
      return { level: 'unavailable', message: `Binary ${config.binary} not found`, checked_at: now };
    } catch {
      return { level: 'unavailable', message: `Binary check failed for ${config.binary}`, checked_at: now };
    }
  }

  private cleanOutput(raw: string): string {
    return raw
      .replace(/\x1b\[[0-9;]*m/g, '')  // ANSI escape codes
      .replace(/\r/g, '')               // carriage returns
      .trim();
  }

  private checkBinaryExists(binary: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('which', [binary], { stdio: 'pipe' });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }
}
