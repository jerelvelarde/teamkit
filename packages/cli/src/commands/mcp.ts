import type { Command } from "commander";
import { globalOpts, type CliContext } from "../context.js";
import { runMcp } from "../mcp/server.js";
import { VERSION } from "../version.js";

export function registerMcp(program: Command, ctx: CliContext): void {
  program
    .command("mcp")
    .description("run the TeamKit MCP server over stdio, for the Claude Code and Codex plugins")
    .action(async (_opts: unknown, cmd: Command) => {
      const { url, token } = globalOpts(cmd);
      await runMcp({ env: ctx.env, flags: { url, token }, log: ctx.err, version: VERSION });
    });
}
