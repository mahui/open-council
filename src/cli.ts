#!/usr/bin/env node

import { Command } from 'commander';

const program = new Command()
  .name('council')
  .description('Local AI Council — Multi-model debate orchestration system')
  .version('0.1.0');

// Main command: council "question"
program
  .argument('[question]', 'The question to debate')
  .option('-m, --mode <mode>', 'Debate mode: quick | compare | debate | auto', 'auto')
  .option('-c, --chairman <model>', 'Specify Chairman model')
  .option('--models <models...>', 'Specify participating models')
  .option('-i, --interactive', 'Enable interactive Human-in-the-Loop')
  .option('--no-interactive', 'Force disable interactive mode')
  .option('-j, --json', 'JSON format output')
  .option('--no-store', 'Do not persist this debate result')
  .option('--resume [sessionId]', 'Resume an interrupted debate')
  .option('--force', 'Force start a new debate')
  .option('--tag <tags...>', 'Tags')
  .option('--copy', 'Auto-copy result to clipboard')
  .option('--devil-advocate', 'Force enable devil advocate role')
  .option('--role-set <name>', 'Specify role set')
  .option('--follow [sessionId]', 'Follow-up on a previous debate')
  .action(async (question, options) => {
    if (!question && process.stdin.isTTY && !options.json) {
      // No question + TTY → launch interactive REPL
      const { startRepl } = await import('./ui/repl.js');
      await startRepl();
      return;
    }
    const { runCouncil } = await import('./commands/council.js');
    await runCouncil(question, options);
  });

// Setup wizard
program.command('setup').description('Configuration wizard').action(async () => {
  const { runSetup } = await import('./commands/setup.js');
  await runSetup();
});

// Model management
const modelsCmd = program.command('models').description('Model management');

modelsCmd.command('list').description('List all registered models').action(async () => {
  const { runModelsList } = await import('./commands/models.js');
  await runModelsList();
});

modelsCmd.command('check').description('Health check all models').action(async () => {
  const { runModelsCheck } = await import('./commands/models.js');
  await runModelsCheck();
});

// Default action for `council models` (no subcommand)
modelsCmd.action(async () => {
  const { runModelsList } = await import('./commands/models.js');
  await runModelsList();
});

// Benchmark
program
  .command('benchmark')
  .description('Run ablation benchmark experiments')
  .option('--suite <path>', 'Path to benchmark YAML suite')
  .option('-j, --json', 'Output results as JSON')
  .option('--dry-run', 'Validate suite without running models')
  .action(async (options) => {
    const { runBenchmark } = await import('./commands/benchmark.js');
    await runBenchmark(options);
  });

// History
program
  .command('history')
  .description('View past debate sessions')
  .option('-n, --limit <n>', 'Number of sessions to show', '20')
  .option('--mode <mode>', 'Filter by debate mode')
  .action(async (options) => {
    const { runHistory } = await import('./commands/history.js');
    await runHistory(options);
  });

// Show
program
  .command('show <sessionId>')
  .description('Display session details')
  .action(async (sessionId: string) => {
    const { runShow } = await import('./commands/history.js');
    await runShow(sessionId);
  });

// Recall
program
  .command('recall <keyword>')
  .description('Search past debates by keyword')
  .action(async (keyword: string) => {
    const { runRecall } = await import('./commands/history.js');
    await runRecall(keyword);
  });

// Stats
program
  .command('stats')
  .description('Model performance statistics')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const { runStats } = await import('./commands/stats.js');
    await runStats(options);
  });

// Rate
program
  .command('rate <sessionId> <score>')
  .description('Rate a debate session (1-5)')
  .action(async (sessionId: string, score: string) => {
    const { runRate } = await import('./commands/rate.js');
    await runRate(sessionId, score);
  });

// Replay
program
  .command('replay <sessionId>')
  .description('Replay a debate session stage by stage')
  .action(async (sessionId: string) => {
    const { runReplay } = await import('./commands/replay.js');
    await runReplay(sessionId);
  });

// Export
program
  .command('export <sessionId>')
  .description('Export session to Markdown or JSON')
  .option('-f, --format <format>', 'Output format: markdown | json', 'markdown')
  .action(async (sessionId: string, options) => {
    const { runExport } = await import('./commands/export.js');
    await runExport(sessionId, options);
  });

// Prune
program
  .command('prune')
  .description('Clean up old session data')
  .option('--before <date>', 'Delete sessions before this date (ISO format)')
  .option('--dry-run', 'Show what would be deleted without deleting')
  .action(async (options) => {
    const { runPrune } = await import('./commands/prune.js');
    await runPrune(options);
  });

// Reload
program
  .command('reload')
  .description('Reload configuration files')
  .action(async () => {
    const { ConfigLoader } = await import('./config/loader.js');
    const loader = new ConfigLoader();
    try {
      loader.loadCouncilConfig();
      process.stdout.write('Configuration reloaded successfully.\n');
    } catch (err: unknown) {
      process.stderr.write(
        `Failed to reload: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
