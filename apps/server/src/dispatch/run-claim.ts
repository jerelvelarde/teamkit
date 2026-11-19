import { isBoardError, type Claim } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { block } from "../store/blocks.js";
import { clearPendingResume, complete, fail, leaseMs, release, renew } from "../store/claims.js";
import { getThread } from "../store/threads.js";
import { agentAuthContext, type RegisteredAgent } from "./registry.js";
import { clip, runAgentLoop, type LoopOutcome } from "./run-loop.js";

export type DispatchResult = "completed" | "blocked" | "released" | "failed" | "lost" | "aborted";

export interface RunClaimOptions {
  db: Db;
  /** Aborting it stops the run and releases the claim without counting an attempt. */
  signal?: AbortSignal;
  /** Default min(60000, leaseMs() / 3), read at call time. */
  renewEveryMs?: number;
  /** Failed runs (agent or transport errors) before the task fails. Default 3. */
  maxAttempts?: number;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

const MAX_ATTEMPTS = 3;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const isClaimLost = (e: unknown) => isBoardError(e) && e.code === "claim_lost";

/**
 * Keeps the claim alive while the run streams. Renews never overlap: the next one is
 * scheduled when the last one settles. claim_lost calls `onLost` and stops renewing.
 */
function startRenewing(
  o: RunClaimOptions,
  agent: RegisteredAgent,
  claim: Claim,
  log: (line: string) => void,
  onLost: () => void,
): { stop(): Promise<void> } {
  const every = o.renewEveryMs ?? Math.min(60_000, leaseMs() / 3);
  const auth = agentAuthContext(agent);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const schedule = () => {
    timer = setTimeout(() => {
      inFlight = renew(o.db, auth, claim.task.id, claim.claimId).then(
        () => {
          if (!stopped) schedule();
        },
        (e) => {
          if (isClaimLost(e)) return onLost();
          // A failed renew is retried on schedule; the lease may still outlast the outage.
          log(`${agent.name} ${claim.task.id}: renew failed: ${errorMessage(e)}`);
          if (!stopped) schedule();
        },
      );
    }, every);
  };
  schedule();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}

/** Settles the task from the loop's ending. Store errors other than claim_lost propagate. */
async function settle(
  o: RunClaimOptions,
  agent: RegisteredAgent,
  claim: Claim,
  outcome: LoopOutcome,
): Promise<DispatchResult> {
  const { db } = o;
  const auth = agentAuthContext(agent);
  const { task, claimId } = claim;
  const maxAttempts = o.maxAttempts ?? MAX_ATTEMPTS;
  const failWith = async (reason: string, closesRun: boolean): Promise<DispatchResult> => {
    await fail(db, auth, task.id, claimId, clip(reason), { closesRun });
    return "failed";
  };
  switch (outcome.type) {
    case "success":
      await complete(db, auth, task.id, claimId, outcome.result, { closesRun: false });
      return "completed";
    case "interrupt": {
      const { id, reason, message, options } = outcome.interrupt;
      const kind = reason === "awaiting_approval" || reason === "approval" ? "awaiting_approval" : "needs_input";
      const question = clip(message || `${agent.name} is waiting (${reason})`);
      try {
        await block(db, auth, task.id, claimId, { question, kind, options: options ?? undefined, interruptId: id }, {
          closesRun: false,
        });
      } catch (e) {
        // The agent's interrupt itself is malformed (options or id the board refuses):
        // running it again would only repeat it.
        if (!isBoardError(e) || e.code !== "invalid_input") throw e;
        return failWith(`the agent's interrupt could not be stored: ${e.message}`, false);
      }
      return "blocked";
    }
    case "agent_error":
    case "transport_error": {
      // A transport error never reached the agent's own RUN_FINISHED or RUN_ERROR, so settling closes the run.
      const closesRun = outcome.type === "transport_error";
      if (task.attempts + 1 >= maxAttempts) {
        return failWith(`agent run failed ${maxAttempts} times: ${outcome.message}`, closesRun);
      }
      await release(db, auth, task.id, claimId, { countAttempt: true, closesRun });
      return "released";
    }
    case "too_many_rounds":
      return failWith("too many board tool rounds", false);
    case "unknown_tool":
      return failWith(`agent called a tool the board does not provide: ${outcome.names.join(", ")}`, false);
    case "aborted":
      await release(db, auth, task.id, claimId, { closesRun: true });
      return "aborted";
  }
}

/**
 * Runs a registered agent on a task it has claimed (claimed with `opensRun: false`) and
 * settles the task from how the run ended. The claim is renewed while the run streams;
 * if it is lost, the run is stopped and nothing is settled. A resume stored by an answer
 * goes to the agent and is cleared once the agent has received it. Throws only when the
 * store does; the claim then lapses and the reaper returns the task.
 */
export async function runClaim(o: RunClaimOptions, agent: RegisteredAgent, claim: Claim): Promise<DispatchResult> {
  const { db } = o;
  const log = o.log ?? ((line: string) => console.log(line));
  const auth = agentAuthContext(agent);
  const { task, claimId } = claim;
  const done = (result: DispatchResult, detail = ""): DispatchResult => {
    log(`${agent.name} ${task.id}: ${result}${detail}`);
    return result;
  };
  const messages = (await getThread(db, auth, task.id)).messages;

  const run = new AbortController();
  let lost = false;
  const onAbort = () => run.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) run.abort();
  const renewing = startRenewing(o, agent, claim, log, () => {
    lost = true;
    run.abort();
  });

  let outcome: LoopOutcome;
  try {
    outcome = await runAgentLoop({
      db,
      agent,
      auth,
      threadId: task.id,
      room: task.room,
      messages,
      context: [
        {
          description: "TeamKit task",
          value: JSON.stringify({ taskId: task.id, room: task.room, labels: task.labels, brief: task.brief }),
        },
      ],
      resume: task.pendingResume ?? undefined,
      claimId,
      taskId: task.id,
      signal: run.signal,
      fetch: o.fetch,
    });
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    await renewing.stop();
  }
  if (lost) return done("lost", " (claim lost while running)");

  try {
    if (outcome.delivered && task.pendingResume) await clearPendingResume(db, auth, task.id, claimId);
    const result = await settle(o, agent, claim, outcome);
    const why = "message" in outcome ? `: ${outcome.message.slice(0, 200)}` : "";
    return done(result, ` (${outcome.type}${why})`);
  } catch (e) {
    if (isClaimLost(e)) return done("lost", " (claim lost before settling)");
    throw e;
  }
}
