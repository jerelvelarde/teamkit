import type { Command } from "commander";
import { clientFor, globalOpts, type CliContext } from "../context.js";

export function registerAlerts(program: Command, ctx: CliContext): void {
  // The parent declares no options of its own; see the note in commands/tasks.ts.
  const alert = program.command("alert").description("raise an alert in a room, or confirm or resolve one for a person");
  alert
    .command("raise <room> <text>", { isDefault: true })
    .description("raise a suspected alert in a room")
    .action(async (room: string, text: string, _opts: unknown, cmd: Command) => {
      const a = await clientFor(cmd, ctx).raiseAlert({ room, text });
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(a));
      else ctx.out(`${a.id}\t${a.level}`);
    });
  alert
    .command("confirm <id>")
    .description("confirm an alert; an agent names its owner with --source")
    .option("--source <person>", "the person who confirmed it (an agent's owner)")
    .action(async (id: string, o: { source?: string }, cmd: Command) => {
      const a = await clientFor(cmd, ctx).confirmAlert(id, o.source === undefined ? {} : { source: o.source });
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(a));
      else ctx.out(`${a.id}\t${a.level}`);
    });
  alert
    .command("resolve <id>")
    .description("resolve an alert, confirmed or a false alarm; an agent names its owner with --source")
    .option("--source <person>", "the person it is resolved for (an agent's owner)")
    .action(async (id: string, o: { source?: string }, cmd: Command) => {
      const a = await clientFor(cmd, ctx).resolveAlert(id, o.source === undefined ? {} : { source: o.source });
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(a));
      else ctx.out(`${a.id}\tresolved`);
    });
}
