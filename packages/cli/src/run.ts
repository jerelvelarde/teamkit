import { spawn, type ChildProcess } from "node:child_process";
import type { Command } from "commander";
import { createClient, TeamkitError, type TeamkitClient } from "@copilotkit/teamkit-client";
import { CLAIM_NEXT_MAX_WAIT_MS, RENEW_EVERY_MS, type Claim } from "@copilotkit/teamkit-protocol";
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
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  handleSignals?: boolean;
}

const KILL_GRACE_MS = 10_000;
const SIGNALS = ["SIGINT", "SIGTERM"] as const;

type Exit = { code: number | null; signal: NodeJS.Signals | null } | { error: Error };

const isClaimLost = (e: unknown): boolean => e instanceof TeamkitError && e.code === "claim_lost";
const messageOf = (e: unknown): string =>
  e instanceof TeamkitError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);

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
 */
export async function runTask(opts: RunTaskOptions): Promise<number> {
  const { client, target, command } = opts;
  const room = "room" in target ? target.room : null;
  const log = opts.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const renewEveryMs = opts.renewEveryMs ?? RENEW_EVERY_MS;
  const killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS;

  const abortClaim = new AbortController();
  let interrupted: NodeJS.Signals | null = null;
  let child: ChildProcess | null = null;
  let renewTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const stopChild = (signal: NodeJS.Signals): void => {
    const c = child;
    if (!c || c.pid === undefined || c.exitCode !== null || c.signalCode !== null) return;
    c.kill(signal);
    killTimer ??= setTimeout(() => c.kill("SIGKILL"), killGraceMs);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    log(`teamkit run: ${signal}, stopping`);
    interrupted ??= signal;
    abortClaim.abort();
    stopChild(signal);
  };
  const handleSignals = opts.handleSignals !== false;
  if (handleSignals) for (const s of SIGNALS) process.on(s, onSignal);

  try {
    if (room !== null) log(`teamkit run: looking for a ready task in ${room}`);
    let claim: Claim | null;
    try {
      claim = await acquire(client, target, abortClaim.signal);
    } catch (e) {
      if (interrupted) return EXIT.interrupted;
      throw e;
    }
    if (!claim) {
      log(`teamkit run: nothing ready in ${room}`);
      return EXIT.none;
    }
    const taskId = claim.task.id;
    const claimId = claim.claimId;
    const release = async (): Promise<void> => {
      try {
        await client.release(taskId, claimId);
        log(`teamkit run: released ${taskId}`);
      } catch (e) {
        if (!isClaimLost(e)) log(`teamkit run: release of ${taskId} failed: ${messageOf(e)}`);
      }
    };
    if (interrupted) {
      await release();
      return EXIT.interrupted;
    }

    log(`teamkit run: claimed ${taskId} (${claimId}), starting ${command.join(" ")}`);
    const c = spawn(command[0] as string, command.slice(1), {
      stdio: "inherit",
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
    const scheduleRenew = (): void => {
      renewTimer = setTimeout(() => {
        renewing = client.renew(taskId, claimId).then(
          () => {
            if (!settling) scheduleRenew();
          },
          (e: unknown) => {
            if (isClaimLost(e)) {
              lost = true;
              log(`teamkit run: claim lost on ${taskId}, stopping the agent`);
              stopChild("SIGTERM");
              return;
            }
            log(`teamkit run: renew failed: ${messageOf(e)}`);
            if (!settling) scheduleRenew();
          },
        );
      }, renewEveryMs);
    };
    scheduleRenew();

    const exit = await exited;
    settling = true;
    clearTimeout(renewTimer);
    clearTimeout(killTimer);
    await renewing;

    if ("error" in exit) {
      log(`teamkit run: could not start ${command[0]}: ${exit.error.message}`);
      await release();
      return EXIT.error;
    }
    if (interrupted) {
      await release();
      return EXIT.interrupted;
    }
    if (lost) return EXIT.error;

    const how = exit.signal ? `agent killed by ${exit.signal}` : `agent exited with code ${exit.code}`;
    const task = (await client.thread(taskId)).task;
    if (task?.state === "claimed" && task.claim?.id === claimId) {
      try {
        if (exit.code === 0) {
          await client.complete(taskId, claimId, "agent exited 0");
          log(`teamkit run: ${how}, completed ${taskId}`);
          return EXIT.ok;
        }
        await client.fail(taskId, claimId, how);
        log(`teamkit run: ${how}, failed ${taskId}`);
        return EXIT.error;
      } catch (e) {
        if (!isClaimLost(e)) throw e;
        log(`teamkit run: claim lost on ${taskId} before it could be settled`);
        return EXIT.error;
      }
    }
    const state = task?.state ?? "gone";
    log(`teamkit run: ${how}, ${taskId} is ${state}`);
    return state === "blocked" || state === "completed" ? EXIT.ok : EXIT.error;
  } finally {
    clearTimeout(renewTimer);
    clearTimeout(killTimer);
    if (handleSignals) for (const s of SIGNALS) process.off(s, onSignal);
  }
}

export function registerRun(program: Command, ctx: CliContext): void {
  program
    .command("run")
    .description("claim a task, run an agent command on it, and complete or fail the task by its exit code")
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
