import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliExit, UsageError } from "./errors.js";

type Env = Record<string, string | undefined>;

/** How long to wait for another teamkit process to finish its update. */
const LOCK_WAIT_MS = 5_000;
/** A lock older than this is left over from a crashed process, whatever its pid says. */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 10;

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

function ensureDir(env: Env): void {
  const dir = dirname(claimsPath(env));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when the lock's owner has exited, or the lock is too old to be a live update. */
function lockIsStale(lock: string): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return false; // released meanwhile; just retry
  }
  if (age > LOCK_STALE_MS) return true;
  let pid: number;
  try {
    pid = Number(readFileSync(join(lock, "pid"), "utf8"));
  } catch {
    return false; // its owner has not written the pid yet
  }
  return Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
}

/**
 * Runs `fn` holding a lock directory next to claims.json, so two teamkit processes
 * saving claims at once cannot drop each other's entries in their read-modify-write.
 * mkdir is atomic; the lock records its pid, and a lock left by a dead process is broken.
 */
function withClaimsLock<T>(env: Env, fn: () => T): T {
  ensureDir(env);
  const lock = `${claimsPath(env)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (lockIsStale(lock)) {
      // Two processes breaking the same stale lock at the same moment could both get
      // in. A stale lock only follows a crash mid-update, so that window is accepted.
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new CliExit(1, `timed out waiting for ${lock}; remove it if no teamkit command is running`);
    }
    sleepSync(LOCK_POLL_MS);
  }
  try {
    writeFileSync(join(lock, "pid"), String(process.pid));
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function writeClaims(claims: Record<string, string>, env: Env): void {
  const path = claimsPath(env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(claims, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function saveClaim(taskId: string, claimId: string, env: Env = process.env): void {
  withClaimsLock(env, () => writeClaims({ ...loadClaims(env), [taskId]: claimId }, env));
}

export function forgetClaim(taskId: string, env: Env = process.env): void {
  withClaimsLock(env, () => {
    const claims = loadClaims(env);
    delete claims[taskId];
    writeClaims(claims, env);
  });
}

export function resolveClaimId(taskId: string, opts: { claim?: string }, env: Env = process.env): string {
  if (opts.claim) return opts.claim;
  if (env.TEAMKIT_CLAIM && env.TEAMKIT_TASK === taskId) return env.TEAMKIT_CLAIM;
  const stored = loadClaims(env)[taskId];
  if (stored) return stored;
  throw new UsageError(`no claim known for ${taskId}; pass --claim`);
}
