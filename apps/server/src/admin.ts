import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { BoardError, isBoardError } from "@copilotkit/teamkit-protocol";
import { createDb, type Db } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { createAgent, createAgentTokens, listTokens, revokeToken, type Grant } from "./store/actors.js";
import { getRoomInfo, setRoom, type RoomSettings } from "./store/rooms.js";

const DEFAULT_DATABASE_URL = "postgres://teamkit@127.0.0.1:54329/teamkit";

/** "pattern:perm,perm" split at the LAST ":". */
function parseGrant(spec: string): Grant {
  const i = spec.lastIndexOf(":");
  if (i < 0) throw new BoardError("invalid_input", `room spec must be pattern:perm,perm: ${spec}`);
  return {
    room: spec.slice(0, i),
    perms: spec
      .slice(i + 1)
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "") as Grant["perms"],
  };
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
    .requiredOption("--rooms <spec...>", "grants as pattern:perm,perm")
    .option("--count <n>", "create <name>-1 .. <name>-n", parseCount)
    .exitOverride()
    .action(async (name: string, opts: { rooms: string[]; count?: number }) => {
      const grants = opts.rooms.map(parseGrant);
      const created = await withDb((db) =>
        opts.count === undefined
          ? createAgent(db, { name, grants }).then((a) => [a])
          : createAgentTokens(db, { baseName: name, count: opts.count, grants }),
      );
      for (const a of created) process.stdout.write(`${a.actor.name}\t${a.token}\n`);
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
