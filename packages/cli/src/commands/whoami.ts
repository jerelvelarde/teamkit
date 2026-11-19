import type { Command } from "commander";
import { clientFor, globalOpts, type CliContext } from "../context.js";

export function registerWhoami(program: Command, ctx: CliContext): void {
  program
    .command("whoami")
    .description("show the identity behind the current token")
    .action(async (_opts: unknown, cmd: Command) => {
      const who = await clientFor(cmd, ctx).whoami();
      if (globalOpts(cmd).json) {
        ctx.out(JSON.stringify(who));
        return;
      }
      ctx.out(`${who.actor.name} (${who.actor.kind})`);
      ctx.out(`scope: ${who.scope ?? "none"}${who.role ? `, role: ${who.role}` : ""}`);
    });

  program
    .command("rooms")
    .description("list rooms")
    .action(async (_opts: unknown, cmd: Command) => {
      const rooms = await clientFor(cmd, ctx).rooms();
      if (globalOpts(cmd).json) {
        ctx.out(JSON.stringify(rooms));
        return;
      }
      for (const r of rooms) ctx.out(r.name);
    });
}
