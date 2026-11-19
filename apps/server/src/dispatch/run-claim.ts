import { isBoardError, type Claim } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { block } from "../store/blocks.js";
import { clearPendingResume, complete, fail, leaseMs, release, renew } from "../store/claims.js";
import { getThread } from "../store/threads.js";
import { agentAuthContext, type RegisteredAgent } from "./registry.js";
import { MAX_TOOL_CALLS, clip, runAgentLoop, type LoopOutcome } from "./run-loop.js";

export type DispatchResult = "completed" | "blocked" | "released" | "failed" | "lost" | "aborted";

export interface RunClaimOptions {
  db: Db;
  /** Aborting it stops the run and releases the claim without counting an attempt. */
  signal?: AbortSignal;
  /** Default min(60000, leaseMs() / 3), read at call time. */
  renewEveryMs?: number;
  /** Failed runs (agent or transport errors) before the task fails. Default 3. */
  maxAttempts?: number;
  /** A run that sends no event for this long ends as a transport error. Default TEAMKIT_AGENT_IDLE_MS, else 120000. */
  idleMs?: number;
  /** The longest one claim may run, board tool rounds included. Default TEAMKIT_AGENT_MAX_RUN_MS, else 1800000. */
  maxRunMs?: number;
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

/**
 * Whether the claim's latest agent run is still open in the log: its RUN_STARTED is logged
 * and no RUN_FINISHED or RUN_ERROR follows it. Only then may settling close it with a
 * RUN_ERROR. A round that never started (an unreachable agent, an abort before the first
 * frame) or one the agent already ended (a failure or abort between rounds) gets none.
 */
async function runIsOpen(db: Db, taskId: string, claimId: string): Promise<boolean> {
  const [row] = await db<{ type: string }[]>`
    select agui->0->>'type' as type
    from events
    where thread_id = ${taskId} and kind = 'run.event' and data->>'claimId' = ${claimId}
      and agui->0->>'type' in ('RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR')
    order by cursor desc
    limit 1`;
  return row?.type === "RUN_STARTED";
}

/** Settles the task from the loop's ending. Store errors other than claim_lost propagate. */
async function settle(
  o: RunClaimOptions,
  agent: RegisteredAgent,
  claim: Claim,
  outcome: Exclude<LoopOutcome, { type: "claim_lost" }>,
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
      // The agent's own RUN_ERROR or RUN_FINISHED ends most agent_error runs. A transport error,
      // or a run TeamKit stopped for being too large, ended no run itself: settling closes the
      // one it left open, if any.
      const closesRun = await runIsOpen(db, task.id, claimId);
      if (task.attempts + 1 >= maxAttempts) {
        return failWith(`agent run failed ${maxAttempts} times: ${outcome.message}`, closesRun);
      }
      await release(db, auth, task.id, claimId, { countAttempt: true, closesRun });
      return "released";
    }
    case "too_many_rounds":
      return failWith("too many board tool rounds", false);
    case "too_many_tool_calls":
      return failWith(
        `the agent asked for ${outcome.count} board tool calls in one run; the limit is ${MAX_TOOL_CALLS}`,
        false,
      );
    case "unknown_tool":
      return failWith(`agent called a tool the board does not provide: ${outcome.names.join(", ")}`, false);
    case "aborted":
      await release(db, auth, task.id, claimId, { closesRun: await runIsOpen(db, task.id, claimId) });
      return "aborted";
  }
}

/**
 * Runs a registered agent on a task it has claimed (claimed with `opensRun: false`) and
 * settles the task from how the run ended. The claim is renewed while the run streams;
 * if it is lost (a renew finds it gone, or a write of the run does), the run is stopped and
 * nothing is settled. A run that goes quiet for idleMs or passes maxRunMs ends as a
 * transport error, which counts an attempt. A resume stored by an answer goes to the agent
 * and is cleared once the agent has received it. Throws only when the store does; the claim
 * then lapses and the reaper returns the task.
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
      idleMs: o.idleMs,
      maxRunMs: o.maxRunMs,
      fetch: o.fetch,
      log,
    });
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    await renewing.stop();
  }
  if (lost || outcome.type === "claim_lost") return done("lost", " (claim lost while running)");

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
