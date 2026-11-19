import type { Command } from "commander";
import { BLOCK_KINDS, type BlockKind, type Claim, type Task } from "@copilotkit/teamkit-protocol";
import { parseDuration, parseLabels } from "../args.js";
import { forgetClaim, resolveClaimId, saveClaim } from "../claims-store.js";
import { clientFor, collect, globalOpts, type CliContext } from "../context.js";
import { CliExit, UsageError } from "../errors.js";
import { firstLine } from "../format.js";

const MAX_SLICE_MS = 25_000;

/** Runs a claims-file update after the server call succeeded; a failure only warns, on stderr. */
export function bestEffort(ctx: CliContext, what: string, fn: () => unknown): void {
  try {
    if (fn() !== false) return;
  } catch {
    // fall through to the warning
  }
  ctx.err(`warning: could not ${what} in the claims file; pass --claim on later commands`);
}

export function registerTaskClaims(tasks: Command, ctx: CliContext): void {
  tasks
    .command("claim [id]")
    .description("claim a task by id, or the next ready task in a room")
    .option("--ready <room>", "claim the next ready task in this room")
    .option("--label <k=v>", "only tasks with this label (repeatable)", collect)
    .option("--wait <d>", "how long to wait for a ready task, e.g. 30s", "0")
    .action(async (id: string | undefined, o: { ready?: string; label?: string[]; wait: string }, cmd: Command) => {
      if (!id && !o.ready) throw new UsageError("claim needs a task id or --ready <room>");
      const client = clientFor(cmd, ctx);
      let claim: Claim | null;
      if (id) {
        claim = await client.claim(id);
      } else {
        const room = o.ready as string;
        const labels = parseLabels(o.label);
        const deadline = Date.now() + parseDuration(o.wait);
        claim = null;
        for (;;) {
          const left = Math.max(0, deadline - Date.now());
          claim = await client.claimNext(room, {
            labels,
            waitMs: Math.min(left, MAX_SLICE_MS),
          });
          if (claim || Date.now() >= deadline) break;
        }
        if (!claim) throw new CliExit(3, `nothing ready in ${room}`);
      }
      ctx.out(
        globalOpts(cmd).json
          ? JSON.stringify(claim)
          : `${claim.task.id}\t${claim.claimId}\t${firstLine(claim.task.brief)}`,
      );
      const { task, claimId } = claim;
      bestEffort(ctx, "save the claim", () => saveClaim(task.id, claimId, ctx.env));
    });

  tasks
    .command("renew <id>")
    .description("extend the lease on a claimed task")
    .option("--claim <c>", "claim id (default: the stored claim)")
    .action(async (id: string, o: { claim?: string }, cmd: Command) => {
      const claimId = resolveClaimId(id, o, ctx.env);
      const r = await clientFor(cmd, ctx).renew(id, claimId);
      ctx.out(globalOpts(cmd).json ? JSON.stringify(r) : `${id}\t${r.leaseExpiresAt}`);
    });

  const finish = (task: Task, cmd: Command): void => {
    ctx.out(globalOpts(cmd).json ? JSON.stringify(task) : `${task.id}\t${task.state}`);
  };

  tasks
    .command("release <id>")
    .description("give a claimed task back")
    .option("--claim <c>", "claim id (default: the stored claim)")
    .action(async (id: string, o: { claim?: string }, cmd: Command) => {
      const task = await clientFor(cmd, ctx).release(id, resolveClaimId(id, o, ctx.env));
      finish(task, cmd);
      bestEffort(ctx, "forget the claim", () => forgetClaim(id, ctx.env));
    });

  tasks
    .command("complete <id> [result]")
    .description("mark a claimed task completed")
    .option("--claim <c>", "claim id (default: the stored claim)")
    .action(async (id: string, result: string | undefined, o: { claim?: string }, cmd: Command) => {
      const task = await clientFor(cmd, ctx).complete(id, resolveClaimId(id, o, ctx.env), result);
      finish(task, cmd);
      bestEffort(ctx, "forget the claim", () => forgetClaim(id, ctx.env));
    });

  tasks
    .command("fail <id> <reason>")
    .description("mark a claimed task failed")
    .option("--claim <c>", "claim id (default: the stored claim)")
    .action(async (id: string, reason: string, o: { claim?: string }, cmd: Command) => {
      const task = await clientFor(cmd, ctx).fail(id, resolveClaimId(id, o, ctx.env), reason);
      finish(task, cmd);
      bestEffort(ctx, "forget the claim", () => forgetClaim(id, ctx.env));
    });

  tasks
    .command("block <id> <question>")
    .description("block a claimed task on a question")
    .option("--kind <k>", `block kind: ${BLOCK_KINDS.join(" or ")}`, "needs_input")
    .option("--options <a,b,c>", "comma-separated answer choices")
    .option("--approvers <a,b>", "comma-separated people who must answer")
    .option("--claim <c>", "claim id (default: the stored claim)")
    .action(
      async (
        id: string,
        question: string,
        o: { kind: string; options?: string; approvers?: string; claim?: string },
        cmd: Command,
      ) => {
        if (!(BLOCK_KINDS as readonly string[]).includes(o.kind)) {
          throw new UsageError(`--kind must be ${BLOCK_KINDS.join(" or ")}`);
        }
        const options = o.options
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const approvers = o.approvers
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const task = await clientFor(cmd, ctx).block(id, resolveClaimId(id, o, ctx.env), {
          question,
          kind: o.kind as BlockKind,
          ...(options && options.length > 0 ? { options } : {}),
          ...(approvers && approvers.length > 0 ? { approvers } : {}),
        });
        finish(task, cmd);
        bestEffort(ctx, "forget the claim", () => forgetClaim(id, ctx.env));
      },
    );

  tasks
    .command("answer <id> [text]")
    .alias("unblock")
    .description("answer a blocked task")
    .option("--choice <c>", "pick one of the offered options")
    .action(async (id: string, text: string | undefined, o: { choice?: string }, cmd: Command) => {
      if (text === undefined && o.choice === undefined) throw new UsageError("answer needs text or --choice");
      const task = await clientFor(cmd, ctx).answer(id, {
        ...(text !== undefined ? { text } : {}),
        ...(o.choice !== undefined ? { choice: o.choice } : {}),
      });
      finish(task, cmd);
    });
}
