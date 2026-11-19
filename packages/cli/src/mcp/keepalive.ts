import { HEARTBEAT_EVERY_MS, RENEW_EVERY_MS } from "@copilotkit/teamkit-protocol";
import { TeamkitError, type TeamkitClient } from "@copilotkit/teamkit-client";
import type { Leases } from "./leases.js";
import { NotSignedInError, type Env, type Session } from "./session.js";

/** TEAMKIT_ROOMS (comma-separated) when set, else every room the agent can read. */
export async function watchedRooms(env: Env, client: TeamkitClient): Promise<string[]> {
  const set = env.TEAMKIT_ROOMS;
  if (set !== undefined && set.trim() !== "") {
    return [...new Set(set.split(",").map((r) => r.trim()).filter((r) => r !== ""))];
  }
  return (await client.rooms()).map((r) => r.name);
}

export interface Keepalive {
  beat(): Promise<void>;
  renewAll(): Promise<void>;
  stop(): void;
}

const describe = (e: unknown): string =>
  e instanceof TeamkitError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);

/**
 * Reports this process's presence every `heartbeatMs` and renews the claims it made every
 * `renewEveryMs`, with no model involvement. Nothing throws out of either loop; each failure is
 * logged once until the loop succeeds again, so a server outage does not flood stderr.
 */
export function startKeepalive(opts: {
  session: Session;
  leases: Leases;
  env: Env;
  log: (line: string) => void;
  heartbeatMs?: number;
  renewEveryMs?: number;
}): Keepalive {
  const { session, leases, env, log } = opts;
  let lastBeatError: string | null = null;
  const renewErrors = new Map<string, string>();
  let beating = false;
  let renewing = false;
  let stopped = false;

  async function beat(): Promise<void> {
    if (beating || stopped) return;
    beating = true;
    try {
      const client = session.client();
      await client.heartbeat({ watching: await watchedRooms(env, client) });
      lastBeatError = null;
    } catch (e) {
      const line =
        e instanceof NotSignedInError
          ? "teamkit mcp: not signed in; presence paused until this agent joins"
          : `teamkit mcp: heartbeat failed: ${describe(e)}`;
      if (line !== lastBeatError) log(line);
      lastBeatError = line;
    } finally {
      beating = false;
    }
  }

  async function renewAll(): Promise<void> {
    if (renewing || stopped) return;
    renewing = true;
    try {
      const held = leases.held();
      if (held.length === 0) return;
      let client: TeamkitClient;
      try {
        client = session.client();
      } catch {
        return; // not signed in: the heartbeat already says so
      }
      for (const { taskId, claimId } of held) {
        try {
          await client.renew(taskId, claimId);
          renewErrors.delete(taskId);
        } catch (e) {
          if (e instanceof TeamkitError && e.code === "claim_lost") {
            leases.drop(taskId);
            renewErrors.delete(taskId);
            log(`teamkit mcp: claim lost on ${taskId}`);
          } else {
            const line = `teamkit mcp: renew failed on ${taskId}: ${describe(e)}`;
            if (renewErrors.get(taskId) !== line) log(line);
            renewErrors.set(taskId, line);
          }
        }
      }
    } finally {
      renewing = false;
    }
  }

  void beat();
  const beatTimer = setInterval(() => void beat(), opts.heartbeatMs ?? HEARTBEAT_EVERY_MS);
  const renewTimer = setInterval(() => void renewAll(), opts.renewEveryMs ?? RENEW_EVERY_MS);
  beatTimer.unref();
  renewTimer.unref();
  return {
    beat,
    renewAll,
    stop() {
      stopped = true;
      clearInterval(beatTimer);
      clearInterval(renewTimer);
    },
  };
}
