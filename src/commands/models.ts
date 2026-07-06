/**
 * Barrel for the `council models …` subcommand handlers. cli.ts imports the run*
 * functions from here; the actual implementations live in ./models/*.ts, each
 * kept under the 150-line command budget (ARCH-03). Pure registry mutations sit
 * in ./models/mutations.ts (unit-tested against a temp-dir ConfigLoader).
 */

export { runModelsList } from './models/list.js';
export { runModelsCheck } from './models/check.js';
export { runModelsAdd } from './models/add.js';
export { runModelsRemove, runModelsEnable, runModelsDisable } from './models/manage.js';
