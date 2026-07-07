/**
 * Model-id input parsing + validation for `council models add`'s custom-endpoint
 * flow. Kept out of add.ts so the interactive `validate` closure is a plain,
 * unit-testable function (and add.ts stays within the 150-line command budget).
 */
import { PATHS } from '../../config/paths.js';
import { isResolvableModelName } from '../../shared/paths.js';

/** Parse a comma-separated model id list, trimming and dropping empties. */
export function parseModelIds(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Validate the comma-separated model-id input: at least one id, no duplicates,
 * and each id a safe flat-file name.
 *
 * The on-disk name is `custom:<sanitized>:<id>`, but only the id can introduce a
 * path separator — the endpoint name is already `[a-z0-9-]` via
 * sanitizeProviderName — so we validate each id DIRECTLY against the models dir.
 * Validating the final name would miss shallow traversal: `custom:lab:../../evil`
 * collapses to `evil.yaml` (a silent name mangle) yet still resolves inside the
 * dir. Checking the id alone rejects `../` escapes (deep AND shallow) and
 * absolute paths before they reach safePath / disk.
 */
export function validateModelIds(raw: string): true | string {
  const ids = parseModelIds(raw);
  if (ids.length === 0) return 'At least one model id is required.';
  if (new Set(ids).size !== ids.length) return 'Duplicate model ids in input.';
  const bad = ids.find(id => !isResolvableModelName(PATHS.modelsDir, id));
  if (bad !== undefined) return `Invalid model id '${bad}'.`;
  return true;
}
