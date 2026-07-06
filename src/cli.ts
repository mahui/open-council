#!/usr/bin/env node

import { Command } from 'commander';

const program = new Command()
  .name('council')
  .description('Open Council — Multi-model debate orchestration system')
  .version('0.1.0');

// Main command: council "question"
program
  .argument('[question]', 'The question to debate')
  .option('-m, --mode <mode>', 'Debate mode: quick | compare | debate | auto')
  .hook('preAction', (cmd) => {
    const mode = cmd.opts().mode;
    if (mode && !['quick', 'compare', 'debate', 'auto'].includes(mode)) {
      process.stderr.write(`Error: invalid mode "${mode}". Must be one of: quick, compare, debate, auto\n`);
      process.exit(1);
    }
  })
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

    // Nothing configured and no env credentials → offer the setup wizard inline
    // (interactive TTY) or point at `council setup` (piped/non-TTY).
    if (!options.models && !options.chairman) {
      const { ConfigLoader } = await import('./config/loader.js');
      const { CredentialManager } = await import('./providers/credentials/discovery.js');
      const loader = new ConfigLoader();
      if (!loader.isConfigured()) {
        const credManager = new CredentialManager();
        const hasAny = Object.keys(credManager.discoverAll()).length > 0;
        if (!hasAny) {
          if (!process.stderr.isTTY) {
            process.stderr.write(
              'Error: No models configured. Run "council setup" to get started.\n',
            );
            process.exit(1);
          }

          process.stderr.write(
            '\n\x1b[33m⚠  未检测到任何配置或可用凭证。\x1b[0m\n',
          );
          const { confirm } = await import('@inquirer/prompts');
          const proceed = await confirm({
            message: '现在进入设置向导？',
            default: true,
          });
          if (!proceed) {
            process.stderr.write(
              '\n已取消。稍后可运行 \x1b[1mcouncil setup\x1b[0m 完成配置。\n\n',
            );
            process.exit(1);
          }

          const { runFirstRunWizard } = await import('./ui/wizard/first-run.js');
          await runFirstRunWizard();

          if (!loader.isConfigured()) {
            // Wizard cancelled or left config incomplete — nothing to run.
            process.exit(0);
          }
          if (!question) {
            process.stderr.write(
              '\n\x1b[32m✓\x1b[0m 配置完成。运行 \x1b[1mcouncil "你的问题"\x1b[0m 开始一场辩论。\n\n',
            );
            process.exit(0);
          }
          // Configured now — seamlessly continue with the original question.
          process.stderr.write('\n\x1b[32m✓\x1b[0m 配置完成，继续执行你的问题…\n\n');
        }
      }
    }

    const { runCouncil } = await import('./commands/council.js');
    await runCouncil(question, options);
  });

// Setup wizard
program.command('setup').description('Configuration wizard').action(async () => {
  const { runSetup } = await import('./commands/setup.js');
  await runSetup();
  process.exit(0);
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

modelsCmd.command('add').description('Add a model (discover official or add a custom endpoint)').action(async () => {
  const { runModelsAdd } = await import('./commands/models.js');
  await runModelsAdd();
});

modelsCmd.command('remove <name>').description('Remove a model by name').action(async (name: string) => {
  const { runModelsRemove } = await import('./commands/models.js');
  runModelsRemove(name);
});

modelsCmd.command('enable <name>').description('Enable a model by name').action(async (name: string) => {
  const { runModelsEnable } = await import('./commands/models.js');
  runModelsEnable(name);
});

modelsCmd.command('disable <name>').description('Disable a model by name').action(async (name: string) => {
  const { runModelsDisable } = await import('./commands/models.js');
  runModelsDisable(name);
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

// Serve — local Web GUI
program
  .command('serve')
  .description('Launch the local Web GUI (loopback only)')
  .option('-p, --port <port>', 'Port to bind', String(3720))
  .option('--no-open', 'Do not auto-open the browser')
  .action(async (options) => {
    const { runServe } = await import('./commands/serve.js');
    await runServe(options);
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
