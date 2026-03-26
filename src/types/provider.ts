/**
 * Provider, Credential, InvocationResult type definitions.
 * Pure types — no runtime code (ARCH-04).
 */

import type { ModelConfig } from './config.js';

export interface InvocationResult {
  response: string;
  elapsed_ms: number;
  invocation_mode: 'cli' | 'api';
  exit_code?: number;
  http_status?: number;
  stderr?: string;
  token_usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  timed_out: boolean;
}

export interface HealthStatus {
  level: 'healthy' | 'unhealthy' | 'degraded' | 'unavailable';
  message: string;
  checked_at: string;
}

export type OnChunk = (chunk: string) => void;

export interface InvocationAdapter {
  invoke(config: ModelConfig, prompt: string, onChunk?: OnChunk): Promise<InvocationResult>;
  healthCheck(config: ModelConfig): Promise<HealthStatus>;
}

export interface ProviderCredential {
  access_token: string;
  refresh_token?: string;
  account_id?: string;
  expires_at?: number;
  project_id?: string;
  source: 'env' | 'file';
}

export type CredentialStatus = 'valid' | 'refreshed' | 'expired' | 'not_found' | 'parse_error';

export interface DiscoveryResult {
  source: 'env' | 'file';
  status: CredentialStatus;
  path?: string;
  env_var?: string;
}

export type DiscoveryReport = Record<string, DiscoveryResult>;
