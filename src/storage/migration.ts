/**
 * Schema versioning and migration utilities.
 * Currently a placeholder for future migrations beyond v1.
 */

import type Database from 'better-sqlite3';

export function getSchemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export function setSchemaVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`);
}
