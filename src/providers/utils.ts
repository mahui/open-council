/**
 * @deprecated Compatibility shim. safePath/hasBinary moved to src/shared/
 * (IA review P0-2: shared pure utilities must not live in a business module).
 * Kept only so not-yet-migrated callers keep compiling; import from
 * '../shared/paths.js' / '../shared/env.js' in new code.
 */
export { safePath } from '../shared/paths.js';
export { hasBinary } from '../shared/env.js';
