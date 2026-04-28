import { confirm } from '@inquirer/prompts';
import type { ModelConfig } from '../types/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { AutoAdapter } from '../providers/adapter.js';
import { ApiAdapter } from '../providers/api-adapter.js';
import { CliAdapter } from '../providers/cli-adapter.js';
import { CredentialManager } from '../providers/credentials/discovery.js';
import { PlainRenderer } from '../ui/plain-renderer.js';
import type { Renderer } from '../ui/renderer.js';
import { ConfigLoader } from '../config/loader.js';
import { discoverModelsFromEnv } from '../config/presets.js';
import { PATHS } from '../config/paths.js';
import { SessionStore } from '../storage/session-store.js';
import { hasViewableContent, startViewer } from '../ui/viewer.js';
import type { DebateMode, RunOptions } from '../types/session.js';

interface CouncilOptions {
  mode: string;
  chairman?: string;
  models?: string[];
  interactive?: boolean;
  noStore?: boolean;
  resume?: string | boolean;
  tag?: string[];
  json?: boolean;
  devilAdvocate?: boolean;
  roleSet?: string;
  follow?: string;
  copy?: boolean;
  force?: boolean;
}

export async function runCouncil(question: string | undefined, options: CouncilOptions): Promise<void> {
  if (!question) {
    process.stderr.write('Usage: council "your question"\n');
    process.exit(1);
  }

  const store = new SessionStore(PATHS.sessionsDir);

  // Search similar historical sessions once — used for reuse offer (TTY) + context injection
  let historicalContext: string | undefined;
  if (!options.noStore) {
    try {
      const similar = await store.searchSimilar(question, 3);
      const completed = similar.filter(s => s.status === 'completed' && s.synthesis);

      // In TTY mode: offer to reuse a high-confidence (≥ 0.8) match
      if (process.stderr.isTTY && !options.json) {
        const bestMatch = completed.find(
          s => (s.consensus?.consensus_score ?? 0) >= 0.8,
        );
        if (bestMatch) {
          process.stderr.write(`\n\x1b[36m💡 Found highly similar past debate (Consensus: ${bestMatch.consensus!.consensus_score.toFixed(2)})\x1b[0m\n`);
          process.stderr.write(`\x1b[2mQuestion: ${bestMatch.question.substring(0, 100)}...\x1b[0m\n`);

          const reuse = await confirm({ message: 'Would you like to review the historical synthesis instead of running a new debate?' });
          if (reuse) {
            process.stderr.write('\n');
            const renderer = new PlainRenderer();
            renderer.renderResult(bestMatch);
            if (hasViewableContent(bestMatch) && bestMatch.agents.length > 1) {
              process.stderr.write(`\n${'\x1b[2m'}Press Enter to explore responses, or q to exit...${'\x1b[0m'}`);
              const shouldView = await waitForKey();
              if (shouldView) {
                await startViewer(bestMatch);
              }
            }
            store.close();
            return;
          }
        }
      }

      // Always (TTY or not): silently inject medium-confidence (≥ 0.6) matches as broadcast context
      const contextSessions = completed.filter(
        s => (s.consensus?.consensus_score ?? 0) >= 0.6,
      );
      if (contextSessions.length > 0) {
        const parts = contextSessions.slice(0, 2).map(
          s => `Q: "${s.question.substring(0, 120)}"\nConclusion: ${s.synthesis!.substring(0, 400)}`,
        );
        historicalContext = parts.join('\n\n---\n\n');
        if (process.stderr.isTTY && !options.json) {
          process.stderr.write(
            `\x1b[2m💡 Found ${contextSessions.length} related past debate(s) — injecting as context\x1b[0m\n`,
          );
        }
      }
    } catch {
      // ignore FTS search errors
    }
  }

  // Discover credentials
  const credentialManager = new CredentialManager();
  await credentialManager.discoverAll();

  // Try config system first, fall back to hardcoded models
  let models: ModelConfig[];
  let chairman: string | undefined = options.chairman;
  let tuiMode: 'auto' | 'always' | 'never' = 'auto';

  const loader = new ConfigLoader();
  if (loader.isConfigured()) {
    try {
      const config = loader.loadCouncilConfig();
      models = loader.loadAllModels();
      if (!chairman) chairman = config.general.default_chairman;
      tuiMode = config.output.tui_mode;
    } catch (err) {
      process.stderr.write(`Warning: config error, falling back to env discovery: ${err instanceof Error ? err.message : err}\n`);
      models = discoverModelsFromEnv(credentialManager);
    }
  } else {
    models = discoverModelsFromEnv(credentialManager);
  }

  if (models.length === 0) {
    process.stderr.write(
      'Error: No models available. Either:\n' +
      '  1. Set API keys: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY\n' +
      '  2. Run "council setup" to configure models\n',
    );
    process.exit(1);
  }

  const modelList = models.map(m => `${m.name}${m.invocation === 'cli' ? ' (CLI)' : ''}`).join(', ');
  const isTTY = process.stderr.isTTY;
  process.stderr.write(
    isTTY
      ? `\x1b[1m🏛️  Council\x1b[0m \x1b[2m${models.length} model(s): ${modelList}\x1b[0m\n`
      : `Council: ${models.length} model(s): ${modelList}\n`,
  );

  const apiAdapter = new ApiAdapter(credentialManager);
  const cliAdapter = new CliAdapter();
  const adapter = new AutoAdapter(apiAdapter, cliAdapter);
  const renderer = await createRenderer(question, options, tuiMode);

  const orchestrator = new Orchestrator(
    adapter,
    renderer,
    models,
    chairman,
  );

  // Load parent session synthesis when --follow is used
  let parentSynthesis: string | undefined;
  if (options.follow) {
    try {
      const parentSession = await store.getSession(options.follow);
      if (parentSession?.synthesis) {
        parentSynthesis = parentSession.synthesis;
      }
    } catch {
      // ignore — orchestrator will run without parent context
    }
  }

  const runOptions: RunOptions = {
    mode: (options.mode ?? 'auto') as DebateMode,
    chairman: options.chairman,
    models: options.models,
    interactive: options.interactive,
    noStore: options.noStore,
    tags: options.tag,
    devilAdvocate: options.devilAdvocate,
    roleSet: options.roleSet,
    parentSessionId: options.follow,
    parentSynthesis,
    historicalContext,
  };

  const session = await orchestrator.run(question, runOptions);

  // Persist session unless --no-store
  if (!options.noStore) {
    try {
      await store.saveSession(session);
    } catch (err) {
      process.stderr.write(`Warning: failed to save session: ${err instanceof Error ? err.message : err}\n`);
    }
  }

  store.close();

  // Output
  if (options.json) {
    process.stdout.write(JSON.stringify(session, null, 2) + '\n');
  } else {
    renderer.renderResult(session);

    // Interactive viewer in TTY mode with multiple agents
    if (process.stderr.isTTY && hasViewableContent(session) && session.agents.length > 1) {
      process.stderr.write(`\n${'\x1b[2m'}Press Enter to explore responses, or q to exit...${'\x1b[0m'}`);
      const shouldView = await waitForKey();
      if (shouldView) {
        await startViewer(session);
      }
    }
  }
}

function waitForKey(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(false); return; }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    const onData = (key: string): void => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (key === '\r' || key === '\n' || key === ' ') {
        resolve(true);
      } else {
        process.stderr.write('\n');
        resolve(false);
      }
    };
    process.stdin.on('data', onData);
  });
}

async function createRenderer(
  question: string,
  options: CouncilOptions,
  tuiMode: 'auto' | 'always' | 'never',
): Promise<Renderer> {
  const useTui = process.stderr.isTTY
    && !options.json
    && tuiMode !== 'never';

  if (useTui) {
    try {
      const { TuiRenderer } = await import('../ui/tui/TuiRenderer.js');
      return new TuiRenderer(question, options.mode ?? 'auto');
    } catch {
      // ink/react not installed or failed — fall back to PlainRenderer
    }
  }
  return new PlainRenderer();
}
