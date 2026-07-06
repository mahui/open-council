import { homedir } from 'node:os';
import { join } from 'node:path';

export const COUNCIL_HOME = join(homedir(), '.council');

export const PATHS = {
  config:       join(COUNCIL_HOME, 'config'),
  councilYaml:  join(COUNCIL_HOME, 'config', 'council.yaml'),
  modelsDir:    join(COUNCIL_HOME, 'config', 'models'),
  rolesDir:     join(COUNCIL_HOME, 'config', 'roles'),
  dataDir:      join(COUNCIL_HOME, 'data'),
  database:     join(COUNCIL_HOME, 'data', 'council.db'),
  sessionsDir:  join(COUNCIL_HOME, 'data', 'sessions'),
  checkpoints:  join(COUNCIL_HOME, 'checkpoints'),
  credentials:  join(COUNCIL_HOME, 'credentials'),
  logs:         join(COUNCIL_HOME, 'logs'),
} as const;
