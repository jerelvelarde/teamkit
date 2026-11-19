import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { BoardError, isBoardError, type EventKind, type TriggerInput } from "@copilotkit/teamkit-protocol";
import { createDb, type Db } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { createAgent, createAgentTokens, listTokens, revokeToken, type Grant } from "./store/actors.js";
import { getRoomInfo, setRoom, type RoomSettings } from "./store/rooms.js";
import { listAgents, registerAgent, toAgentInfo } from "./dispatch/registry.js";
import { addTrigger, listTriggers, removeTrigger } from "./triggers/store.js";
import { DEFAULT_PUBLIC_URL, invitePerson, listPeople, signInUrl } from "./store/people.js";

const DEFAULT_DATABASE_URL = "postgres://teamkit@127.0.0.1:54329/teamkit";

/** "pattern:perm,perm" split at the LAST ":"; collects repeated specs into a list. */
function parseGrant(spec: string, previous: Grant[] | undefined): Grant[] {
  const i = spec.lastIndexOf(":");
  if (i < 0) throw new BoardError("invalid_input", `room spec must be pattern:perm,perm: ${spec}`);
  const perms = spec
    .slice(i + 1)
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "") as Grant["perms"];
  // A grant with no permissions would create an agent that can do nothing.
  if (perms.length === 0) throw new InvalidArgumentError(`no permissions after ":" in ${spec}`);
  return [...(previous ?? []), { room: spec.slice(0, i), perms }];
}

/** "k=v" split at the FIRST "="; repeated options accumulate. The value is a secret, so errors never echo it. */
function parseHeader(spec: string, previous: Record<string, string> | undefined): Record<string, string> {
  const i = spec.indexOf("=");
  if (i <= 0) throw new BoardError("invalid_input", "--header must be name=value");
  return { ...(previous ?? {}), [spec.slice(0, i)]: spec.slice(i + 1) };
}

/** "k=v" split at the FIRST "="; repeated --label options accumulate. */
function parseLabel(spec: string, previous: Record<string, string> | undefined): Record<string, string> {
  const i = spec.indexOf("=");
  if (i <= 0) throw new InvalidArgumentError("--label must be key=value");
  return { ...(previous ?? {}), [spec.slice(0, i)]: spec.slice(i + 1) };
}

function parseCount(v: string): number {
  if (!/^\d+$/.test(v)) throw new InvalidArgumentError("count must be an integer");
  return Number(v);
}

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, { max: 2 });
  try {
    await migrate(db);
    return await fn(db);
  } finally {
    await db.end({ timeout: 5 });
  }
}

function buildProgram(): Command {
  const program = new Command("teamkit-admin").exitOverride();
  program.description("Administer TeamKit agents, tokens and rooms (direct database access)");

  const agents = program.command("agents").exitOverride();
  agents
    .command("create <name>")
    .description("create an agent and print `name<TAB>token` lines (the only time a token is shown)")
    .requiredOption("--rooms <spec...>", "grants as pattern:perm,perm", parseGrant)
    .option("--count <n>", "create <name>-1 .. <name>-n", parseCount)
    .exitOverride()
    .action(async (name: string, opts: { rooms: Grant[]; count?: number }) => {
      const created = await withDb((db) =>
        opts.count === undefined
          ? createAgent(db, { name, grants: opts.rooms }).then((a) => [a])
          : createAgentTokens(db, { baseName: name, count: opts.count, grants: opts.rooms }),
      );
      for (const a of created) process.stdout.write(`${a.actor.name}\t${a.token}\n`);
    });

  agents
    .command("register <name>")
    .description("register an AG-UI agent TeamKit calls itself and print its info as JSON (header values are never printed)")
    .requiredOption("--url <url>", "the agent's AG-UI endpoint")
    .requiredOption("--rooms <list>", "comma-separated room patterns the agent may work in")
    .option("--header <k=v>", "header sent to the agent; repeat for more", parseHeader)
    .exitOverride()
    .action(async (name: string, opts: { url: string; rooms: string; header?: Record<string, string> }) => {
      const rooms = opts.rooms
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r !== "");
      const agent = await withDb((db) => registerAgent(db, { name, url: opts.url, rooms, headers: opts.header }));
      process.stdout.write(`${JSON.stringify(toAgentInfo(agent))}\n`);
    });
  agents
    .command("list")
    .description("list registered agents as name, url, rooms, enabled|disabled")
    .exitOverride()
    .action(async () => {
      for (const a of await withDb(listAgents)) {
        process.stdout.write(`${a.name}\t${a.url}\t${a.rooms.join(",")}\t${a.enabled ? "enabled" : "disabled"}\n`);
      }
    });

  const tokens = program.command("tokens").exitOverride();
  tokens
    .command("list")
    .description("list tokens as tokenId, agentName, scope, active|revoked")
    .exitOverride()
    .action(async () => {
      const rows = await withDb(listTokens);
      for (const t of rows) {
        process.stdout.write(`${t.id}\t${t.actorName}\t${t.scope}\t${t.revokedAt ? "revoked" : "active"}\n`);
      }
    });
  tokens
    .command("revoke <tokenId>")
    .exitOverride()
    .action(async (tokenId: string) => {
      await withDb((db) => revokeToken(db, tokenId));
    });

  const rooms = program.command("rooms").exitOverride();
  rooms
    .command("set <name>")
    .description("create or update a room's settings and print its info as JSON")
    .option("--agent <name>", "agent that handles the room")
    .option("--approvers <names>", "comma-separated approver names")
    .option("--slack-channel <id>", "Slack channel id")
    .option("--slack-announce <mode>", "blocked, all or none")
    .exitOverride()
    .action(
      async (
        name: string,
        opts: { agent?: string; approvers?: string; slackChannel?: string; slackAnnounce?: string },
      ) => {
        const settings: RoomSettings = {};
        if (opts.agent !== undefined) settings.agent = opts.agent;
        if (opts.approvers !== undefined) {
          settings.approvers = opts.approvers
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "");
        }
        if (opts.slackChannel !== undefined) settings.slackChannel = opts.slackChannel;
        if (opts.slackAnnounce !== undefined) {
          settings.slackAnnounce = opts.slackAnnounce as RoomSettings["slackAnnounce"];
        }
        const info = await withDb(async (db) => {
          await setRoom(db, name, settings);
          return getRoomInfo(db, name);
        });
        process.stdout.write(`${JSON.stringify(info)}\n`);
      },
    );

  const people = program.command("people").exitOverride();
  people
    .command("invite <name>")
    .description("create a person if needed and print a one-time sign-in link (valid 24 hours)")
    .option("--admin", "make a new person an admin")
    .exitOverride()
    .action(async (name: string, opts: { admin?: boolean }) => {
      const { secret } = await withDb((db) => invitePerson(db, { name, role: opts.admin ? "admin" : "member" }));
      process.stdout.write(`${signInUrl(process.env.TEAMKIT_PUBLIC_URL || DEFAULT_PUBLIC_URL, secret)}\n`);
    });
  people
    .command("list")
    .description("list people as name, role, last sign-in")
    .exitOverride()
    .action(async () => {
      for (const p of await withDb(listPeople)) {
        process.stdout.write(`${p.actor.name}\t${p.role}\t${p.lastSignInAt ?? "never"}\n`);
      }
    });

  const triggers = program.command("triggers").exitOverride();
  triggers
    .command("add <name>")
    .description("add a trigger; a webhook trigger prints `secret<TAB>whsec_...` (the only time it is shown)")
    .requiredOption("--room <filter>", "room pattern the trigger watches")
    .requiredOption("--kinds <list>", "comma-separated event kinds, e.g. task.completed,task.failed")
    .option("--label <k=v>", "only events on tasks with this label; repeat for more", parseLabel)
    .option("--webhook <url>", "URL that receives signed deliveries")
    .option("--agent <name>", "registered agent to wake up")
    .exitOverride()
    .action(
      async (
        name: string,
        opts: { room: string; kinds: string; label?: Record<string, string>; webhook?: string; agent?: string },
        cmd: Command,
      ) => {
        if ((opts.webhook === undefined) === (opts.agent === undefined)) {
          cmd.error("error: give exactly one of --webhook or --agent");
        }
        const input: TriggerInput = {
          name,
          room: opts.room,
          kinds: opts.kinds
            .split(",")
            .map((k) => k.trim())
            .filter((k) => k !== "") as EventKind[],
        };
        if (opts.label !== undefined) input.labels = opts.label;
        if (opts.webhook !== undefined) input.webhook = opts.webhook;
        if (opts.agent !== undefined) input.agent = opts.agent;
        const created = await withDb((db) => addTrigger(db, input));
        process.stdout.write(`${JSON.stringify(created.trigger)}\n`);
        if (created.secret !== null) process.stdout.write(`secret\t${created.secret}\n`);
      },
    );
  triggers
    .command("list")
    .description("list triggers as name, room, kinds, action, cursor")
    .exitOverride()
    .action(async () => {
      for (const t of await withDb(listTriggers)) {
        const action = t.action.type === "webhook" ? `webhook ${t.action.url}` : `agent ${t.action.agent}`;
        process.stdout.write(`${t.name}\t${t.room}\t${t.kinds.join(",")}\t${action}\t${t.cursor}\n`);
      }
    });
  triggers
    .command("remove <name>")
    .exitOverride()
    .action(async (name: string) => {
      await withDb((db) => removeTrigger(db, name));
    });

  return program;
}

export async function main(argv: string[]): Promise<number> {
  try {
    await buildProgram().parseAsync(argv);
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      return e.exitCode === 0 ? 0 : 2;
    }
    if (isBoardError(e)) {
      process.stderr.write(`error: ${e.code}: ${e.message}\n`);
      return 1;
    }
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv);
}
