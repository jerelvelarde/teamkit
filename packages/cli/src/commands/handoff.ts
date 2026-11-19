import type { Command } from "commander";
import { forgetClaim } from "../claims-store.js";
import { clientFor, globalOpts, type CliContext } from "../context.js";
import { bestEffort } from "./task-claims.js";

export function registerHandoff(program: Command, ctx: CliContext): void {
  program
    .command("handoff <task> <agent>")
    .description("hand a task to a named agent and hold it for them")
    .action(async (id: string, to: string, _opts: unknown, cmd: Command) => {
      const task = await clientFor(cmd, ctx).handoff(id, to);
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(task));
      else ctx.out(`${task.id}\theld for ${to} until ${task.reservedUntil}`);
      bestEffort(ctx, "forget the claim", () => forgetClaim(id, ctx.env));
    });
}
