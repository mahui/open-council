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
