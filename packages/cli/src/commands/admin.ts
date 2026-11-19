import type { Command } from "commander";
import { createAdminClient, type AdminClient } from "@copilotkit/teamkit-client";
import { PERMISSIONS, type GrantSpec, type Permission, type RoomSettingsInput } from "@copilotkit/teamkit-protocol";
import { resolveAdminConfig } from "../config.js";
import { collect, globalOpts, type CliContext } from "../context.js";
import { UsageError } from "../errors.js";

function parseCount(v: string): number {
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new UsageError("--count must be a positive integer");
  return Number(v);
}

const ANNOUNCE = ["blocked", "all", "none"] as const;

function adminFor(cmd: Command, ctx: CliContext): AdminClient {
  const { url, token } = globalOpts(cmd);
  return createAdminClient(resolveAdminConfig({ url, token }, ctx.env));
}

/** "pattern:perm,perm" split at the LAST ":". */
function parseGrantSpec(spec: string): GrantSpec {
  const i = spec.lastIndexOf(":");
  if (i < 0) throw new UsageError(`--rooms must be pattern:perm,perm, got ${spec}`);
  const room = spec.slice(0, i);
  const perms = spec
    .slice(i + 1)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (room === "") throw new UsageError(`no room pattern before ":" in ${spec}`);
  if (perms.length === 0) throw new UsageError(`no permissions after ":" in ${spec}`);
  for (const p of perms) {
    if (!(PERMISSIONS as readonly string[]).includes(p)) {
      throw new UsageError(`unknown permission ${p}; use ${PERMISSIONS.join(", ")}`);
    }
  }
  return { room, perms: perms as Permission[] };
}

/** "key=value" split at the FIRST "=". The value is never echoed back. */
function parseHeader(spec: string): [string, string] {
  const i = spec.indexOf("=");
  if (i <= 0) throw new UsageError("--header must be name=value");
  return [spec.slice(0, i).trim(), spec.slice(i + 1)];
}

/** "none" clears the setting. */
const noneOr = <T>(v: string, f: (s: string) => T): T | null => (v === "none" ? null : f(v));

export function registerAdmin(program: Command, ctx: CliContext): void {
  const tokens = program.command("tokens").description("manage agent tokens (admin)");

  tokens
    .command("create <name>")
    .description("create agent tokens; each token is shown once")
    .requiredOption("--rooms <spec>", "grants as pattern:perm,perm (repeatable)", collect)
    .option("--count <n>", "create <name>-1 .. <name>-n")
    .action(async (name: string, o: { rooms: string[]; count?: string }, cmd: Command) => {
      const rooms = o.rooms.map(parseGrantSpec);
      const count = o.count === undefined ? undefined : parseCount(o.count);
      const created = await adminFor(cmd, ctx).createTokens({ name, rooms, ...(count !== undefined ? { count } : {}) });
      if (globalOpts(cmd).json) {
        ctx.out(JSON.stringify(created));
        return;
      }
      for (const t of created) ctx.out(`${t.actor.name}\t${t.token}`);
    });

  tokens
    .command("list")
    .description("list tokens")
    .action(async (_o: unknown, cmd: Command) => {
      const list = await adminFor(cmd, ctx).tokens();
      if (globalOpts(cmd).json) {
        ctx.out(JSON.stringify(list));
        return;
      }
      for (const t of list) ctx.out(`${t.id}\t${t.actorName}\t${t.scope}\t${t.revokedAt ? "revoked" : "active"}`);
    });

  tokens
    .command("revoke <id>")
    .description("revoke a token")
    .action(async (id: string, _o: unknown, cmd: Command) => {
      await adminFor(cmd, ctx).revokeToken(id);
      ctx.out(globalOpts(cmd).json ? JSON.stringify({ revoked: id }) : "revoked");
    });

  // No `people invite` or `people link`: sign-in links become person sessions, so they
  // are minted only on the web board (admin session) or with `teamkit-admin` on the server.
  const people = program.command("people").description("people (admin)");

  people
    .command("list")
    .description("list people")
    .action(async (_o: unknown, cmd: Command) => {
      const list = await adminFor(cmd, ctx).people();
      if (globalOpts(cmd).json) {
        ctx.out(JSON.stringify(list));
        return;
      }
      for (const p of list) ctx.out(`${p.actor.name}\t${p.role}\t${p.lastSignInAt ?? "never"}`);
    });

  const agents = program.command("agents").description("agents the dispatcher runs (admin)");

  agents
    .command("register <name>")
    .description("register an AG-UI agent; header values are write-only")
    .requiredOption("--agent-url <u>", "the agent's AG-UI endpoint (--url is the TeamKit server)")
    .requiredOption("--rooms <list>", "comma-separated room patterns the agent may serve")
    .option("--header <k=v>", "header sent to the agent (repeatable)", collect)
    .action(async (name: string, o: { agentUrl: string; rooms: string; header?: string[] }, cmd: Command) => {
      const rooms = o.rooms
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      if (rooms.length === 0) throw new UsageError("--rooms needs at least one room");
      const headers = Object.fromEntries((o.header ?? []).map(parseHeader));
      const info = await adminFor(cmd, ctx).registerAgent({
        name,
        url: o.agentUrl,
        rooms,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
      ctx.out(globalOpts(cmd).json ? JSON.stringify(info) : `registered ${info.name}`);
    });

  agents
    .command("list")
    .description("list registered agents")
    .action(async (_o: unknown, cmd: Command) => {
      const list = await adminFor(cmd, ctx).agents();
      if (globalOpts(cmd).json) {
        ctx.out(JSON.stringify(list));
        return;
      }
      for (const a of list) ctx.out(`${a.name}\t${a.url}\t${a.rooms.join(",")}\t${a.enabled ? "enabled" : "disabled"}`);
    });

  for (const enabled of [true, false]) {
    const verb = enabled ? "enable" : "disable";
    agents
      .command(`${verb} <name>`)
      .description(`${verb} an agent`)
      .action(async (name: string, _o: unknown, cmd: Command) => {
        const info = await adminFor(cmd, ctx).setAgentEnabled(name, enabled);
        ctx.out(globalOpts(cmd).json ? JSON.stringify(info) : `${verb}d ${info.name}`);
      });
  }

  const rooms = program.commands.find((c) => c.name() === "rooms");
  if (!rooms) throw new Error("registerAdmin must run after registerWhoami: the rooms command is missing");
  rooms
    .command("set <name>")
    .description("change a room's agent, approvers or Slack settings (admin)")
    .option("--agent <n>", 'agent that runs tasks in this room, or "none"')
    .option("--approvers <a,b>", 'people who may approve, or "none"')
    .option("--slack-channel <id>", 'Slack channel id, or "none"')
    .option("--slack-announce <mode>", `${ANNOUNCE.join(", ")}`)
    .action(
      async (
        name: string,
        o: { agent?: string; approvers?: string; slackChannel?: string; slackAnnounce?: string },
        cmd: Command,
      ) => {
        const settings: RoomSettingsInput = {};
        if (o.agent !== undefined) settings.agent = noneOr(o.agent, (s) => s);
        if (o.approvers !== undefined) {
          settings.approvers = noneOr(o.approvers, (s) =>
            s
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean),
          );
        }
        if (o.slackChannel !== undefined) settings.slackChannel = noneOr(o.slackChannel, (s) => s);
        if (o.slackAnnounce !== undefined) {
          if (!(ANNOUNCE as readonly string[]).includes(o.slackAnnounce)) {
            throw new UsageError(`--slack-announce must be ${ANNOUNCE.join(", ")}`);
          }
          settings.slackAnnounce = o.slackAnnounce as (typeof ANNOUNCE)[number];
        }
        ctx.out(JSON.stringify(await adminFor(cmd, ctx).setRoom(name, settings)));
      },
    );
}
