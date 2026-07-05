import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
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

  saveCouncilConfig(config: CouncilConfig): void {
    const path = join(this.configDir, 'council.yaml');
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(path, stringifyYaml(config), { mode: 0o600 });
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

  /** Delete every model YAML in the models directory. Used by reconfigure to avoid stale entries. */
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
