import type { Command } from "commander";
import { CHANGE_STATUSES, type ChangeStatus } from "@copilotkit/teamkit-protocol";
import { clientFor, globalOpts, type CliContext } from "../context.js";
import { UsageError } from "../errors.js";

export function registerChanges(program: Command, ctx: CliContext): void {
  program
    .command("log <room>")
    .description("log a change you made, with how to undo it (names and short identifiers only)")
    .requiredOption("--what <t>", "what changed")
    .requiredOption("--where <t>", "where it changed")
    .requiredOption("--undo <t>", "how to undo it")
    .option("--undo-when <t>", "when to undo it (recorded only)")
    .option("--task <id>", "the task the change belongs to")
    .action(
      async (room: string, o: { what: string; where: string; undo: string; undoWhen?: string; task?: string }, cmd: Command) => {
        const c = await clientFor(cmd, ctx).logChange({
          room,
          what: o.what,
          where: o.where,
          undo: o.undo,
          ...(o.undoWhen === undefined ? {} : { undoWhen: o.undoWhen }),
          ...(o.task === undefined ? {} : { threadId: o.task }),
        });
        if (globalOpts(cmd).json) ctx.out(JSON.stringify(c));
        else ctx.out(`${c.id}\t${c.status}`);
      },
    );

  program
    .command("change <id> <status>")
    .description(`mark a logged change ${CHANGE_STATUSES.join(", ")}`)
    .action(async (id: string, status: string, _opts: unknown, cmd: Command) => {
      if (!(CHANGE_STATUSES as readonly string[]).includes(status)) {
        throw new UsageError(`status must be ${CHANGE_STATUSES.join(", ")}`);
      }
      const c = await clientFor(cmd, ctx).updateChange(id, status as ChangeStatus);
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(c));
      else ctx.out(`${c.id}\t${c.status}`);
    });
}
