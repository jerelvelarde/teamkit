import type { Command } from "commander";
import { clientFor, globalOpts, type CliContext } from "../context.js";
import { formatEvent, formatRoom, formatThread } from "../format.js";

export function registerRead(program: Command, ctx: CliContext): void {
  program
    .command("read")
    .description("read a room or a thread (th_ prefix)")
    .argument("<target>", "room name or thread id")
    .option("--after <cursor>", "only show what happened after this cursor")
    .action(async (target: string, opts: { after?: string }, cmd: Command) => {
      const client = clientFor(cmd, ctx);
      const { json } = globalOpts(cmd);
      if (target.startsWith("th_")) {
        if (opts.after === undefined) {
          const view = await client.thread(target);
          ctx.out(json ? JSON.stringify(view) : formatThread(view));
          return;
        }
        const result = await client.events({ thread: target, after: opts.after });
        if (json) ctx.out(JSON.stringify({ events: result.events, cursor: result.cursor }));
        else for (const e of result.events) ctx.out(formatEvent(e));
        return;
      }
      const view = await client.room(target, { after: opts.after });
      ctx.out(json ? JSON.stringify(view) : formatRoom(view));
    });
}
