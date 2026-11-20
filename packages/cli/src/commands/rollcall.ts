import type { Command } from "commander";
import { clientFor, globalOpts, type CliContext } from "../context.js";

export function registerRollCall(program: Command, ctx: CliContext): void {
  // The parent declares no options of its own; see the note in commands/tasks.ts.
  const rollcall = program.command("rollcall").description("ask who is on in a room, or answer a roll call");
  rollcall
    .command("start <room>", { isDefault: true })
    .description("start a roll call in a room")
    .action(async (room: string, _opts: unknown, cmd: Command) => {
      const r = await clientFor(cmd, ctx).startRollCall(room);
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(r));
      else ctx.out(`${r.id}\t${r.threadId}`);
    });
  rollcall
    .command("answer <id> <status>")
    .description("answer a roll call with a short status, e.g. \"on: watching billing-prod\"")
    .action(async (id: string, status: string, _opts: unknown, cmd: Command) => {
      const r = await clientFor(cmd, ctx).answerRollCall(id, status);
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(r));
      else ctx.out(`${r.id}\tanswered`);
    });
}
