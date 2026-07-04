/**
 * Tests for CliAdapter reliability hardening.
 *
 * Strategy: spawn a real `node -e <script>` as a stand-in "binary" so we exercise the actual
 * child_process code paths (timeout/SIGTERM/SIGKILL escalation, non-zero exit handling, stdin
 * EPIPE guard) without mocking child_process. Each fake binary is a tiny inline node script.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliAdapter } from '../../src/providers/cli-adapter.js';
import { InvocationError } from '../../src/types/errors.js';
import type { ModelConfig } from '../../src/types/config.js';

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'fake-cli',
    invocation: 'cli',
    provider: 'anthropic',
    model: 'fake',
    binary: 'node',
    timeout_seconds: 5,
    capabilities: ['general'],
    priority: 100,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: false,
    input_mode: 'stdin',
    ...overrides,
  };
}

/** Build a config whose "binary" is `node -e <script>` plus any extra args. */
function nodeScript(script: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return makeConfig({ args: ['-e', script], ...overrides });
}

describe('CliAdapter.invoke — happy path & output cleaning', () => {
  it('captures stdout, exit_code 0, timed_out false', async () => {
    const adapter = new CliAdapter();
    const config = nodeScript('process.stdout.write("hello world")');

    const result = await adapter.invoke(config, 'ignored prompt');

    expect(result.response).toBe('hello world');
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
    expect(result.invocation_mode).toBe('cli');
  });

  it('strips ANSI escape codes and carriage returns', async () => {
    const adapter = new CliAdapter();
    // \x1b[31m red \x1b[0m with a trailing CR
    const config = nodeScript('process.stdout.write("\\u001b[31mred\\u001b[0m\\r")');

    const result = await adapter.invoke(config, 'x');

    expect(result.response).toBe('red');
  });

  it('input_mode=arg appends the prompt as the last argv entry', async () => {
    const adapter = new CliAdapter();
    // With `node -e <code> <prompt>`, process.argv[1] is the appended prompt.
    const config = nodeScript('process.stdout.write(process.argv[1])', { input_mode: 'arg' });

    const result = await adapter.invoke(config, 'PROMPT_AS_ARG');

    expect(result.response).toBe('PROMPT_AS_ARG');
  });
});

describe('CliAdapter.invoke — non-zero exit is a failure', () => {
  it('rejects with InvocationError even when stdout has content', async () => {
    const adapter = new CliAdapter();
    const config = nodeScript('process.stdout.write("partial answer"); process.exit(3)');

    await expect(adapter.invoke(config, 'x')).rejects.toBeInstanceOf(InvocationError);
    await expect(adapter.invoke(config, 'x')).rejects.toThrow(/code 3/);
  });

  it('surfaces the first stderr line in the error message', async () => {
    const adapter = new CliAdapter();
    const config = nodeScript('process.stderr.write("boom: kaboom\\n"); process.exit(1)');

    await expect(adapter.invoke(config, 'x')).rejects.toThrow(/boom: kaboom/);
  });
});

describe('CliAdapter.invoke — timeout escalation', () => {
  it('SIGTERM-ignoring process is SIGKILLed and reported as timed_out', async () => {
    // Grace of 150ms so the escalation happens quickly in the test.
    const adapter = new CliAdapter(150);
    // Trap SIGTERM (ignore it) and stay alive via a timer → only SIGKILL can stop it.
    const config = nodeScript(
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("started");',
      { timeout_seconds: 0.2 },
    );

    const result = await adapter.invoke(config, 'x');

    expect(result.timed_out).toBe(true);
    expect(result.response).toBe('');
  }, 10_000);

  it('a fast process that finishes before the deadline is not timed_out', async () => {
    const adapter = new CliAdapter(150);
    const config = nodeScript('process.stdout.write("quick")', { timeout_seconds: 5 });

    const result = await adapter.invoke(config, 'x');

    expect(result.timed_out).toBe(false);
    expect(result.response).toBe('quick');
  });
});

describe('CliAdapter.invoke — stdin EPIPE guard', () => {
  it('child that exits without reading stdin does not crash the process', async () => {
    const adapter = new CliAdapter();
    // Exits immediately without ever reading stdin; a large prompt makes the pipe write
    // race the child's exit, which is exactly the EPIPE condition we must swallow.
    const config = nodeScript('process.stdout.write("done"); process.exit(0)');
    const bigPrompt = 'x'.repeat(500_000);

    const result = await adapter.invoke(config, bigPrompt);

    expect(result.response).toBe('done');
    expect(result.exit_code).toBe(0);
    expect(result.timed_out).toBe(false);
  });
});

describe('CliAdapter.invoke — configuration errors', () => {
  it('missing binary throws InvocationError', async () => {
    const adapter = new CliAdapter();
    const config = makeConfig({ binary: undefined });

    await expect(adapter.invoke(config, 'x')).rejects.toBeInstanceOf(InvocationError);
  });

  it('spawn error (nonexistent binary) rejects with InvocationError', async () => {
    const adapter = new CliAdapter();
    const config = makeConfig({ binary: 'definitely-not-a-real-binary-xyz', args: [] });

    await expect(adapter.invoke(config, 'x')).rejects.toBeInstanceOf(InvocationError);
  });
});

describe('CliAdapter.invoke — codex JSONL error events', () => {
  // Install a fake `codex` executable on PATH so the codex-specific cleanOutput branch
  // (binary === 'codex') runs against a real spawned process.
  let originalPath: string | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    if (originalPath !== undefined) process.env['PATH'] = originalPath;
    originalPath = undefined;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function installFakeCodex(body: string): void {
    tmpDir = mkdtempSync(join(tmpdir(), 'council-codex-'));
    const bin = join(tmpDir, 'codex');
    writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
    chmodSync(bin, 0o755);
    originalPath = process.env['PATH'];
    process.env['PATH'] = `${tmpDir}:${process.env['PATH'] ?? ''}`;
  }

  it('error event with no completed item is treated as failure (rejects)', async () => {
    const errLine = JSON.stringify({ type: 'error', message: 'rate limit exceeded' });
    installFakeCodex(`process.stdout.write(${JSON.stringify(errLine)})`);

    const adapter = new CliAdapter();
    const config = makeConfig({ binary: 'codex', args: [] });

    await expect(adapter.invoke(config, 'x')).rejects.toBeInstanceOf(InvocationError);
    await expect(adapter.invoke(config, 'x')).rejects.toThrow(/rate limit exceeded/);
  });

  it('completed item is extracted as the response', async () => {
    const okLine = JSON.stringify({ type: 'item.completed', item: { text: 'final answer' } });
    installFakeCodex(`process.stdout.write(${JSON.stringify(okLine)})`);

    const adapter = new CliAdapter();
    const config = makeConfig({ binary: 'codex', args: [] });

    const result = await adapter.invoke(config, 'x');

    expect(result.response).toBe('final answer');
    expect(result.timed_out).toBe(false);
  });
});
