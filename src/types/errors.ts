/**
 * Error type hierarchy.
 * Exception to ARCH-04: errors need runtime class definitions.
 */

export class CouncilError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ModelUnavailableError extends CouncilError {
  constructor(modelName: string, reason: string) {
    super(`Model ${modelName} unavailable: ${reason}`, 'MODEL_UNAVAILABLE');
  }
}

export class InvocationError extends CouncilError {
  constructor(modelName: string, mode: 'cli' | 'api', reason: string) {
    super(`${mode.toUpperCase()} invocation of ${modelName} failed: ${reason}`, 'INVOCATION_FAILED');
  }
}

/**
 * Raised when an invocation exceeds its configured timeout (a hung/never-settling call).
 * Distinct from InvocationError so callers can recognise a timeout specifically; the message
 * contains the word "timeout" for substring-based detection. Orchestrator catch branches treat
 * any thrown error as a per-agent failure (timed_out=true), so this participates in graceful
 * degradation rather than hanging the whole debate.
 */
export class InvocationTimeoutError extends CouncilError {
  constructor(
    public readonly modelName: string,
    public readonly mode: 'cli' | 'api',
    public readonly timeoutSeconds: number,
  ) {
    super(
      `${mode.toUpperCase()} invocation of ${modelName} timed out after ${timeoutSeconds}s (timeout)`,
      'INVOCATION_TIMEOUT',
    );
  }
}

export class CredentialNotFoundError extends CouncilError {
  constructor(provider: string) {
    super(`No credentials found for ${provider}`, 'CREDENTIAL_NOT_FOUND');
  }
}

export class CredentialExpiredError extends CouncilError {
  constructor(provider: string) {
    super(`Credentials for ${provider} expired and refresh failed`, 'CREDENTIAL_EXPIRED');
  }
}

export class ConfigNotFoundError extends CouncilError {
  constructor(path: string) {
    super(`Configuration file not found: ${path}`, 'CONFIG_NOT_FOUND');
  }
}

export class RoleSetNotFoundError extends CouncilError {
  constructor(name: string) {
    super(`Role set not found: ${name}`, 'ROLE_SET_NOT_FOUND');
  }
}
