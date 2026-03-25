import type { ModelConfig } from '../types/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { AutoAdapter } from '../providers/adapter.js';
import { ApiAdapter } from '../providers/api-adapter.js';
import { CliAdapter } from '../providers/cli-adapter.js';
import { CredentialManager } from '../providers/credentials/discovery.js';
import { PlainRenderer } from '../ui/plain-renderer.js';
import { ConfigLoader } from '../config/loader.js';
import { discoverModelsFromEnv } from '../config/presets.js';
import { PATHS } from '../config/paths.js';
import { SessionStore } from '../storage/session-store.js';
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

  // Discover credentials
  const credentialManager = new CredentialManager();
  await credentialManager.discoverAll();

  // Try config system first, fall back to hardcoded models
  let models: ModelConfig[];
  let chairman: string | undefined = options.chairman;

  const loader = new ConfigLoader();
  if (loader.isConfigured()) {
    try {
      const config = loader.loadCouncilConfig();
      models = loader.loadAllModels();
      if (!chairman) chairman = config.general.default_chairman;
    } catch {
      models = discoverModelsFromEnv();
    }
  } else {
    models = discoverModelsFromEnv();
  }

  if (models.length === 0) {
    process.stderr.write(
      'Error: No models available. Either:\n' +
      '  1. Set API keys: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY\n' +
      '  2. Run "council setup" to configure models\n',
    );
    process.exit(1);
  }

  process.stderr.write(
    `Council: ${models.length} model(s) available [${models.map(m => m.name).join(', ')}]\n\n`,
  );

  const apiAdapter = new ApiAdapter(credentialManager);
  const cliAdapter = new CliAdapter();
  const adapter = new AutoAdapter(apiAdapter, cliAdapter);
  const renderer = new PlainRenderer();

  const orchestrator = new Orchestrator(
    adapter,
    renderer,
    models,
    chairman,
  );

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
  };

  const session = await orchestrator.run(question, runOptions);

  // Persist session unless --no-store
  if (!options.noStore) {
    try {
      const store = new SessionStore(PATHS.sessionsDir);
      await store.saveSession(session);
    } catch {
      // Non-fatal: directory may not exist yet
    }
  }

  // Output
  if (options.json) {
    process.stdout.write(JSON.stringify(session, null, 2) + '\n');
  } else {
    renderer.renderResult(session);
  }
}
