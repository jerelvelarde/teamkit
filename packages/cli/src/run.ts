import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { createClient, TeamkitError, type TeamkitClient } from "@copilotkit/teamkit-client";
import { CLAIM_NEXT_MAX_WAIT_MS, RENEW_EVERY_MS, type Claim, type Task } from "@copilotkit/teamkit-protocol";
import { parseDuration, parseLabels } from "./args.js";
import { collect, configFor, type CliContext } from "./context.js";
import { CliExit, EXIT, UsageError } from "./errors.js";

export type RunTarget = { taskId: string } | { room: string; labels?: Record<string, string>; waitMs: number };

export interface RunTaskOptions {
  client: TeamkitClient;
  url: string;
  token: string;
  target: RunTarget;
  command: string[];
  renewEveryMs?: number;
  killGraceMs?: number;
  /** First wait before a settle call is retried; it doubles on each retry. */
  retryBackoffMs?: number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  handleSignals?: boolean;
}

/** `teamkit run` exits 4 when the agent command could not start; the task is released, not failed. */
export const EXIT_AGENT_NOT_STARTED = 4;
/** The task's result when the agent exited 0 without settling the task itself. */
export const FALLBACK_RESULT = "agent exited 0 without completing";

const KILL_GRACE_MS = 10_000;
const FORCED_RELEASE_MS = 1_000;
const SETTLE_RETRIES = 3;
const RETRY_BACKOFF_MS = 1_000;
/** Signals that stop the agent and release the task. SIGHUP: the terminal closed. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** `run`'s exit code after a stop signal: 129 when the terminal hung up, else 130. */
const exitFor = (signal: NodeJS.Signals | null): number => (signal === "SIGHUP" ? 129 : EXIT.interrupted);
/** What a shell exits with when the command was not executable (126) or not found (127). */
const NOT_STARTED_CODES: ReadonlySet<number> = new Set([126, 127]);

type Exit = { code: number | null; signal: NodeJS.Signals | null } | { error: Error };

const isClaimLost = (e: unknown): boolean => e instanceof TeamkitError && e.code === "claim_lost";
const messageOf = (e: unknown): string =>
  e instanceof TeamkitError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
/** Network errors, timeouts and 5xx answers may pass; a 4xx answer will not change on retry. */
const isRetryable = (e: unknown): boolean =>
  !(e instanceof TeamkitError) || e.code === "timeout" || e.status >= 500;

/** Sends `signal` to every process in the agent's process group; a gone group is fine. */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function acquire(client: TeamkitClient, target: RunTarget, signal: AbortSignal): Promise<Claim | null> {
  if ("taskId" in target) return client.claim(target.taskId);
  const deadline = Date.now() + target.waitMs;
  for (;;) {
    const left = Math.max(0, deadline - Date.now());
    const claim = await client.claimNext(target.room, {
      labels: target.labels,
      waitMs: Math.min(left, CLAIM_NEXT_MAX_WAIT_MS),
      signal,
    });
    if (claim || Date.now() >= deadline) return claim;
  }
}

/**
 * Claims a task, runs `command` on it with inherited stdio, renews the claim while the command runs,
 * and settles the task by the command's exit code. Returns the exit code for `teamkit run`.
 *
 * The command runs in its own process group (and session), so a terminal's Ctrl-C, hangup or
 * Ctrl-Z reaches only `run`. It forwards each stop signal to the whole group once (a second one
 * kills the group), and pauses and resumes the group with itself on Ctrl-Z and `fg`.
 */
export async function runTask(opts: RunTaskOptions): Promise<number> {
  const { client, target, command } = opts;
  const room = "room" in target ? target.room : null;
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const renewEveryMs = opts.renewEveryMs ?? RENEW_EVERY_MS;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;
  const retryBackoffMs = opts.retryBackoffMs ?? RETRY_BACKOFF_MS;

  const abortClaim = new AbortController();
  let interrupted: NodeJS.Signals | null = null;
  let signalCount = 0;
  let child: ChildProcess | null = null;
  let agentDone = false;
  let stopDeadline: number | null = null;
  let renewTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let release: (() => Promise<void>) | null = null;
  let forcing = false;
  let forceExit: (code: number) => void = () => {};
  const forced = new Promise<number>((resolve) => (forceExit = resolve));

  /** Retries a settle call, with backoff, after a network error, a timeout or a 5xx answer. */
  const settleCall = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    for (let retry = 0; ; retry++) {
      try {
        return await fn();
      } catch (e) {
        if (retry >= SETTLE_RETRIES || !isRetryable(e)) throw e;
        const wait = retryBackoffMs * 2 ** retry;
        log(`teamkit run: ${what} failed (${messageOf(e)}), retrying in ${wait} ms`);
        await sleep(wait);
      }
    }
  };

  const running = (): ChildProcess | null => {
    const c = child;
    return c && c.pid !== undefined && c.exitCode === null && c.signalCode === null ? c : null;
  };
  /** Sends the agent's group one stop signal, then SIGKILL after the grace period. */
  const stopAgent = (signal: NodeJS.Signals): void => {
    const c = running();
    if (!c || stopDeadline !== null) return;
    const pid = c.pid as number;
    stopDeadline = Date.now() + killGraceMs;
    signalGroup(pid, signal);
    // A paused (Ctrl-Z) agent only acts on the signal once it runs again.
    signalGroup(pid, "SIGCONT");
    killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), killGraceMs);
  };
  const forceQuit = async (signal: NodeJS.Signals): Promise<void> => {
    if (forcing) return;
    forcing = true;
    log(`teamkit run: second ${signal}, killing the agent`);
    abortClaim.abort();
    if (child?.pid !== undefined && !agentDone) signalGroup(child.pid, "SIGKILL");
    if (release) await Promise.race([release(), sleep(FORCED_RELEASE_MS)]);
    forceExit(exitFor(interrupted));
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (++signalCount > 1) {
      void forceQuit(signal);
      return;
    }
    log(`teamkit run: ${signal}, stopping`);
    interrupted = signal;
    abortClaim.abort();
    stopAgent(signal);
  };
  // Ctrl-Z: pause the agent's group, then this process the way the terminal would have; `fg` resumes both.
  const onPause = (): void => {
    if (child?.pid !== undefined && !agentDone) signalGroup(child.pid, "SIGSTOP");
    process.kill(process.pid, "SIGSTOP");
  };
  const onResume = (): void => {
    if (child?.pid !== undefined && !agentDone) signalGroup(child.pid, "SIGCONT");
  };
  // After a hangup the terminal is gone and writing to it fails; that must not stop the release.
  const ignoreWriteError = (): void => {};
  const handleSignals = opts.handleSignals !== false;
  if (handleSignals) {
    for (const s of SIGNALS) process.on(s, onSignal);
    process.on("SIGTSTP", onPause);
    process.on("SIGCONT", onResume);
    process.stderr.on("error", ignoreWriteError);
  }

  const work = async (): Promise<number> => {
    if (room !== null) log(`teamkit run: looking for a ready task in ${room}`);
    let claim: Claim | null;
    try {
      claim = await acquire(client, target, abortClaim.signal);
    } catch (e) {
      if (interrupted) return exitFor(interrupted);
      throw e;
    }
    if (!claim) {
      log(`teamkit run: nothing ready in ${room}`);
      return EXIT.none;
    }
    const taskId = claim.task.id;
    const claimId = claim.claimId;
    release = async (): Promise<void> => {
      try {
        await settleCall(`release of ${taskId}`, () => client.release(taskId, claimId));
        log(`teamkit run: released ${taskId}`);
      } catch (e) {
        if (!isClaimLost(e)) log(`teamkit run: release of ${taskId} failed: ${messageOf(e)}`);
      }
    };
    if (interrupted || forcing) {
      await release();
      return exitFor(interrupted);
    }

    log(`teamkit run: claimed ${taskId} (${claimId}), starting ${command.join(" ")}`);
    const c = spawn(command[0] as string, command.slice(1), {
      stdio: "inherit",
      // Its own process group: signals go to the agent and everything it started, exactly once.
      detached: true,
      env: {
        ...(opts.env ?? process.env),
        TEAMKIT_TASK: taskId,
        TEAMKIT_CLAIM: claimId,
        TEAMKIT_ROOM: claim.task.room,
        TEAMKIT_URL: opts.url,
        TEAMKIT_TOKEN: opts.token,
      },
    });
    child = c;
    const exited = new Promise<Exit>((resolve) => {
      c.once("exit", (code, signal) => resolve({ code, signal }));
      c.on("error", (error) => {
        // Without a pid the command never started and no exit event follows.
        if (c.pid === undefined) resolve({ error });
        else log(`teamkit run: agent error: ${error.message}`);
      });
    });

    let settling = false;
    let lost = false;
    let renewing: Promise<void> = Promise.resolve();
    // Renews start renewEveryMs apart; a slow or timed-out renew does not push the next one back.
    const scheduleRenew = (delay: number): void => {
      renewTimer = setTimeout(() => {
        const started = Date.now();
        const next = (): void => {
          if (!settling) scheduleRenew(Math.max(0, started + renewEveryMs - Date.now()));
        };
        renewing = client.renew(taskId, claimId).then(next, (e: unknown) => {
          if (isClaimLost(e)) {
            lost = true;
            log(`teamkit run: claim lost on ${taskId}, stopping the agent`);
            stopAgent("SIGTERM");
            return;
          }
          log(`teamkit run: renew failed: ${messageOf(e)}`);
          next();
        });
      }, delay);
    };
    scheduleRenew(renewEveryMs);

    const exit = await exited;
    settling = true;
    clearTimeout(renewTimer);
    // A stopped agent's leader can exit before the rest of its group: wait for all of it.
    if (stopDeadline !== null && c.pid !== undefined) {
      while (signalGroup(c.pid, 0)) {
        if (Date.now() >= stopDeadline) {
          signalGroup(c.pid, "SIGKILL");
          break;
        }
        await sleep(50);
      }
    }
    agentDone = true;
    clearTimeout(killTimer);
    await renewing;

    if ("error" in exit) {
      log(`teamkit run: could not start ${command[0]}: ${exit.error.message}`);
      await release();
      return EXIT_AGENT_NOT_STARTED;
    }
    if (interrupted) {
      await release();
      return exitFor(interrupted);
    }
    if (lost) return EXIT.error;

    const how = exit.signal ? `agent killed by ${exit.signal}` : `agent exited with code ${exit.code}`;
    const readState = async (): Promise<Task | null> =>
      (await settleCall(`reading ${taskId}`, () => client.thread(taskId))).task;
    const task = await readState();
    if (task?.state === "claimed" && task.claim?.id === claimId) {
      if (exit.code !== null && NOT_STARTED_CODES.has(exit.code)) {
        log(`teamkit run: ${how}: the agent command was not found or could not run; releasing ${taskId}`);
        await release();
        return EXIT_AGENT_NOT_STARTED;
      }
      try {
        if (exit.code === 0) {
          await settleCall(`completing ${taskId}`, () => client.complete(taskId, claimId, FALLBACK_RESULT));
          log(`teamkit run: ${how} without completing ${taskId}, completed it`);
          return EXIT.ok;
        }
        await settleCall(`failing ${taskId}`, () => client.fail(taskId, claimId, how));
        log(`teamkit run: ${how}, failed ${taskId}`);
        return EXIT.error;
      } catch (e) {
        if (!isClaimLost(e)) throw e;
        // A retried call whose first try went through also ends here: report what the task is now.
        const now = (await readState())?.state ?? "gone";
        log(`teamkit run: claim lost on ${taskId} before it could be settled; it is ${now}`);
        return exit.code === 0 && now === "completed" ? EXIT.ok : EXIT.error;
      }
    }
    const state = task?.state ?? "gone";
    log(`teamkit run: ${how}, ${taskId} is ${state}`);
    return state === "blocked" || state === "completed" ? EXIT.ok : EXIT.error;
  };

  try {
    const result = work();
    // After a forced exit the work may still settle or fail in the background; nobody waits for it.
    result.catch(() => {});
    return await Promise.race([result, forced]);
  } finally {
    clearTimeout(renewTimer);
    clearTimeout(killTimer);
    if (handleSignals) {
      for (const s of SIGNALS) process.off(s, onSignal);
      process.off("SIGTSTP", onPause);
      process.off("SIGCONT", onResume);
      process.stderr.off("error", ignoreWriteError);
    }
  }
}

export function registerRun(program: Command, ctx: CliContext): void {
  program
    .command("run")
    .description(
      "claim a task, run an agent command on it, and complete or fail the task by its exit code " +
        `(exits ${EXIT_AGENT_NOT_STARTED} and releases the task when the command could not start)`,
    )
    .argument("[args...]", "<id> -- <command...>, or with --ready just -- <command...>")
    .option("--ready <room>", "claim the next ready task in this room")
    .option("--label <k=v>", "only tasks with this label (repeatable)", collect)
    .option("--wait <d>", "how long to wait for a ready task, e.g. 30s (default 0)")
    .action(async (args: string[], o: { ready?: string; label?: string[]; wait?: string }, cmd: Command) => {
      let target: RunTarget;
      let command: string[];
      if (o.ready !== undefined) {
        target = { room: o.ready, labels: parseLabels(o.label), waitMs: parseDuration(o.wait ?? "0") };
        command = args;
      } else {
        if (o.label !== undefined || o.wait !== undefined) throw new UsageError("--label and --wait need --ready");
        const [taskId, ...rest] = args;
        if (taskId === undefined) throw new UsageError("run needs a task id or --ready <room>");
        target = { taskId };
        command = rest;
      }
      if (command.length === 0) throw new UsageError("run needs an agent command after --");
      const config = configFor(cmd, ctx);
      const code = await runTask({
        client: createClient(config),
        url: config.url,
        token: config.token,
        target,
        command,
        env: ctx.env,
        log: ctx.err,
      });
      if (code !== EXIT.ok) throw new CliExit(code);
    });
}
