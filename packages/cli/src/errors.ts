export const EXIT = { ok: 0, error: 1, usage: 2, none: 3, interrupted: 130 } as const;

export class CliExit extends Error {
  constructor(readonly code: number, message?: string) {
    super(message);
    this.name = "CliExit";
  }
}

export class UsageError extends CliExit {
  constructor(message: string) {
    super(2, message);
  }
}
