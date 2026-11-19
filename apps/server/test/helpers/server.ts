import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Permission } from "@copilotkit/teamkit-protocol";
import type { Db } from "../../src/db/pool.js";
import { createApp } from "../../src/http/app.js";
import { createNotifier } from "../../src/notifier.js";
import { agentAuth } from "./actors.js";
import { createTestDatabase } from "./db.js";

export async function startTestServer(): Promise<{
  url: string;
  db: Db;
  stop(): Promise<void>;
}> {
  const t = await createTestDatabase();
  let notifier: Awaited<ReturnType<typeof createNotifier>> | undefined;
  try {
    notifier = await createNotifier(t.db);
    const app = createApp({ db: t.db, notifier });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    const { port } = server.address() as AddressInfo;
    const n = notifier;
    let stopped: Promise<void> | undefined;
    return {
      url: `http://127.0.0.1:${port}`,
      db: t.db,
      stop() {
        stopped ??= (async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await n.close();
          await t.drop();
        })();
        return stopped;
      },
    };
  } catch (err) {
    await notifier?.close().catch(() => {});
    await t.drop().catch(() => {});
    throw err;
  }
}

export async function agentToken(
  db: Db,
  name: string,
  grants?: { room: string; perms: Permission[] }[],
): Promise<string> {
  return (await agentAuth(db, name, grants)).token;
}
