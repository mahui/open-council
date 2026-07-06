import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { select, checkbox, input, password } from '@inquirer/prompts';
import { PATHS } from '../../config/paths.js';
import { OFFICIAL_BASE_URL } from '../../config/schema.js';
import { CredentialManager } from '../../providers/credentials/discovery.js';
import { discoverModels } from '../../providers/model-discovery.js';
import {
  buildNamedModels,
  buildCustomModelConfig,
  customCredentialPath,
  sanitizeProviderName,
} from '../../providers/model-assembly.js';
import type { ModelConfig, Protocol } from '../../types/config.js';
import { requireConfiguredLoader } from './shared.js';
import { addModelConfig } from './mutations.js';

/**
 * Incrementally register one or more models without re-running the full setup
 * wizard: either pick from the official `/models` discovery, or hand-add a
 * standard-API / custom endpoint (protocol + base_url + model id + optional key).
 * Requires an interactive terminal (it prompts); non-TTY invocations exit 1.
 */
export async function runModelsAdd(): Promise<void> {
  const loader = requireConfiguredLoader();
  if (!process.stdin.isTTY) {
    process.stderr.write('Error: "council models add" requires an interactive terminal.\n');
    process.exit(1);
  }

  const method = await select({
    message: 'How would you like to add a model?',
    choices: [
      { name: 'Discover from an official endpoint (ANTHROPIC_API_KEY / OPENAI_API_KEY)', value: 'discover' },
      { name: 'Add a custom / standard-API endpoint (base_url + model id)', value: 'custom' },
    ],
  });

  const configs = method === 'discover' ? await collectFromDiscovery() : await collectCustomEndpoint();
  if (configs.length === 0) {
    process.stderr.write('No models added.\n');
    return;
  }

  let added = 0;
  for (const cfg of configs) {
    const result = addModelConfig(loader, cfg);
    if (result.status === 'added') {
      added++;
      process.stdout.write(`Added '${cfg.name}' [${cfg.protocol}]\n`);
    } else {
      process.stderr.write(`Skipped '${cfg.name}' — a model with that name already exists.\n`);
    }
  }

  if (added > 0) {
    process.stderr.write(`\n${added} model(s) added. Run "council models check" to verify connectivity.\n`);
  }
}

/** Pick models from live official discovery; [] when no keys/models are found. */
async function collectFromDiscovery(): Promise<ModelConfig[]> {
  const discovered = await discoverModels(new CredentialManager());
  if (discovered.length === 0) {
    process.stderr.write(
      'No models discovered. Set ANTHROPIC_API_KEY / OPENAI_API_KEY, or add a custom endpoint instead.\n',
    );
    return [];
  }

  const picks = await checkbox({
    message: 'Select models to add (space to toggle):',
    choices: discovered.map((m, i) => ({ name: `${m.name}  [${m.protocol}]`, value: String(i) })),
    pageSize: 18,
  });

  const selected = picks.map(k => discovered[Number(k)]).filter((m): m is NonNullable<typeof m> => !!m);
  return buildNamedModels(selected).map(n => n.config);
}

/** Interactively describe one standard-API / custom endpoint → one config per model id. */
async function collectCustomEndpoint(): Promise<ModelConfig[]> {
  const rawName = await input({
    message: 'Endpoint name (lowercase, a-z 0-9 -):',
    validate: (v: string) => (sanitizeProviderName(v) ? true : 'Name must contain at least one letter or digit.'),
  });
  const sanitizedName = sanitizeProviderName(rawName);

  const protocol = await select<Protocol>({
    message: 'Wire protocol (which SDK the endpoint speaks):',
    choices: [
      { name: 'openai    — OpenAI & compatible (DeepSeek, Moonshot, ollama, vLLM…)', value: 'openai' },
      { name: 'anthropic — Anthropic & compatible', value: 'anthropic' },
    ],
    default: 'openai',
  });

  const baseUrl = await input({
    message: 'Base URL (blank → official endpoint; e.g. http://localhost:11434/v1):',
    validate: (v: string) => {
      if (v.trim() === '') return true;
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:' ? true : 'URL must use http or https.';
      } catch {
        return 'Invalid URL.';
      }
    },
  });

  const modelIdsRaw = await input({
    message: 'Model identifier(s) — comma-separated (e.g. gpt-4o or llama3.2,mistral):',
    validate: (v: string) => {
      const ids = parseModelIds(v);
      if (ids.length === 0) return 'At least one model id is required.';
      if (new Set(ids).size !== ids.length) return 'Duplicate model ids in input.';
      return true;
    },
  });
  const modelIds = parseModelIds(modelIdsRaw);

  const apiKey = await password({ message: 'API key (leave empty for no auth, e.g. local ollama):', mask: '*' });

  // Persist the key once (0o600) — every model on this endpoint shares the file.
  let credentialPath: string | undefined;
  if (apiKey.length > 0) {
    mkdirSync(PATHS.credentials, { recursive: true, mode: 0o700 });
    credentialPath = customCredentialPath(sanitizedName);
    writeFileSync(credentialPath, apiKey, { mode: 0o600 });
    chmodSync(credentialPath, 0o600);
  }

  const trimmedBaseUrl = baseUrl.trim();
  return modelIds.map(modelId =>
    buildCustomModelConfig({
      sanitizedName,
      modelId,
      baseUrl: trimmedBaseUrl || OFFICIAL_BASE_URL[protocol],
      protocol,
      ...(credentialPath ? { credentialPath } : {}),
    }),
  );
}

/** Parse a comma-separated model id list, trimming and dropping empties. */
function parseModelIds(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
