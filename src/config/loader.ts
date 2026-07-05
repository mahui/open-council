import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ModelConfigSchema, CouncilConfigSchema } from './schema.js';
import type { CouncilConfig, ModelConfig, RoleSet } from '../types/config.js';
import { ConfigNotFoundError, RoleSetNotFoundError } from '../types/errors.js';
import { PATHS } from './paths.js';
import { safePath } from '../shared/paths.js';
import { resolveDefaultsDir } from '../shared/resources.js';

export class ConfigLoader {
  constructor(private configDir: string = PATHS.config) {}

  loadCouncilConfig(): CouncilConfig {
    const path = join(this.configDir, 'council.yaml');
    if (!existsSync(path)) throw new ConfigNotFoundError(path);

    const raw = parseYaml(readFileSync(path, 'utf-8')) as unknown;
    return CouncilConfigSchema.parse(raw) as unknown as CouncilConfig;
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
      return CouncilConfigSchema.parse(raw) as unknown as CouncilConfig;
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
    const modelsDir = join(this.configDir, 'models');
    if (!existsSync(modelsDir)) return [];

    return readdirSync(modelsDir)
      .filter(f => f.endsWith('.yaml'))
      .map(f => {
        const raw = parseYaml(readFileSync(join(modelsDir, f), 'utf-8')) as unknown;
        return ModelConfigSchema.parse(raw) as unknown as ModelConfig;
      })
      .filter(m => m.enabled);
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
