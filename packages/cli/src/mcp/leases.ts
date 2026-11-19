import { forgetClaim, loadClaims, saveClaim } from "../claims-store.js";
import type { Env } from "./session.js";

/** The claims this MCP process made, so tools never need a claim id and the keepalive can renew them. */
export interface Leases {
  hold(taskId: string, claimId: string): void;
  /** The claim id for a task: this process's, then TEAMKIT_TASK/TEAMKIT_CLAIM, then the CLI's claim store. */
  claimFor(taskId: string): string;
  drop(taskId: string): void;
  held(): { taskId: string; claimId: string }[];
}

function bestEffort(fn: () => unknown): void {
  try {
    fn();
  } catch {
    // The CLI's claim store is a convenience for `teamkit tasks ...` in a shell; the MCP process keeps its own.
  }
}

export function createLeases(env: Env): Leases {
  const mine = new Map<string, string>();
  return {
    hold(taskId, claimId) {
      mine.set(taskId, claimId);
      bestEffort(() => saveClaim(taskId, claimId, env));
    },
    claimFor(taskId) {
      const held = mine.get(taskId);
      if (held) return held;
      if (env.TEAMKIT_TASK === taskId && env.TEAMKIT_CLAIM) return env.TEAMKIT_CLAIM;
      let stored: string | undefined;
      bestEffort(() => {
        stored = loadClaims(env)[taskId];
      });
      if (stored) return stored;
      throw new Error(`no claim known for ${taskId}; claim it first with teamkit_claim`);
    },
    drop(taskId) {
      mine.delete(taskId);
      bestEffort(() => forgetClaim(taskId, env));
    },
    held: () => [...mine].map(([taskId, claimId]) => ({ taskId, claimId })),
  };
}
