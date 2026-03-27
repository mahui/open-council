import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelConfigSchema, CouncilConfigSchema } from './schema.js';
import type { CouncilConfig, ModelConfig, RoleSet } from '../types/config.js';
import { ConfigNotFoundError, RoleSetNotFoundError } from '../types/errors.js';
import { PATHS } from './paths.js';
import { safePath } from '../providers/utils.js';

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

  loadRoleSet(name: string): RoleSet {
    const rolesDir = join(this.configDir, 'roles');
    const builtinDir = join(import.meta.dirname, '..', '..', 'defaults', 'roles');

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

  isConfigured(): boolean {
    return existsSync(join(this.configDir, 'council.yaml'));
  }
}
