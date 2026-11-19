import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createDb } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./http/app.js";
import { createNotifier } from "./notifier.js";
import { ensureBootstrapLink, signInUrl } from "./store/people.js";
import { reapExpired } from "./store/reaper.js";

const config = loadConfig();
const db = createDb(config.databaseUrl);
const applied = await migrate(db);
console.log(`migrations applied: ${applied.length ? applied.join(", ") : "none"}`);

const bootstrapSecret = await ensureBootstrapLink(db);
if (bootstrapSecret) {
  console.log(
    [
      "",
      "No one has signed in yet. Open this link to sign in as the first admin.",
      `bootstrap admin sign-in link (valid 24 h): ${signInUrl(config.publicUrl, bootstrapSecret)}`,
      "",
    ].join("\n"),
  );
}

const notifier = await createNotifier(db);
const app = createApp({ db, notifier, publicUrl: config.publicUrl });

const reaper = setInterval(() => {
  reapExpired(db).then(
    (n) => {
      if (n > 0) console.log(`reaped ${n} expired lease(s)`);
    },
    (err) => console.error("reaper failed", err),
  );
}, config.reapIntervalMs);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }) as Server;
if (!server.listening) {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}
const { port } = server.address() as AddressInfo;
console.log(`teamkit-server listening on http://127.0.0.1:${port}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reaper);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await notifier.close();
  await db.end({ timeout: 5 });
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdown().catch((err) => {
      console.error("shutdown failed", err);
      process.exit(1);
    });
  });
}
