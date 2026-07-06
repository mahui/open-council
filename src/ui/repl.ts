/**
 * Interactive REPL — council's main interactive interface.
 * Type questions directly, press / to pick commands.
 */

import { CredentialManager } from '../providers/credentials/discovery.js';
import { discoverModelsFromEnv } from '../config/presets.js';
import { ConfigLoader } from '../config/loader.js';
import { Orchestrator } from '../core/orchestrator.js';
import { ApiAdapter } from '../providers/api-adapter.js';
import { PlainRenderer } from './plain-renderer.js';
import { LiveRenderer } from './live-renderer.js';
import { SessionStore } from '../storage/session-store.js';
import { PATHS } from '../config/paths.js';
import { showSlashPicker, type SlashCommand } from './slash-picker.js';
import { formatConfigError } from '../shared/config-errors.js';
import { formatModelLine } from '../shared/format-model.js';
import { startInput, type InputController } from './input.js';
import type { ModelConfig } from '../types/config.js';
import type { DebateMode, RunOptions } from '../types/session.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

const COMMANDS: SlashCommand[] = [
  { name: '/mode', args: '<quick|compare|debate|auto>', desc: 'Set debate mode' },
  { name: '/models', desc: 'List available models' },
  { name: '/chairman', args: '<model-name>', desc: 'Set chairman model' },
  { name: '/setup', desc: 'Run configuration wizard' },
  { name: '/history', desc: 'View past debates' },
  { name: '/stats', desc: 'Model performance stats' },
  { name: '/health', desc: 'Provider health status' },
  { name: '/clear', desc: 'Clear screen' },
  { name: '/help', desc: 'Show help' },
  { name: '/quit', desc: 'Exit' },
];

interface ReplState {
  mode: DebateMode;
  models: ModelConfig[];
  chairman?: string;
  /** Role-panel designer model from council.yaml (general.role_generator_model). */
  roleGenModel?: ModelConfig;
  /** Agent-seat bounds from council.yaml (general.min_agents / max_agents). */
  minAgents?: number;
  maxAgents?: number;
  /** Ordered model preference from council.yaml (routing.default.prefer). */
  prefer?: string[];
  credentialManager: CredentialManager;
  adapter: ApiAdapter;
  sessionCount: number;
  input?: InputController;
}

/** Resolve the role-generator model (by name) from loaded config, if configured. */
function resolveRoleGenModel(roleGenName: string | undefined, models: ModelConfig[]): ModelConfig | undefined {
  return roleGenName ? models.find(m => m.name === roleGenName) : undefined;
}

export async function startRepl(): Promise<void> {
  // Initialize
  process.stderr.write(`\n${BOLD}🏛️  Open Council${RESET} ${DIM}v0.1.0${RESET}\n`);
  process.stderr.write(`${DIM}Multi-model debate orchestration system${RESET}\n\n`);

  process.stderr.write(`${DIM}Scanning credentials...${RESET}`);
  const credentialManager = new CredentialManager();
  await credentialManager.discoverAll();

  let models: ModelConfig[];
  let chairman: string | undefined;
  let roleGenModel: ModelConfig | undefined;
  let minAgents: number | undefined;
  let maxAgents: number | undefined;
  let prefer: string[] | undefined;
  const loader = new ConfigLoader();

  if (loader.isConfigured()) {
    try {
      const config = loader.loadCouncilConfig();
      models = loader.loadAllModels();
      chairman = config.general.default_chairman;
      roleGenModel = resolveRoleGenModel(config.general.role_generator_model, models);
      minAgents = config.general.min_agents;
      maxAgents = config.general.max_agents;
      prefer = config.routing.default.prefer;
    } catch (err) {
      process.stderr.write(`\r${YELLOW}⚠ 配置无法加载，已回落到环境变量发现的模型（可能与你配置的模型不同）。${RESET}\n`);
      process.stderr.write(formatConfigError(err, PATHS.config) + '\n');
      process.stderr.write(`  ${DIM}运行 ${CYAN}council setup${RESET}${DIM} 修复配置。${RESET}\n`);
      models = discoverModelsFromEnv();
    }
  } else {
    models = discoverModelsFromEnv();
  }

  if (models.length === 0) {
    process.stderr.write(`\r${YELLOW}⚠ No models available.${RESET}\n`);
    if (process.stderr.isTTY) {
      const { confirm } = await import('@inquirer/prompts');
      const proceed = await confirm({ message: '未检测到可用模型，现在进入设置向导？', default: true });
      if (proceed) {
        const { runFirstRunWizard } = await import('./wizard/first-run.js');
        await runFirstRunWizard();
        if (loader.isConfigured()) {
          try {
            const config = loader.loadCouncilConfig();
            models = loader.loadAllModels();
            chairman = config.general.default_chairman;
            roleGenModel = resolveRoleGenModel(config.general.role_generator_model, models);
            minAgents = config.general.min_agents;
            maxAgents = config.general.max_agents;
            prefer = config.routing.default.prefer;
          } catch (err) {
            process.stderr.write(formatConfigError(err, PATHS.config) + '\n');
          }
        }
      }
    }
    if (models.length === 0) {
      process.stderr.write(`  Set ${CYAN}ANTHROPIC_API_KEY${RESET} or ${CYAN}OPENAI_API_KEY${RESET}, or add a custom endpoint.\n`);
      process.stderr.write(`  Type ${CYAN}/${RESET} then select ${CYAN}/setup${RESET} for guided configuration.\n\n`);
    }
  }

  if (models.length > 0) {
    const modelList = models.map(m => m.name).join(', ');
    process.stderr.write(`\r${GREEN}✓${RESET} ${models.length} model(s): ${DIM}${modelList}${RESET}\n`);
  }

  process.stderr.write(`\n  Type a question to start a debate.\n`);
  process.stderr.write(`  ${DIM}Press ${CYAN}/${RESET}${DIM} for commands, Ctrl-C to exit${RESET}\n\n`);

  const adapter = new ApiAdapter(credentialManager);

  const state: ReplState = {
    mode: 'auto',
    models,
    chairman,
    roleGenModel,
    minAgents,
    maxAgents,
    prefer,
    credentialManager,
    adapter,
    sessionCount: 0,
  };

  const promptStr = `${BOLD}council ❯${RESET} `;

  return new Promise<void>((resolve) => {
    state.input = startInput({
      prompt: promptStr,

      onSlash: async () => {
        const result = await showSlashPicker(COMMANDS, promptStr);
        if (result.command) {
          await handleCommand('/' + result.command, state);
        }
      },

      onLine: async (input) => {
        if (input.startsWith('/')) {
          await handleCommand(input, state);
        } else {
          await handleQuestion(input, state);
        }
      },

      onClose: () => {
        process.stderr.write(`${DIM}Goodbye.${RESET}\n`);
        resolve();
      },
    });
  });
}

async function handleCommand(input: string, state: ReplState): Promise<void> {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case 'help':
    case 'h':
      printHelp();
      break;

    case 'mode':
    case 'm':
      if (args[0] && ['quick', 'compare', 'debate', 'auto'].includes(args[0])) {
        state.mode = args[0] as DebateMode;
        process.stderr.write(`  Mode set to ${BOLD}${state.mode}${RESET}\n`);
      } else {
        process.stderr.write(`  Current mode: ${BOLD}${state.mode}${RESET}\n`);
        process.stderr.write(`  ${DIM}Usage: /mode <quick|compare|debate|auto>${RESET}\n`);
      }
      break;

    case 'models':
      process.stderr.write(`\n  ${BOLD}Available Models${RESET}\n`);
      for (const m of state.models) {
        const line = formatModelLine(m, { chairman: m.name === state.chairman });
        process.stderr.write(`  • ${line}\n`);
      }
      process.stderr.write('\n');
      break;

    case 'chairman':
      if (args[0]) {
        const found = state.models.find(m => m.name === args[0] || m.model === args[0]);
        if (found) {
          state.chairman = found.name;
          process.stderr.write(`  Chairman set to ${BOLD}${found.name}${RESET}\n`);
        } else {
          process.stderr.write(`  ${YELLOW}Model not found: ${args[0]}${RESET}\n`);
        }
      } else {
        process.stderr.write(`  Current chairman: ${BOLD}${state.chairman ?? 'auto'}${RESET}\n`);
        process.stderr.write(`  ${DIM}Usage: /chairman <model-name>${RESET}\n`);
      }
      break;

    case 'setup': {
      // Wizard's inquirer prompts must own stdin; release REPL's raw-mode handler
      // and reattach after — otherwise stale Enter events break complex prompts (checkbox).
      state.input?.suspend();
      try {
        const { runSetup } = await import('../commands/setup.js');
        await runSetup();
        const loader = new ConfigLoader();
        if (loader.isConfigured()) {
          try {
            const config = loader.loadCouncilConfig();
            state.models = loader.loadAllModels();
            state.chairman = config.general.default_chairman;
            state.roleGenModel = resolveRoleGenModel(config.general.role_generator_model, state.models);
            state.minAgents = config.general.min_agents;
            state.maxAgents = config.general.max_agents;
            state.prefer = config.routing.default.prefer;
            process.stderr.write(`  ${GREEN}✓${RESET} Configuration reloaded.\n`);
          } catch (err) {
            process.stderr.write(`  ${YELLOW}⚠ Config reload failed: ${err instanceof Error ? err.message : err}${RESET}\n`);
          }
        }
      } finally {
        state.input?.resume();
      }
      break;
    }

    case 'history':
      try {
        const { runHistory } = await import('../commands/history.js');
        await runHistory({ limit: '10' });
      } catch (err) {
        process.stderr.write(`  ${DIM}No history available: ${err instanceof Error ? err.message : err}${RESET}\n`);
      }
      break;

    case 'stats':
      try {
        const { runStats } = await import('../commands/stats.js');
        await runStats({});
      } catch (err) {
        process.stderr.write(`  ${DIM}No stats available: ${err instanceof Error ? err.message : err}${RESET}\n`);
      }
      break;

    case 'health': {
      const { getHealthSummary } = await import('../providers/health.js');
      const summary = getHealthSummary();
      if (summary.length === 0) {
        process.stderr.write(`  ${DIM}No provider calls yet.${RESET}\n`);
      } else {
        process.stderr.write(`\n  ${BOLD}Provider Health${RESET}\n`);
        for (const s of summary) {
          const icon = s.status === 'healthy' ? `${GREEN}✓` : s.status === 'degraded' ? `${YELLOW}⚠` : `${'\x1b[31m'}✗`;
          process.stderr.write(`  ${icon}${RESET} ${s.provider.padEnd(12)} ${DIM}status=${s.status} failures=${s.failures} throttle=${s.throttleMs}ms${RESET}\n`);
        }
        process.stderr.write('\n');
      }
      break;
    }

    case 'clear':
      process.stderr.write('\x1b[2J\x1b[H');
      break;

    case 'quit':
    case 'q':
    case 'exit':
      process.stderr.write(`${DIM}Goodbye.${RESET}\n`);
      process.exit(0);
      break;

    default:
      process.stderr.write(`  ${YELLOW}Unknown command: /${cmd}${RESET}\n`);
      process.stderr.write(`  ${DIM}Press / for available commands${RESET}\n`);
  }
}

async function handleQuestion(question: string, state: ReplState): Promise<void> {
  if (state.models.length === 0) {
    process.stderr.write(`  ${YELLOW}No models configured. Press / and select /setup${RESET}\n`);
    return;
  }

  state.sessionCount++;
  const useLive = process.stderr.isTTY;
  const renderer = useLive ? new LiveRenderer() : new PlainRenderer();
  const orchestrator = new Orchestrator(
    state.adapter,
    renderer,
    state.models,
    state.chairman,
    { min: state.minAgents, max: state.maxAgents },
    state.roleGenModel,
    undefined,
    state.prefer,
  );

  const runOptions: RunOptions = {
    mode: state.mode,
    chairman: state.chairman,
  };

  try {
    const session = await orchestrator.run(question, runOptions);

    try {
      const store = new SessionStore(PATHS.sessionsDir);
      await store.saveSession(session);
    } catch (err) {
      process.stderr.write(`Warning: failed to save session: ${err instanceof Error ? err.message : err}\n`);
    }

    renderer.renderResult(session);

    // Live renderer: stay in browse mode until user presses q
    if (useLive && renderer instanceof LiveRenderer) {
      await renderer.browse();
    }
  } catch (err) {
    process.stderr.write(`\x1b[?25h`); // show cursor on error
    process.stderr.write(`  ${YELLOW}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
  }
}

function printHelp(): void {
  process.stderr.write(`\n  ${BOLD}Commands${RESET} ${DIM}(press / to pick interactively)${RESET}\n\n`);
  const maxLen = Math.max(...COMMANDS.map(c => (c.name + (c.args ? ' ' + c.args : '')).length));
  for (const c of COMMANDS) {
    const left = c.name + (c.args ? ' ' + c.args : '');
    process.stderr.write(`  ${CYAN}${left.padEnd(maxLen + 2)}${RESET}${DIM}${c.desc}${RESET}\n`);
  }
  process.stderr.write(`
  ${BOLD}Usage${RESET}

  Type any question to start a debate.
  Press ${CYAN}/${RESET} to open the command picker.

  ${DIM}quick${RESET}    Single model, fast response
  ${DIM}compare${RESET}  Multiple models + synthesis
  ${DIM}debate${RESET}   Full debate with peer review + multi-round
  ${DIM}auto${RESET}     Automatically choose based on question

`);
}

