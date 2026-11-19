import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { UsageError } from "./errors.js";

type Env = Record<string, string | undefined>;

export function claimsPath(env: Env = process.env): string {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "teamkit", "claims.json");
}

export function loadClaims(env: Env = process.env): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(claimsPath(env), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const claims: Record<string, string> = {};
    for (const [taskId, claimId] of Object.entries(parsed)) {
      if (typeof claimId === "string") claims[taskId] = claimId;
    }
    return claims;
  } catch {
    return {};
  }
}

function writeClaims(claims: Record<string, string>, env: Env): void {
  const path = claimsPath(env);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(claims, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function saveClaim(taskId: string, claimId: string, env: Env = process.env): void {
  writeClaims({ ...loadClaims(env), [taskId]: claimId }, env);
}

export function forgetClaim(taskId: string, env: Env = process.env): void {
  const claims = loadClaims(env);
  delete claims[taskId];
  writeClaims(claims, env);
}

export function resolveClaimId(taskId: string, opts: { claim?: string }, env: Env = process.env): string {
  if (opts.claim) return opts.claim;
  if (env.TEAMKIT_CLAIM && env.TEAMKIT_TASK === taskId) return env.TEAMKIT_CLAIM;
  const stored = loadClaims(env)[taskId];
  if (stored) return stored;
  throw new UsageError(`no claim known for ${taskId}; pass --claim`);
}
