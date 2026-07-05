/**
 * Built-mode resource-resolution smoke (task #34).
 * Runs the REAL compiled CLI (`node dist/cli.js benchmark --dry-run`) so the
 * default-asset path (`defaults/benchmark.yaml`) is resolved from a flat tsup
 * `dist/` chunk — the exact layout the old fixed `../..` anchor broke. A fixed
 * anchor here fails with ENOENT; the walk-up resolver loads the bundled suite.
 *
 * Requires a prior `pnpm build`. Run: npx tsx scripts/resources-smoke.mts
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const cli = join(repoRoot, 'dist', 'cli.js');

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  process.stdout.write(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}\n`);
  if (!cond) failures++;
}

if (!existsSync(cli)) {
  process.stderr.write(`dist/cli.js not found — run "pnpm build" first (looked at ${cli}).\n`);
  process.exit(1);
}

// Run from a neutral cwd so success cannot come from a relative-path accident:
// resolution must derive purely from the module location inside dist/.
const res = spawnSync('node', [cli, 'benchmark', '--dry-run'], {
  cwd: '/',
  encoding: 'utf-8',
});

const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
check('benchmark --dry-run exits 0', res.status === 0, `status=${res.status}`);
check('loaded the bundled defaults/benchmark.yaml', /Loaded \d+ benchmark question\(s\)/.test(out), firstLine(out));
check('no ENOENT resolving defaults', !/ENOENT/.test(out));

process.stdout.write(`\n${failures === 0 ? '🎉 ALL PASS' : `💥 ${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim().length > 0) ?? '').slice(0, 200);
}
