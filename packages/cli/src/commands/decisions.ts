import type { Command } from "commander";
import { clientFor, globalOpts, type CliContext } from "../context.js";

export function registerDecisions(program: Command, ctx: CliContext): void {
  program
    .command("decide <room> <text>")
    .description("post a decision a person made; an agent names its owner with --for")
    .option("--for <person>", "the person who made the decision (an agent's owner)")
    .action(async (room: string, text: string, o: { for?: string }, cmd: Command) => {
      const d = await clientFor(cmd, ctx).postDecision({ room, text, ...(o.for === undefined ? {} : { decidedBy: o.for }) });
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(d));
      else ctx.out(`${d.id}\t${d.threadId}`);
    });

  program
    .command("ack <decision>")
    .description("acknowledge that you read a decision")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const d = await clientFor(cmd, ctx).ackDecision(id);
      if (globalOpts(cmd).json) ctx.out(JSON.stringify(d));
      else ctx.out(`${d.id}\tacked`);
    });
}
