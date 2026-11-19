import { CliExit, UsageError } from "./errors.js";

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;

/** Parses "500ms", "30s", "5m", "1h" into milliseconds; a bare number means seconds. */
export function parseDuration(s: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!match) throw new UsageError(`invalid duration: ${s}`);
  const unit = (match[2] ?? "s") as keyof typeof UNIT_MS;
  return Number(match[1]) * UNIT_MS[unit];
}

/** Splits "key=value" at the first "=". */
export function parseKeyValue(s: string): [string, string] {
  const i = s.indexOf("=");
  if (i <= 0) throw new UsageError(`expected key=value, got: ${s}`);
  return [s.slice(0, i), s.slice(i + 1)];
}

export function parseLabels(pairs?: string[]): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  return Object.fromEntries(pairs.map(parseKeyValue));
}

export function exitCodeFor(err: unknown): { code: number; message: string } {
  if (err instanceof CliExit) return { code: err.code, message: err.message ?? "" };
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; status?: unknown };
    if (typeof e.code === "string" && typeof e.status === "number") {
      return { code: 1, message: `error: ${e.code}: ${e.message}` };
    }
    return { code: 1, message: `error: ${e.message}` };
  }
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown; status?: unknown; message?: unknown };
    if (typeof e.code === "string" && typeof e.status === "number") {
      return { code: 1, message: `error: ${e.code}: ${String(e.message)}` };
    }
  }
  return { code: 1, message: `error: ${String(err)}` };
}
