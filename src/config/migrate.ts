/**
 * One-shot, non-destructive schema_version 1 → 2 migration (standard-API
 * convergence). Pure decision logic — NO file I/O lives here; the loader owns
 * the thin read/backup/write shell. See docs/design-notes/standard-api-convergence.md §4.
 *
 * Guarantees: never throws, never silently drops a model, never fabricates a
 * model that is guaranteed to fail. A legacy model that cannot be auto-converted
 * to a standard-API model is kept, but disabled with a human-readable
 * `legacy_disabled_reason` so it stays visible in `council models list`.
 */
import type { Protocol, ReasoningEffort } from '../types/config.js';

/** Official env var carrying the API key for each protocol. */
const DEFAULT_ENV: Record<Protocol, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Disabled-reason strings (Chinese, user-facing, actionable). */
export const MIGRATE_REASON = {
  cli: 'CLI 通道已移除，请改用标准 API（protocol: anthropic | openai + API key）',
  google:
    'Gemini / Vertex 订阅通道已移除，请改用其 OpenAI 兼容端点（protocol: openai, base_url: https://generativelanguage.googleapis.com/v1beta/openai）',
  copilot: 'GitHub Copilot 订阅通道已移除，请改用标准 API',
  noKey: '需要 API key（设置 ANTHROPIC_API_KEY / OPENAI_API_KEY 或重跑 council setup）',
  unknown: '无法自动迁移此模型，请重跑 council setup 重新配置为标准 API 模型',
} as const;

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

/**
 * A migrated model draft. Fields with a schema default are optional here — the
 * loader runs the result through `ModelConfigSchema.parse` to fill defaults and
 * produce the canonical, persisted form.
 */
export interface MigratedModel {
  name: string;
  protocol: Protocol;
  model: string;
  base_url?: string;
  api_key_env?: string;
  api_key_path?: string;
  provider?: string;
  reasoning_effort?: ReasoningEffort;
  temperature?: number;
  max_tokens?: number;
  timeout_seconds?: number;
  capabilities?: string[];
  priority?: number;
  max_concurrent?: number;
  resource_weight?: number;
  streaming?: boolean;
  enabled: boolean;
  legacy_disabled_reason?: string;
}

export type ModelMigrationStatus = 'ok' | 'converted' | 'disabled';

export interface ModelMigrationResult {
  /** `ok` = already v2, no rewrite; `converted`/`disabled` = rewrite `config`. */
  status: ModelMigrationStatus;
  config?: MigratedModel;
  reason?: string;
}

export interface CouncilMigrationResult {
  status: 'ok' | 'converted';
  config?: Record<string, unknown>;
}

// ── Safe typed readers over `unknown` (no `as any`, no throw) ───────────────

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}

function getReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as ReasoningEffort)
    : undefined;
}

// ── Provider family classification ──────────────────────────────────────────

/** google / google-vertex / google-antigravity / gemini / vertex → Google family. */
function isGoogleFamily(provider: string): boolean {
  return /google|gemini|vertex|antigravity/.test(provider);
}

function isCopilot(provider: string): boolean {
  return /copilot/.test(provider);
}

/**
 * Identify the wire protocol for a custom endpoint. An anthropic-compatible
 * endpoint is recognised heuristically by its URL; everything else defaults to
 * `openai` (the broadest-compatible protocol), per §4.
 */
function detectCustomProtocol(baseUrl: string): Protocol {
  return /anthropic/i.test(baseUrl) ? 'anthropic' : 'openai';
}

/** Best-effort protocol label for a disabled (non-convertible) legacy model. */
function guessProtocol(provider: string): Protocol {
  return provider === 'anthropic' ? 'anthropic' : 'openai';
}

/**
 * Whether a usable API key can be sourced for `protocol`: an explicit key file,
 * an explicit env-var name, or the official env var present in `env`. A merely
 * OAuth/subscription-backed legacy model has none of these.
 */
function hasApiKey(
  raw: Record<string, unknown>,
  env: Record<string, string | undefined>,
  protocol: Protocol,
): boolean {
  if (getString(raw.api_credential_path) || getString(raw.api_key_path)) return true;
  if (getString(raw.api_key_env)) return true;
  return Boolean(env[DEFAULT_ENV[protocol]]);
}

/** Fields carried verbatim from v1 to v2 (everything except protocol/enabled/reason). */
function carryOver(
  raw: Record<string, unknown>,
  name: string,
  model: string,
): Omit<MigratedModel, 'protocol' | 'enabled'> {
  return {
    name,
    model,
    reasoning_effort: getReasoningEffort(raw.reasoning_effort),
    temperature: getNumber(raw.temperature),
    max_tokens: getNumber(raw.max_tokens),
    timeout_seconds: getNumber(raw.timeout_seconds),
    capabilities: getStringArray(raw.capabilities),
    priority: getNumber(raw.priority),
    max_concurrent: getNumber(raw.max_concurrent),
    resource_weight: getNumber(raw.resource_weight),
    streaming: getBoolean(raw.streaming),
  };
}

function disable(
  base: Omit<MigratedModel, 'protocol' | 'enabled'>,
  protocol: Protocol,
  reason: string,
): ModelMigrationResult {
  return {
    status: 'disabled',
    reason,
    config: { ...base, protocol, enabled: false, legacy_disabled_reason: reason },
  };
}

/**
 * Classify and migrate a single raw model config (parsed YAML) to v2.
 *
 * Precedence (most specific / most actionable first):
 *   1. already v2 (`protocol` present)      → ok (no rewrite)
 *   2. Google family provider               → disabled (use OpenAI-compatible endpoint)
 *   3. Copilot provider                     → disabled (subscription channel removed)
 *   4. custom endpoint (`api_base_url`)      → converted (protocol from URL, keep key)
 *   5. `invocation: cli`                    → disabled (CLI channel removed)
 *   6. provider anthropic/openai + key      → converted (official endpoint)
 *   7. provider anthropic/openai, no key     → disabled (needs API key)
 *   8. anything else                        → disabled (unknown, re-run setup)
 */
export function migrateModelConfigRaw(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): ModelMigrationResult {
  const r = asRecord(raw);

  // 1. Already v2 — the presence of `protocol` is the version discriminator.
  if (typeof r.protocol === 'string') return { status: 'ok' };

  const name = getString(r.name) ?? '';
  const model = getString(r.model) ?? name;
  const provider = (getString(r.provider) ?? '').toLowerCase();
  const invocation = (getString(r.invocation) ?? '').toLowerCase();
  const apiBaseUrl = getString(r.api_base_url) ?? getString(r.base_url);
  const base = carryOver(r, name, model);

  // 2/3. OAuth/subscription-only families cannot be auto-converted.
  if (isGoogleFamily(provider)) return disable(base, 'openai', MIGRATE_REASON.google);
  if (isCopilot(provider)) return disable(base, 'openai', MIGRATE_REASON.copilot);

  // 4. Custom endpoint (self-hosted / gateway) — convertible regardless of key
  //    (localhost endpoints such as ollama need no credential).
  if (apiBaseUrl) {
    const protocol = detectCustomProtocol(apiBaseUrl);
    return {
      status: 'converted',
      config: {
        ...base,
        protocol,
        base_url: apiBaseUrl,
        api_key_env: getString(r.api_key_env),
        api_key_path: getString(r.api_credential_path) ?? getString(r.api_key_path),
        provider: getString(r.provider),
        enabled: true,
      },
    };
  }

  // 5. CLI channel is gone; no way to synthesise a working API key from it.
  if (invocation === 'cli') return disable(base, guessProtocol(provider), MIGRATE_REASON.cli);

  // 6/7. Official anthropic / openai endpoints.
  if (provider === 'anthropic' || provider === 'openai') {
    const protocol: Protocol = provider === 'anthropic' ? 'anthropic' : 'openai';
    if (hasApiKey(r, env, protocol)) {
      return {
        status: 'converted',
        config: {
          ...base,
          protocol,
          api_key_env: getString(r.api_key_env) ?? DEFAULT_ENV[protocol],
          api_key_path: getString(r.api_credential_path) ?? getString(r.api_key_path),
          provider: getString(r.provider),
          enabled: true,
        },
      };
    }
    return disable(base, protocol, MIGRATE_REASON.noKey);
  }

  // 8. Unrecognised legacy shape — keep it, but disabled and clearly flagged.
  return disable(base, guessProtocol(provider), MIGRATE_REASON.unknown);
}

/**
 * Migrate a raw council.yaml to schema_version 2. Unknown CLI-residual fields
 * are stripped by `CouncilConfigSchema.parse` downstream (zod strips unknown
 * keys), so this only needs to bump the version.
 */
export function migrateCouncilConfigRaw(raw: unknown): CouncilMigrationResult {
  const r = asRecord(raw);
  const version = getNumber(r.schema_version) ?? 1;
  if (version >= 2) return { status: 'ok' };
  return { status: 'converted', config: { ...r, schema_version: 2 } };
}
