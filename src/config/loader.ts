import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelConfigSchema, CouncilConfigSchema } from './schema.js';
import type { CouncilConfig, ModelConfig, RoleSet } from '../types/config.js';
import { ConfigNotFoundError, RoleSetNotFoundError } from '../types/errors.js';
import { PATHS } from './paths.js';
import { safePath } from '../shared/paths.js';
import { resolveDefaultsDir } from '../shared/resources.js';
import { migrateModelConfigRaw, migrateCouncilConfigRaw } from './migrate.js';

export class ConfigLoader {
  constructor(private configDir: string = PATHS.config) {}

  loadCouncilConfig(): CouncilConfig {
    const path = join(this.configDir, 'council.yaml');
    if (!existsSync(path)) throw new ConfigNotFoundError(path);

    const raw = parseYaml(readFileSync(path, 'utf-8')) as unknown;
    return this.migrateCouncilIfNeeded(path, raw);
  }

  /**
   * Run the schema_version 1→2 council migration. When conversion happens, the
   * original file is backed up to `council.yaml.v1.bak` (once) and the canonical
   * v2 form is written back. Already-v2 files parse with zero rewrite.
   */
  private migrateCouncilIfNeeded(path: string, raw: unknown): CouncilConfig {
    const result = migrateCouncilConfigRaw(raw);
    const source = result.status === 'ok' || !result.config ? raw : result.config;
    const config = CouncilConfigSchema.parse(source) as unknown as CouncilConfig;
    if (result.status === 'converted') this.persistMigrated(path, config);
    return config;
  }

  /**
   * Back up the pre-migration file to `<path>.v1.bak` (only if no backup exists
   * yet) then overwrite with the canonical migrated form. Best-effort: migration
   * is idempotent, so a failed write is simply retried on the next load.
   */
  private persistMigrated(path: string, value: unknown): void {
    try {
      const backup = `${path}.v1.bak`;
      if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
      writeFileSync(path, stringifyYaml(value), { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  /**
   * Load council.yaml as a merge base: returns the parsed config, or `null` when
   * the file is absent or unparseable. A corrupt/invalid file is renamed to
   * `council.yaml.bak` so the user's (broken) content is preserved rather than
   * silently overwritten — the caller can then rebuild from schema defaults.
   */
  loadCouncilConfigSafe(): CouncilConfig | null {
    const path = join(this.configDir, 'council.yaml');
    if (!existsSync(path)) return null;
    try {
      const raw = parseYaml(readFileSync(path, 'utf-8')) as unknown;
      return this.migrateCouncilIfNeeded(path, raw);
    } catch {
      try { renameSync(path, `${path}.bak`); } catch { /* best-effort */ }
      return null;
    }
  }

  saveCouncilConfig(config: CouncilConfig): void {
    // Validate against the schema before writing so a malformed config can never
    // be persisted to disk (a broken council.yaml would break every later run).
    const validated = CouncilConfigSchema.parse(config);
    const path = join(this.configDir, 'council.yaml');
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(path, stringifyYaml(validated), { mode: 0o600 });
  }

  loadAllModels(): ModelConfig[] {
    return this.loadAllModelConfigs().filter(m => m.enabled);
  }

  /**
   * Like {@link loadAllModels} but WITHOUT the `enabled` filter — returns every
   * model file (enabled and disabled). The Web GUI config面 needs to enumerate
   * disabled models to render their toggles; orchestration keeps using
   * {@link loadAllModels}.
   */
  loadAllModelConfigs(): ModelConfig[] {
    const modelsDir = join(this.configDir, 'models');
    if (!existsSync(modelsDir)) return [];

    return readdirSync(modelsDir)
      .filter(f => f.endsWith('.yaml'))
      .map(f => this.loadAndMigrateModel(join(modelsDir, f)));
  }

  /**
   * Read one model YAML, migrating it to schema_version 2 on the fly. A v1 model
   * is classified (converted or disabled+annotated — never dropped), its original
   * form backed up to `<file>.v1.bak`, and the canonical v2 form written back.
   * Already-v2 files parse with zero rewrite. See {@link migrateModelConfigRaw}.
   */
  private loadAndMigrateModel(path: string): ModelConfig {
    const raw = parseYaml(readFileSync(path, 'utf-8')) as unknown;
    const result = migrateModelConfigRaw(raw);
    const source = result.status === 'ok' || !result.config ? raw : result.config;
    const config = ModelConfigSchema.parse(source) as unknown as ModelConfig;
    if (result.status !== 'ok') this.persistMigrated(path, config);
    return config;
  }

  /**
   * Load a single model config by name (incl. disabled), or null when absent.
   * `safePath` blocks path traversal via a crafted `:name` route param.
   */
  loadModelConfig(name: string): ModelConfig | null {
    const modelsDir = join(this.configDir, 'models');
    const path = safePath(modelsDir, `${name}.yaml`);
    if (!existsSync(path)) return null;
    return this.loadAndMigrateModel(path);
  }

  /** Raw council.yaml bytes (utf-8) for version hashing, or null when absent. */
  readCouncilConfigRaw(): string | null {
    const path = join(this.configDir, 'council.yaml');
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  /** Raw model YAML bytes (utf-8) for version hashing (safePath), or null when absent. */
  readModelConfigRaw(name: string): string | null {
    const path = safePath(join(this.configDir, 'models'), `${name}.yaml`);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  saveModelConfig(config: ModelConfig): void {
    const modelsDir = join(this.configDir, 'models');
    mkdirSync(modelsDir, { recursive: true });
    const path = safePath(modelsDir, `${config.name}.yaml`);
    writeFileSync(path, stringifyYaml(config), { mode: 0o600 });
  }

  /** Whether any model YAML files exist in the models directory (ignores the enabled flag). */
  hasModelConfigs(): boolean {
    const modelsDir = join(this.configDir, 'models');
    if (!existsSync(modelsDir)) return false;
    return readdirSync(modelsDir).some(f => f.endsWith('.yaml'));
  }

  /**
   * Delete every model YAML in the models directory.
   * Only call this when the user has EXPLICITLY chosen to replace the entire
   * model set — a plain reconfigure/merge must preserve existing model files
   * (upsert via {@link saveModelConfig} instead) to avoid clobbering models the
   * user has hand-tuned.
   */
  clearAllModels(): void {
    const modelsDir = join(this.configDir, 'models');
    if (!existsSync(modelsDir)) return;
    for (const f of readdirSync(modelsDir)) {
      if (f.endsWith('.yaml')) {
        try { unlinkSync(join(modelsDir, f)); } catch { /* best-effort */ }
      }
    }
  }

  loadRoleSet(name: string): RoleSet {
    const rolesDir = join(this.configDir, 'roles');
    const builtinDir = join(resolveDefaultsDir(), 'roles');

    // Check user-defined roles first (safePath prevents path traversal)
    const userPath = safePath(rolesDir, `${name}.yaml`);
    if (existsSync(userPath)) {
      return parseYaml(readFileSync(userPath, 'utf-8')) as RoleSet;
    }

    // Fall back to built-in defaults
    const builtinPath = safePath(builtinDir, `${name}.yaml`);
    if (existsSync(builtinPath)) {
      return parseYaml(readFileSync(builtinPath, 'utf-8')) as RoleSet;
    }

    throw new RoleSetNotFoundError(name);
  }

  /**
   * List all available role-set names (built-in defaults + user-defined),
   * deduped and sorted. Used to build a helpful "available sets" hint when an
   * explicit `--role-set` name cannot be resolved.
   */
  listRoleSets(): string[] {
    const names = new Set<string>();
    const dirs = [
      join(resolveDefaultsDir(), 'roles'),
      join(this.configDir, 'roles'),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.yaml')) names.add(f.slice(0, -'.yaml'.length));
      }
    }
    return [...names].sort();
  }

  isConfigured(): boolean {
    return existsSync(join(this.configDir, 'council.yaml'));
  }
}
