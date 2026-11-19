import type { Command } from "commander";
import { parseKeyValue } from "../args.js";
import { clientFor, globalOpts, type CliContext } from "../context.js";

export function registerPost(program: Command, ctx: CliContext): void {
  program
    .command("post <room> <text>")
    .description("start a new thread in a room")
    .action(async (room: string, text: string, _opts: unknown, cmd: Command) => {
      const { threadId } = await clientFor(cmd, ctx).post(room, text);
      ctx.out(globalOpts(cmd).json ? JSON.stringify({ threadId }) : threadId);
    });

  program
    .command("reply <thread> <text>")
    .description("reply to a thread")
    .action(async (thread: string, text: string, _opts: unknown, cmd: Command) => {
      await clientFor(cmd, ctx).reply(thread, text);
      ctx.out(globalOpts(cmd).json ? JSON.stringify({ ok: true }) : "ok");
    });

  program
    .command("label <thread> <pair>")
    .description("set a label on a thread (key=value)")
    .action(async (thread: string, pair: string, _opts: unknown, cmd: Command) => {
      const [key, value] = parseKeyValue(pair);
      await clientFor(cmd, ctx).label(thread, key, value);
      ctx.out(globalOpts(cmd).json ? JSON.stringify({ ok: true }) : "ok");
    });
}
