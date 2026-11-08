export const EXIT_CODES = Object.freeze({
  PASS: 0,
  BLOCK: 1,
  USAGE: 2,
});

export class ColdJuryError extends Error {
  constructor(message, { exitCode = EXIT_CODES.USAGE, code = 'usage' } = {}) {
    super(message);
    this.name = 'ColdJuryError';
    this.exitCode = exitCode;
    this.code = code;
  }
}

export class UsageError extends ColdJuryError {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code, { exitCode: EXIT_CODES.USAGE, code });
    this.name = 'UsageError';
  }
}

export class ConfigError extends ColdJuryError {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code, { exitCode: EXIT_CODES.USAGE, code });
    this.name = 'ConfigError';
  }
}
