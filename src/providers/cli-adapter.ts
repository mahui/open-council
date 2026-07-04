import { spawn } from 'node:child_process';
import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult, HealthStatus, OnChunk } from '../types/provider.js';
import { InvocationError } from '../types/errors.js';

const DEBUG = !!process.env['COUNCIL_DEBUG'];

/**
 * Grace period between SIGTERM and SIGKILL. On timeout we first ask the child to exit
 * cleanly (SIGTERM); if it ignores the signal (some CLIs trap it) we escalate to an
 * unconditional SIGKILL so a hung binary can never keep the debate waiting forever.
 */
const SIGKILL_GRACE_MS = 5_000;

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[cli-adapter] ${msg}\n`);
}

/**
 * Result of parsing/cleaning raw CLI stdout. `failed` is set when the tool reported a
 * structured error (e.g. codex JSONL `error` events) even though it may have exited 0 —
 * such output must not be forwarded to the orchestrator as a valid utterance.
 */
interface ParsedOutput {
  text: string;
  failed: boolean;
}

export class CliAdapter implements InvocationAdapter {
  /**
   * @param sigkillGraceMs Delay between SIGTERM and the escalated SIGKILL on timeout.
   *   Defaults to {@link SIGKILL_GRACE_MS}; overridable so tests can exercise the escalation
   *   path without a multi-second wait.
   */
  constructor(private readonly sigkillGraceMs: number = SIGKILL_GRACE_MS) {}

  async invoke(config: ModelConfig, prompt: string, _onChunk?: OnChunk): Promise<InvocationResult> {
    if (!config.binary) {
      throw new InvocationError(config.name, 'cli', 'No binary configured');
    }

    const binary = config.binary;
    const args = [...(config.args ?? []), ...(config.model_args ?? [])];

    // For arg input mode, append prompt as last argument
    if (config.input_mode === 'arg') {
      args.push(prompt);
    }

    const start = Date.now();

    return new Promise<InvocationResult>((resolve, reject) => {
      const child = spawn(binary, args, {
        env: { ...process.env, ...config.env },
        // NOTE: intentionally NO `timeout` option here. spawn's built-in timeout kills the
        // process and still emits `close` with our timedOut flag unset, silently mislabelling
        // a timeout as a clean completion. We own the single timeout mechanism below.
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      // Single timeout mechanism: SIGTERM on deadline, escalate to SIGKILL after a grace
      // period, and clear both timers whenever the process settles.
      let killTimer: NodeJS.Timeout | undefined;
      const timeoutTimer: NodeJS.Timeout = setTimeout(() => {
        timedOut = true;
        debug(`${binary} exceeded ${config.timeout_seconds}s — sending SIGTERM`);
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          debug(`${binary} ignored SIGTERM — escalating to SIGKILL`);
          child.kill('SIGKILL');
        }, this.sigkillGraceMs);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }, config.timeout_seconds * 1000);
      if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();

      const clearTimers = (): void => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
      };

      const finishResolve = (result: InvocationResult): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve(result);
      };

      const finishReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(err);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        if (_onChunk && binary !== 'codex') {
          // Stream stdout chunks directly for non-JSON CLI tools (e.g. claude -p)
          _onChunk(text);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      // Guard stdin against EPIPE: if the child exits (or never reads stdin) before we finish
      // writing, the write raises an async 'error' that would otherwise crash the whole process.
      // Swallow EPIPE specifically; log anything else (ASYNC-04: never a silent empty catch).
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          debug(`${binary} stdin EPIPE (child closed input early) — ignored`);
        } else {
          debug(`${binary} stdin error: ${err.message}`);
        }
      });

      // input_mode handling
      if (config.input_mode === 'stdin') {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      child.on('close', (code) => {
        const elapsed = Date.now() - start;

        // Timeout takes precedence: report as a timed-out invocation regardless of exit code.
        if (timedOut) {
          finishResolve({
            response: '',
            elapsed_ms: elapsed,
            invocation_mode: 'cli',
            exit_code: code ?? undefined,
            stderr: stderr || undefined,
            timed_out: true,
          });
          return;
        }

        // Non-zero exit → failure. Reject so the orchestrator's catch discards this agent
        // (its `!timed_out && response_raw` filter would otherwise treat garbage as valid).
        if (code !== 0) {
          const firstLine = stderr.split('\n').find((l) => l.trim().length > 0)?.trim();
          finishReject(new InvocationError(
            config.name,
            'cli',
            `exited with code ${code ?? 'null'}${firstLine ? `: ${firstLine}` : ''}`,
          ));
          return;
        }

        const parsed = this.cleanOutput(stdout, binary);

        // Tool reported a structured error (e.g. codex error event) despite exit 0.
        if (parsed.failed) {
          finishReject(new InvocationError(config.name, 'cli', parsed.text));
          return;
        }

        finishResolve({
          response: parsed.text,
          elapsed_ms: elapsed,
          invocation_mode: 'cli',
          exit_code: code ?? 0,
          stderr: stderr || undefined,
          timed_out: false,
        });
      });

      child.on('error', (err) => {
        finishReject(new InvocationError(config.name, 'cli', err.message));
      });
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

  private cleanOutput(raw: string, binary?: string): ParsedOutput {
    const cleaned = raw
      .replace(/\x1b\[[0-9;]*m/g, '')  // ANSI escape codes
      .replace(/\r/g, '')               // carriage returns
      .trim();

    // codex --json mode: extract text from JSONL events
    if (binary === 'codex' && cleaned.includes('"type"')) {
      const texts: string[] = [];
      let errorMsg = '';
      for (const line of cleaned.split('\n')) {
        try {
          const event = JSON.parse(line) as {
            type?: string;
            item?: { text?: string };
            message?: string;
            error?: { message?: string };
          };
          if (event.type === 'item.completed' && event.item?.text) {
            texts.push(event.item.text);
          } else if (event.type === 'error' && event.message) {
            // Extract readable error from codex error events
            try {
              const inner = JSON.parse(event.message) as { error?: { message?: string } };
              errorMsg = inner.error?.message ?? event.message;
            } catch {
              errorMsg = event.message;
            }
          }
        } catch { /* skip non-JSON lines */ }
      }
      if (texts.length > 0) return { text: texts.join('\n'), failed: false };
      if (errorMsg) return { text: errorMsg, failed: true };
    }

    return { text: cleaned, failed: false };
  }

  private checkBinaryExists(binary: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('which', [binary], { stdio: 'pipe' });
      child.on('close', (code: number | null) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }
}
