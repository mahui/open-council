/**
 * Custom-endpoint model acquisition in the wizard (src/ui/wizard/first-run.ts →
 * resolveEndpointModelIds). Exercises the two supply paths added when custom
 * endpoints gained live model discovery:
 *   - "discover": query the endpoint's /models list and checkbox-select
 *   - "manual" : type a comma-separated id list (parseModelIds) — also the
 *                automatic fallback when discovery returns [].
 *
 * @inquirer/prompts and model-discovery are mocked so the interactive path can be
 * driven deterministically; the mock is scoped to this file to keep it away from
 * the pure-function tests in first-run.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSelect, mockCheckbox, mockInput, mockDiscoverEndpointModels } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockCheckbox: vi.fn(),
  mockInput: vi.fn(),
  mockDiscoverEndpointModels: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  select: mockSelect,
  checkbox: mockCheckbox,
  input: mockInput,
  confirm: vi.fn(),
  password: vi.fn(),
  Separator: class {
    separator: string;
    constructor(s = '') { this.separator = s; }
  },
}));

vi.mock('../../../src/providers/model-discovery.js', () => ({
  discoverModels: vi.fn(),
  discoverEndpointModels: mockDiscoverEndpointModels,
}));

import { resolveEndpointModelIds } from '../../../src/ui/wizard/first-run.js';
import type { DiscoveredModel } from '../../../src/providers/model-discovery.js';

function ollamaModel(id: string, baseUrl = 'http://localhost:11434/v1'): DiscoveredModel {
  return { id, name: id, protocol: 'openai', base_url: baseUrl, source: 'ollama' };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveEndpointModelIds', () => {
  it('discover path: calls discoverEndpointModels with the endpoint args and returns the checkbox selection', async () => {
    mockSelect.mockResolvedValueOnce('discover');
    mockDiscoverEndpointModels.mockResolvedValueOnce([ollamaModel('llama3.2'), ollamaModel('mistral')]);
    mockCheckbox.mockResolvedValueOnce(['llama3.2']);

    const ids = await resolveEndpointModelIds({
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'sk-test',
      sourceLabel: 'ollama',
    });

    // criterion 1: discovery is invoked with protocol/baseUrl/apiKey/sourceLabel
    expect(mockDiscoverEndpointModels).toHaveBeenCalledTimes(1);
    expect(mockDiscoverEndpointModels).toHaveBeenCalledWith({
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'sk-test',
      sourceLabel: 'ollama',
    });

    // the returned list is checkbox-selectable, NOT a hand-typed comma string
    expect(mockCheckbox).toHaveBeenCalledTimes(1);
    expect(mockInput).not.toHaveBeenCalled();
    expect(ids).toEqual(['llama3.2']);

    // the checkbox choices were built from the discovered ids
    const choices = mockCheckbox.mock.calls[0]![0].choices as { value: string }[];
    expect(choices.map(c => c.value)).toEqual(['llama3.2', 'mistral']);
  });

  it('discover path with no API key: omits apiKey from the discoverEndpointModels call', async () => {
    mockSelect.mockResolvedValueOnce('discover');
    mockDiscoverEndpointModels.mockResolvedValueOnce([ollamaModel('llama3.2')]);
    mockCheckbox.mockResolvedValueOnce(['llama3.2']);

    await resolveEndpointModelIds({
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '', // no-auth endpoint
      sourceLabel: 'ollama',
    });

    // apiKey key must be ABSENT (exact-match), so discoverEndpointModels applies its no-auth placeholder
    expect(mockDiscoverEndpointModels).toHaveBeenCalledWith({
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      sourceLabel: 'ollama',
    });
  });

  it('discovery returns []: degrades to the manual comma-separated prompt (parseModelIds), no empty checkbox', async () => {
    mockSelect.mockResolvedValueOnce('discover');
    mockDiscoverEndpointModels.mockResolvedValueOnce([]); // failed/empty discovery (never throws)
    mockInput.mockResolvedValueOnce('gpt-4o, llama3.2 , mistral');

    const ids = await resolveEndpointModelIds({
      protocol: 'openai',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'k',
      sourceLabel: 'gw',
    });

    expect(mockDiscoverEndpointModels).toHaveBeenCalledTimes(1);
    expect(mockCheckbox).not.toHaveBeenCalled(); // never shows an empty checkbox
    expect(mockInput).toHaveBeenCalledTimes(1);
    // parseModelIds splits, trims, drops empties
    expect(ids).toEqual(['gpt-4o', 'llama3.2', 'mistral']);
  });

  it('manual choice: never calls discovery and uses parseModelIds on the typed list', async () => {
    mockSelect.mockResolvedValueOnce('manual');
    mockInput.mockResolvedValueOnce('deepseek-chat,deepseek-reasoner');

    const ids = await resolveEndpointModelIds({
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      sourceLabel: 'deepseek',
    });

    expect(mockDiscoverEndpointModels).not.toHaveBeenCalled();
    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(ids).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('populated discovery + empty selection is treated as "skip" (returns [], no manual fallback)', async () => {
    mockSelect.mockResolvedValueOnce('discover');
    mockDiscoverEndpointModels.mockResolvedValueOnce([ollamaModel('llama3.2')]);
    mockCheckbox.mockResolvedValueOnce([]); // user unticks everything

    const ids = await resolveEndpointModelIds({
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      sourceLabel: 'ollama',
    });

    expect(ids).toEqual([]);
    expect(mockInput).not.toHaveBeenCalled(); // empty selection is intentional, not a fallback trigger
  });

  it('manual validate rejects empty and duplicate id lists', async () => {
    mockSelect.mockResolvedValueOnce('manual');
    mockInput.mockResolvedValueOnce('gpt-4o');

    await resolveEndpointModelIds({
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'k',
      sourceLabel: 'openai-manual',
    });

    const validate = mockInput.mock.calls[0]![0].validate as (v: string) => string | true;
    expect(validate('')).toContain('At least one');
    expect(validate('  ,  ')).toContain('At least one');
    expect(validate('a,a')).toContain('Duplicate');
    expect(validate('a,b')).toBe(true);
  });
});
