import type { ModelConfig, RoleSet } from '../types/config.js';
import { Orchestrator } from '../core/orchestrator.js';
import { ConfigLoader } from '../config/loader.js';
import { RoleSetNotFoundError } from '../types/errors.js';
import { createRenderer } from '../ui/renderer-factory.js';
import { offerViewer } from '../ui/interactive.js';
import { PATHS } from '../config/paths.js';
import { SessionStore } from '../storage/session-store.js';
import { discoverCredentials, buildAdapter, resolveModels } from './shared/assemble.js';
import { resolveHistoricalContext } from './shared/history-context.js';
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

  // Search historical sessions: reuse offer (TTY) + context injection
  const { historicalContext, reused } = await resolveHistoricalContext(store, question, options);
  if (reused) {
    store.close();
    return;
  }

  // Discover credentials + resolve models from config or env
  const credentialManager = await discoverCredentials();
  const { models, chairman: configChairman, roleGenModel, minAgents, maxAgents, tuiMode } = resolveModels(credentialManager, { loadGeneralConfig: true });
  const chairman = options.chairman ?? configChairman;

  if (models.length === 0) {
    process.stderr.write(
      'Error: No models available. Either:\n' +
      '  1. Set API keys: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY\n' +
      '  2. Run "council setup" to configure models\n',
    );
    process.exit(1);
  }

  printModelBanner(models);

  // Explicit --role-set override: load the named template up-front so a missing
  // set fails fast with a clear message before any model is invoked. When
  // omitted, roles are generated dynamically (unchanged behavior).
  const explicitRoleSet = options.roleSet ? loadRoleSetOrExit(options.roleSet) : undefined;
  if (explicitRoleSet) {
    process.stderr.write(
      `Using role set "${options.roleSet}" (${Object.keys(explicitRoleSet.roles).length} roles)\n`,
    );
  }

  const adapter = buildAdapter(credentialManager);
  const renderer = await createRenderer({ question, mode: options.mode, json: options.json, tuiMode });
  const orchestrator = new Orchestrator(adapter, renderer, models, chairman, { min: minAgents, max: maxAgents }, roleGenModel, explicitRoleSet);

  const parentSynthesis = options.follow ? await loadParentSynthesis(store, options.follow) : undefined;

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
    await offerViewer(session);
  }
}

/** Print the active-models banner to stderr (TTY-aware formatting). */
function printModelBanner(models: ModelConfig[]): void {
  const modelList = models.map(m => `${m.name}${m.invocation === 'cli' ? ' (CLI)' : ''}`).join(', ');
  process.stderr.write(
    process.stderr.isTTY
      ? `\x1b[1m🏛️  Council\x1b[0m \x1b[2m${models.length} model(s): ${modelList}\x1b[0m\n`
      : `Council: ${models.length} model(s): ${modelList}\n`,
  );
}

/**
 * Load an explicit role set by name, exiting with a clear, actionable error
 * (listing available sets) when it cannot be resolved or is empty.
 */
function loadRoleSetOrExit(name: string): RoleSet {
  const loader = new ConfigLoader();
  let roleSet: RoleSet;
  try {
    roleSet = loader.loadRoleSet(name);
  } catch (err) {
    if (err instanceof RoleSetNotFoundError) {
      const available = loader.listRoleSets();
      process.stderr.write(
        `Error: role set "${name}" not found.\n` +
        (available.length > 0
          ? `Available role sets: ${available.join(', ')}\n`
          : 'No role sets available.\n'),
      );
      process.exit(1);
    }
    throw err;
  }

  if (!roleSet.roles || Object.keys(roleSet.roles).length === 0) {
    process.stderr.write(`Error: role set "${name}" defines no roles.\n`);
    process.exit(1);
  }

  return roleSet;
}

/** Load a parent session's synthesis for --follow context (best-effort). */
async function loadParentSynthesis(store: SessionStore, parentId: string): Promise<string | undefined> {
  try {
    const parentSession = await store.getSession(parentId);
    return parentSession?.synthesis;
  } catch {
    return undefined;
  }
}
