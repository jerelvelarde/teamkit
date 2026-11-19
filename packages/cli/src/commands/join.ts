import type { Command } from "commander";
import { TeamkitError, waitForDeviceLogin } from "@copilotkit/teamkit-client";
import { clearConfigKeys, readConfigFile, writeConfigFile } from "../config.js";
import { globalOpts, type CliContext } from "../context.js";
import { startDeviceOrExit } from "../device.js";
import { CliExit, UsageError } from "../errors.js";

/**
 * The server a `teamkit join` argument names, without trailing slashes. A team join link is
 * refused: it makes a person on the team, so it must never pass through an agent. The message
 * never repeats the link.
 */
export function joinServerUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`not an http(s) URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`not an http(s) URL: ${raw}`);
  if (/^\/join\//.test(u.pathname)) {
    throw new UsageError(
      `give your agent the board URL, not the join link (${u.origin}); open the join link in your browser to join the team`,
    );
  }
  return raw.replace(/\/+$/, "");
}

export function registerJoin(program: Command, ctx: CliContext): void {
  program
    .command("join <url>")
    .description("connect your own agent to a TeamKit board with a code you approve on the web board")
    .action(async (rawUrl: string, _opts: unknown, cmd: Command) => {
      const { json } = globalOpts(cmd);
      const url = joinServerUrl(rawUrl);

      const start = await startDeviceOrExit(url, "agent");
      ctx.err(`To connect your agent, open ${start.verifyUrl} and confirm code ${start.userCode}`);
      if (json) ctx.out(JSON.stringify({ userCode: start.userCode, verifyUrl: start.verifyUrl }));

      let result;
      try {
        result = await waitForDeviceLogin(url, start);
      } catch (e) {
        if (e instanceof TeamkitError && e.code === "expired") {
          throw new CliExit(1, `join code expired; run \`teamkit join ${url}\` again`);
        }
        throw e;
      }

      // A machine talks to one TeamKit server, so an admin login for another server goes.
      const file = readConfigFile(ctx.env);
      if (file.adminToken !== undefined && file.url !== undefined && file.url !== url) {
        clearConfigKeys(["adminToken"], ctx.env);
        ctx.err(`Removed the admin login for ${file.url}: this machine now uses ${url}.`);
      }
      writeConfigFile({ url, token: result.token }, ctx.env);

      if (json) ctx.out(JSON.stringify({ actor: result.actor }));
      else ctx.out(`Joined as ${result.actor.name}.`);
      if (ctx.env.TEAMKIT_TOKEN) {
        ctx.err(`TEAMKIT_TOKEN is set in this shell and overrides the saved token; unset it to act as ${result.actor.name}.`);
      }
    });
}
