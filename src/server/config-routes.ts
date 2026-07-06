/**
 * Config routes (design-notes/web-gui-config.md §4). The Web GUI settings面：
 * read a redacted config projection, edit the high-frequency general fields,
 * toggle models, add a custom OpenAI-compatible endpoint, and rescan credentials.
 *
 * Security invariants (SEC-02):
 *  - OUT: no response body ever contains an API key / token / credential-file
 *    content. Custom endpoints expose only `apiBaseUrl` + `hasCredentialFile`.
 *  - IN: a submitted key is written straight to a 0o600 file, never logged,
 *    never echoed back.
 *
 * Optimistic locking (§4.3): council.yaml carries a content-hash `version`;
 * each model file carries its own independent hash. Writes must echo the token
 * they read; a mismatch returns 409 with the current state so the client rebases.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { PATHS } from '../config/paths.js';
import type { ConfigLoader } from '../config/loader.js';
import type { CouncilConfig, ModelConfig } from '../types/config.js';
import { assembleConfig } from '../config/assemble-council.js';
import { CredentialManager } from '../providers/credentials/discovery.js';
import { discoverModels } from '../providers/model-discovery.js';
import {
  buildNamedModels,
  buildCustomModelConfig,
  customCredentialPath,
  sanitizeProviderName,
} from '../providers/model-assembly.js';
import type { RuntimeConfig } from './runtime-config.js';
import { reloadRuntime } from './runtime-config.js';
import type {
  ConfigDTO,
  ModelSettingDTO,
  RescanSummaryDTO,
} from './protocol.js';

export interface ConfigRouteDeps {
  runtime: RuntimeConfig;
  loader: ConfigLoader;
  /** Credential set the boot adapter was built from (rescan replaces it). */
  credentialManager: CredentialManager;
  /**
   * Directory custom-endpoint key files land in. Defaults to the real
   * `~/.council/credentials`; injected in tests to avoid touching the user's
   * credential store.
   */
  credentialsDir?: string;
}

// —— request schemas —— //

const GeneralPatchSchema = z
  .object({
    default_mode: z.enum(['quick', 'compare', 'debate', 'auto']).optional(),
    default_chairman: z.string().optional(),
    role_generator_model: z.string().optional(),
    min_agents: z.number().int().min(1).optional(),
    max_agents: z.number().int().min(1).optional(),
    devil_advocate: z.enum(['auto', 'always', 'never']).optional(),
    language: z.enum(['auto', 'zh', 'en']).optional(),
  })
  .strict(); // reject read-only / unknown fields — only the editable面 is writable

const UpdateConfigSchema = z.object({
  general: GeneralPatchSchema.optional(),
  prefer: z.array(z.string()).optional(),
  version: z.string(),
});

const ModelPatchSchema = z.object({
  enabled: z.boolean(),
  version: z.string(),
});

const CustomProviderSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  modelIds: z.array(z.string().min(1)).min(1),
  apiKey: z.string().optional(),
});

/** Build the config router (mounted under `/api` by routes.ts). */
export function createConfigRoutes(deps: ConfigRouteDeps): Hono {
  const api = new Hono();

  // GET /api/config — redacted projection + optimistic-lock version.
  api.get('/config', (c) => {
    if (deps.loader.readCouncilConfigRaw() === null) {
      return c.json({ error: 'council.yaml not found' }, 404);
    }
    return c.json(buildConfigDTO(deps.loader));
  });

  // PUT /api/config — merge editable general fields + prefer onto council.yaml.
  api.put('/config', async (c) => {
    const body = await parseJson(c);
    if (body === undefined) return c.json({ error: 'invalid JSON body' }, 400);
    const parsed = UpdateConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.flatten() }, 400);
    }

    const raw = deps.loader.readCouncilConfigRaw();
    if (raw === null) return c.json({ error: 'council.yaml not found' }, 404);
    if (parsed.data.version !== hashContent(raw)) {
      return c.json({ error: 'version conflict', current: buildConfigDTO(deps.loader) }, 409);
    }

    const base = deps.loader.loadCouncilConfig();
    const generalOverride = (parsed.data.general ?? {}) as Partial<CouncilConfig['general']>;
    const prefer = parsed.data.prefer ?? base.routing.default.prefer;
    const chairman = generalOverride.default_chairman ?? base.general.default_chairman;

    const invalid = validateConfigUpdate(deps.loader, { generalOverride, prefer, chairman, base });
    if (invalid) return c.json({ error: invalid }, 400);

    const next = assembleConfig({ generalOverride, prefer, chairman, base });
    deps.loader.saveCouncilConfig(next);
    reloadRuntime(deps.runtime, deps.loader, deps.credentialManager);
    // Non-blocking advisory: a disabled chairman is legal (the orchestrator falls
    // back to the strongest enabled model via selectStrongestModel), so we save
    // and warn rather than 400 — see validateConfigUpdate for the strict guard.
    const dto = buildConfigDTO(deps.loader);
    const warning = chairmanWarning(deps.loader, chairman);
    return c.json(warning ? { ...dto, warning } : dto);
  });

  // PATCH /api/models/:name — flip a model's enabled flag (own optimistic lock).
  api.patch('/models/:name', async (c) => {
    const name = c.req.param('name');
    const body = await parseJson(c);
    if (body === undefined) return c.json({ error: 'invalid JSON body' }, 400);
    const parsed = ModelPatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.flatten() }, 400);
    }

    let raw: string | null;
    try {
      raw = deps.loader.readModelConfigRaw(name);
    } catch (err) {
      // safePath throws on a traversal attempt via the :name param.
      if (err instanceof Error && err.message.startsWith('Path traversal detected')) {
        return c.json({ error: 'invalid model name' }, 400);
      }
      throw err;
    }
    if (raw === null) return c.json({ error: 'model not found' }, 404);
    if (parsed.data.version !== hashContent(raw)) {
      const current = deps.loader.loadModelConfig(name);
      return c.json(
        { error: 'version conflict', current: current ? toModelDTO(current, hashContent(raw)) : null },
        409,
      );
    }

    const model = deps.loader.loadModelConfig(name);
    if (!model) return c.json({ error: 'model not found' }, 404);
    model.enabled = parsed.data.enabled;
    deps.loader.saveModelConfig(model);
    reloadRuntime(deps.runtime, deps.loader, deps.credentialManager);
    // Re-hash the file we just wrote so the client gets the fresh lock token.
    return c.json(toModelDTO(model, modelVersion(deps.loader, name)));
  });

  // POST /api/providers/custom — add a custom OpenAI-compatible endpoint (§3).
  api.post('/providers/custom', async (c) => {
    const body = await parseJson(c);
    if (body === undefined) return c.json({ error: 'invalid JSON body' }, 400);
    const parsed = CustomProviderSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.flatten() }, 400);
    }
    const sanitized = sanitizeProviderName(parsed.data.name);
    if (!sanitized) return c.json({ error: 'provider name must contain a letter or digit' }, 400);
    if (!isHttpUrl(parsed.data.baseUrl)) {
      return c.json({ error: 'baseUrl must use http or https' }, 400);
    }
    if (new Set(parsed.data.modelIds).size !== parsed.data.modelIds.length) {
      return c.json({ error: 'duplicate model ids' }, 400);
    }

    // Persist the key straight to a 0o600 file — never logged, never echoed (SEC-02).
    const credentialsDir = deps.credentialsDir ?? PATHS.credentials;
    let credPath: string | undefined;
    if (parsed.data.apiKey && parsed.data.apiKey.length > 0) {
      mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
      credPath = customCredentialPath(sanitized, credentialsDir);
      writeFileSync(credPath, parsed.data.apiKey);
      chmodSync(credPath, 0o600);
    }

    const added: string[] = [];
    for (const modelId of parsed.data.modelIds) {
      const cfg = buildCustomModelConfig({
        sanitizedName: sanitized,
        modelId,
        baseUrl: parsed.data.baseUrl,
        credentialPath: credPath,
      });
      deps.loader.saveModelConfig(cfg);
      added.push(cfg.name);
    }

    // Custom keys are re-read from disk at invoke time, so no adapter rebuild.
    reloadRuntime(deps.runtime, deps.loader, deps.credentialManager);
    return c.json({ added, ok: true });
  });

  // POST /api/setup/rescan — discover credentials + models, non-destructive upsert.
  api.post('/setup/rescan', async (c) => {
    const credentialManager = new CredentialManager();
    const report = await credentialManager.discoverAll();
    const discovered = await discoverModels(credentialManager);

    const existingNames = new Set(deps.loader.loadAllModelConfigs().map((m) => m.name));
    const added: string[] = [];
    const existing: string[] = [];
    for (const n of buildNamedModels(discovered)) {
      if (existingNames.has(n.config.name)) {
        existing.push(n.config.name);
      } else {
        deps.loader.saveModelConfig(n.config);
        added.push(n.config.name);
      }
    }

    // Keep council.yaml's routing in step with the models we just added: a rescan
    // that surfaces new models must not leave them out of `prefer` (that's exactly
    // the "models are there but prefer drifted" bug). Same assembleConfig gate as
    // every other write, so pre-existing duplicates get cleaned up here too.
    if (added.length > 0 && deps.loader.readCouncilConfigRaw() !== null) {
      const base = deps.loader.loadCouncilConfig();
      const next = assembleConfig({
        generalOverride: {},
        prefer: [...base.routing.default.prefer, ...added],
        chairman: base.general.default_chairman,
        base,
      });
      deps.loader.saveCouncilConfig(next);
    }

    // New creds may exist → rebuild the adapter from the fresh credential set.
    reloadRuntime(deps.runtime, deps.loader, credentialManager, { rebuildAdapter: true });

    const summary: RescanSummaryDTO = {
      credentials: Object.entries(report).map(([provider, r]) => ({
        provider,
        status: r.status,
        source: r.source,
      })),
      models: { added, existing },
    };
    return c.json(summary);
  });

  return api;
}

// ---------- projection (redaction) ----------

/**
 * Project a ModelConfig to its wire shape — never exposes credentials.
 * `version` is the sha256 of the model's on-disk YAML bytes (its per-file
 * optimistic-lock token, echoed by PATCH; §4.3).
 */
function toModelDTO(m: ModelConfig, version: string): ModelSettingDTO {
  const isCustom = (m.provider ?? '').startsWith('custom:');
  const dto: ModelSettingDTO = {
    name: m.name,
    provider: m.provider,
    invocation: m.invocation,
    capabilities: m.capabilities,
    enabled: m.enabled,
    isCustom,
    // Existence only — never the file's contents (SEC-02).
    hasCredentialFile: !!m.api_credential_path && existsSync(m.api_credential_path),
    version,
  };
  if (isCustom && m.api_base_url) dto.apiBaseUrl = m.api_base_url;
  return dto;
}

/** sha256 of a model's on-disk YAML bytes — the per-file optimistic-lock token. */
function modelVersion(loader: ConfigLoader, name: string): string {
  const raw = loader.readModelConfigRaw(name);
  return raw === null ? '' : hashContent(raw);
}

/** Build the full redacted config projection from on-disk truth. */
function buildConfigDTO(loader: ConfigLoader): ConfigDTO {
  const raw = loader.readCouncilConfigRaw();
  const config = loader.loadCouncilConfig();
  return {
    version: raw ? hashContent(raw) : '',
    general: {
      default_mode: config.general.default_mode,
      default_chairman: config.general.default_chairman,
      role_generator_model: config.general.role_generator_model ?? '',
      min_agents: config.general.min_agents,
      max_agents: config.general.max_agents,
      devil_advocate: config.general.devil_advocate,
      language: config.general.language,
    },
    prefer: config.routing.default.prefer,
    models: loader.loadAllModelConfigs().map((m) => toModelDTO(m, modelVersion(loader, m.name))),
    readOnly: {
      schema_version: config.schema_version,
      storage: {
        data_dir: config.storage.data_dir,
        checkpoint_dir: config.storage.checkpoint_dir,
        log_dir: config.storage.log_dir,
      },
      routing: { strategy: config.routing.strategy },
      concurrency: { global_resource_limit: config.concurrency.global_resource_limit },
      circuit_breaker: {
        enabled: config.circuit_breaker.enabled,
        failure_threshold: config.circuit_breaker.failure_threshold,
        recovery_seconds: config.circuit_breaker.recovery_seconds,
      },
      storage_security: {
        session_retention_days: config.storage_security.session_retention_days,
      },
    },
  };
}

// ---------- validation ----------

/**
 * Cross-field validation the zod schema can't express (name references + range).
 * Returns an error message, or null when the update is valid.
 */
function validateConfigUpdate(
  loader: ConfigLoader,
  opts: {
    generalOverride: Partial<CouncilConfig['general']>;
    prefer: string[];
    chairman: string;
    base: CouncilConfig;
  },
): string | null {
  const all = loader.loadAllModelConfigs();
  const allNames = new Set(all.map((m) => m.name));

  // Existence, not enabled-ness: aligning the write guard with runtime, which
  // tolerates a disabled/absent chairman by falling back to selectStrongestModel.
  // A disabled-but-known chairman is surfaced as a non-blocking warning instead
  // (chairmanWarning), so users can disable a model without a hard 400 here.
  if (opts.chairman !== '' && !allNames.has(opts.chairman)) {
    return `chairman "${opts.chairman}" is not a known model`;
  }
  const roleGen = opts.generalOverride.role_generator_model ?? opts.base.general.role_generator_model ?? '';
  if (roleGen !== '' && !allNames.has(roleGen)) {
    return `role_generator_model "${roleGen}" is not a known model`;
  }
  for (const p of opts.prefer) {
    if (!allNames.has(p)) return `prefer entry "${p}" is not a known model`;
  }
  const min = opts.generalOverride.min_agents ?? opts.base.general.min_agents;
  const max = opts.generalOverride.max_agents ?? opts.base.general.max_agents;
  if (max < min) return `max_agents (${max}) must be >= min_agents (${min})`;
  return null;
}

/**
 * Advisory (non-blocking) check: a known chairman that is currently disabled is
 * legal but won't actually chair — the orchestrator falls back to the strongest
 * enabled model. Returns a warning string, or undefined when nothing to flag.
 */
function chairmanWarning(loader: ConfigLoader, chairman: string): string | undefined {
  if (chairman === '') return undefined;
  const model = loader.loadAllModelConfigs().find((m) => m.name === chairman);
  if (model && !model.enabled) {
    return `chairman "${chairman}" is disabled — the council will fall back to the strongest enabled model at runtime`;
  }
  return undefined;
}

// ---------- helpers ----------

function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse a JSON body, returning undefined on malformed input. */
async function parseJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
