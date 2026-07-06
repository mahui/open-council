import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { ConfigLoader } from '../../src/config/loader.js';
import {
  addModelConfig,
  removeModelConfig,
  setModelEnabled,
} from '../../src/commands/models/mutations.js';
import { buildCustomModelConfig } from '../../src/providers/model-assembly.js';
import type { ModelConfig } from '../../src/types/config.js';

let testDir: string;
let loader: ConfigLoader;

beforeEach(() => {
  testDir = join(tmpdir(), `council-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, 'models'), { recursive: true });
  loader = new ConfigLoader(testDir);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** A discovered-style official model (bare id name), enabled by default. */
function officialConfig(name = 'gpt-4o'): ModelConfig {
  return {
    name,
    protocol: 'openai',
    model: name,
    api_key_env: 'OPENAI_API_KEY',
    timeout_seconds: 120,
    capabilities: ['general'],
    priority: 90,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
  };
}

function modelFile(name: string): string {
  return join(testDir, 'models', `${name}.yaml`);
}

describe('models: addModelConfig', () => {
  it('writes the model YAML with the expected name / protocol / enabled:true', () => {
    const cfg = officialConfig('gpt-4o');
    const result = addModelConfig(loader, cfg);

    expect(result).toEqual({ status: 'added' });
    expect(existsSync(modelFile('gpt-4o'))).toBe(true);

    const onDisk = parseYaml(readFileSync(modelFile('gpt-4o'), 'utf-8')) as ModelConfig;
    expect(onDisk.name).toBe('gpt-4o');
    expect(onDisk.protocol).toBe('openai');
    expect(onDisk.enabled).toBe(true);

    // Round-trips through the loader (incl. migration) unchanged.
    const reloaded = loader.loadModelConfig('gpt-4o');
    expect(reloaded?.protocol).toBe('openai');
    expect(reloaded?.enabled).toBe(true);
  });

  it('persists a custom-endpoint model built by buildCustomModelConfig', () => {
    const cfg = buildCustomModelConfig({
      sanitizedName: 'acme',
      modelId: 'llama3.2',
      baseUrl: 'http://localhost:11434/v1',
      protocol: 'openai',
    });
    expect(addModelConfig(loader, cfg)).toEqual({ status: 'added' });

    const reloaded = loader.loadModelConfig('custom:acme:llama3.2');
    expect(reloaded?.protocol).toBe('openai');
    expect(reloaded?.base_url).toBe('http://localhost:11434/v1');
    expect(reloaded?.enabled).toBe(true);
  });

  it('refuses to overwrite an existing model of the same name (duplicate add)', () => {
    addModelConfig(loader, officialConfig('gpt-4o'));

    // A second add with the same name but a different flag must NOT clobber.
    const dup = { ...officialConfig('gpt-4o'), enabled: false, priority: 1 };
    const result = addModelConfig(loader, dup);

    expect(result).toEqual({ status: 'exists' });
    const stillThere = loader.loadModelConfig('gpt-4o');
    expect(stillThere?.enabled).toBe(true); // original preserved
    expect(stillThere?.priority).toBe(90);
  });
});

describe('models: removeModelConfig', () => {
  it('deletes the model YAML and reports removed', () => {
    addModelConfig(loader, officialConfig('gpt-4o'));
    expect(existsSync(modelFile('gpt-4o'))).toBe(true);

    const result = removeModelConfig(loader, 'gpt-4o');

    expect(result).toEqual({ status: 'removed' });
    expect(existsSync(modelFile('gpt-4o'))).toBe(false);
    expect(loader.loadModelConfig('gpt-4o')).toBeNull();
  });

  it('reports missing when removing a name that does not exist', () => {
    expect(removeModelConfig(loader, 'ghost')).toEqual({ status: 'missing' });
  });

  it('ConfigLoader.deleteModelConfig returns true/false by existence', () => {
    addModelConfig(loader, officialConfig('gpt-4o'));
    expect(loader.deleteModelConfig('gpt-4o')).toBe(true);
    expect(loader.deleteModelConfig('gpt-4o')).toBe(false);
  });

  // Regression pin: a `:name` crafted with path-traversal segments must never
  // resolve outside the models directory. Current behaviour is `safePath`
  // throwing a plain Error synchronously (not a typed/friendly error) — this
  // test only pins that defense down, not the error's shape/friendliness.
  // Friendlier error handling for this path is tracked separately (backlog #13).
  it('deleteModelConfig rejects a path-traversal name instead of deleting/reading outside the models dir', () => {
    expect(() => loader.deleteModelConfig('../../evil')).toThrow(/Path traversal/i);
  });
});

describe('models: setModelEnabled', () => {
  it('flips enabled:true → false and writes the new value to YAML', () => {
    addModelConfig(loader, officialConfig('gpt-4o'));

    const result = setModelEnabled(loader, 'gpt-4o', false);

    expect(result).toEqual({ status: 'updated', enabled: false });
    const onDisk = parseYaml(readFileSync(modelFile('gpt-4o'), 'utf-8')) as ModelConfig;
    expect(onDisk.enabled).toBe(false);
  });

  it('flips a disabled model back to enabled:true', () => {
    addModelConfig(loader, { ...officialConfig('gpt-4o'), enabled: false });

    expect(setModelEnabled(loader, 'gpt-4o', true)).toEqual({ status: 'updated', enabled: true });
    expect(loader.loadModelConfig('gpt-4o')?.enabled).toBe(true);
  });

  it('is a no-op (no error) when already in the requested state', () => {
    addModelConfig(loader, officialConfig('gpt-4o'));
    expect(setModelEnabled(loader, 'gpt-4o', true)).toEqual({ status: 'noop', enabled: true });
  });

  it('reports missing for an unknown model name', () => {
    expect(setModelEnabled(loader, 'ghost', false)).toEqual({ status: 'missing' });
  });

  it('a disabled model stays visible to list (loadAllModelConfigs) but hidden from orchestration (loadAllModels)', () => {
    addModelConfig(loader, officialConfig('gpt-4o'));
    setModelEnabled(loader, 'gpt-4o', false);

    expect(loader.loadAllModelConfigs().map(m => m.name)).toContain('gpt-4o');
    expect(loader.loadAllModels().map(m => m.name)).not.toContain('gpt-4o');
  });
});
