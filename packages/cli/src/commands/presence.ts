import type { Command } from "commander";
import { clientFor, globalOpts, type CliContext } from "../context.js";
import { formatPresence } from "../format.js";

export function registerPresence(program: Command, ctx: CliContext): void {
  program
    .command("presence <room>")
    .description("list the agents watching a room: on or off, their sessions and status")
    .action(async (room: string, _opts: unknown, cmd: Command) => {
      const list = await clientFor(cmd, ctx).presence(room);
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(list));
      else ctx.out(formatPresence(list, Date.now()));
    });
}
