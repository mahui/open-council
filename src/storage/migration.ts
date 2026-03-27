/**
 * Schema versioning and migration utilities.
 * Currently a placeholder for future migrations beyond v1.
 */

import type Database from 'better-sqlite3';

export function getSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export function setSchemaVersion(db: Database.Database, version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`Invalid schema version: ${version}`);
  }
  // better-sqlite3 pragma() doesn't support parameterized values for user_version,
  // so we validate the input above to prevent SQL injection.
  db.pragma(`user_version = ${version}`);
}
