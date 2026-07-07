/**
 * `validateModelIds` / `parseModelIds` (src/commands/models/id-input.ts) — the
 * `validate` closure behind `council models add`'s "Model identifier(s)" prompt,
 * extracted so it's unit-testable directly (the empty/duplicate/parse semantics
 * are also exercised via the full runModelsAdd harness in models-add.test.ts).
 *
 * Focus here: the #15 path-traversal guard. Each id maps to the on-disk name
 * `custom:<sanitized>:<id>`; only the id can inject a separator, so ids are
 * validated directly against the models dir. Traversal detection is
 * path-agnostic, so the real PATHS.modelsDir gives deterministic results.
 */
import { describe, it, expect } from 'vitest';
import { parseModelIds, validateModelIds } from '../../src/commands/models/id-input.js';

describe('parseModelIds', () => {
  it('splits on comma, trims, and drops empty segments', () => {
    expect(parseModelIds('gpt-4o, llama3.2 , ,mistral,')).toEqual(['gpt-4o', 'llama3.2', 'mistral']);
    expect(parseModelIds('  gpt-4o  ')).toEqual(['gpt-4o']);
    expect(parseModelIds('  , , ')).toEqual([]);
  });
});

describe('validateModelIds', () => {
  it('accepts clean, unique, non-empty model ids', () => {
    expect(validateModelIds('gpt-4o')).toBe(true);
    expect(validateModelIds('llama3.2,mistral')).toBe(true);
    expect(validateModelIds('claude-3-5-sonnet-20241022, o3')).toBe(true);
  });

  it('rejects an empty / whitespace-only list', () => {
    expect(validateModelIds('')).toContain('At least one');
    expect(validateModelIds('  ,  ')).toContain('At least one');
  });

  it('rejects duplicate ids', () => {
    expect(validateModelIds('a,a')).toContain('Duplicate');
  });

  it('rejects path-traversal ids — deep and shallow ../ (shallow would mangle the on-disk name)', () => {
    expect(validateModelIds('../../../evil')).toContain("Invalid model id '../../../evil'");
    expect(validateModelIds('../../evil')).toContain('Invalid model id');
    expect(validateModelIds('../evil')).toContain('Invalid model id');
  });

  it('rejects an absolute path masquerading as a model id', () => {
    expect(validateModelIds('/etc/passwd')).toContain('Invalid model id');
  });

  it('rejects the whole batch when any single id is a traversal id', () => {
    expect(validateModelIds('gpt-4o,../../../evil')).toContain('Invalid model id');
  });
});
