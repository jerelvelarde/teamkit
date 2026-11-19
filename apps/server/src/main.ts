import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createDb } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./http/app.js";
import type { Mailer } from "./mail.js";
import { createNotifier } from "./notifier.js";
import { ensureBootstrapLink, signInUrl } from "./store/people.js";
import { startDispatcher, type Dispatcher } from "./dispatch/dispatcher.js";
import { SLACK_OUTBOUND_LOCK, startSingleton, TRIGGERS_LOCK, type Singleton } from "./singleton.js";
import { startTriggers } from "./triggers/runner.js";
import { startSlackBridge, type SlackBridge } from "./slack/bridge.js";
import { reapExpired } from "./store/reaper.js";
import { lapseReservations } from "./store/reservations.js";

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
let mailer: Mailer | undefined;
if (config.mail) {
  const { smtpMailer } = await import("./mail-smtp.js");
  mailer = smtpMailer({ url: config.mail.smtpUrl, from: config.mail.from });
  console.log("email sign-in on");
} else {
  console.log("email sign-in off (set TEAMKIT_SMTP_URL and TEAMKIT_MAIL_FROM)");
}
const app = createApp({ db, notifier, publicUrl: config.publicUrl, mailer }, { trustedProxy: config.trustedProxy });

const reaper = setInterval(() => {
  reapExpired(db)
    .then((n) => {
      if (n > 0) console.log(`reaped ${n} expired lease(s)`);
      return lapseReservations(db);
    })
    .then(
      (n) => {
        if (n > 0) console.log(`lapsed ${n} hold(s)`);
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

let dispatcher: Dispatcher | null = null;
let triggers: Singleton | null = null;
let outbound: Singleton | null = null;
let bridge: SlackBridge | null = null;

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reaper);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Stop triggers and abort runs (each releases its claim) before Slack, the notifier and the db go away.
  await triggers?.stop();
  await dispatcher?.stop();
  await bridge?.stop();
  await outbound?.stop();
  await notifier.close();
  await db.end({ timeout: 5 });
  process.exit(0);
}
// Registered before Slack starts: the bridge can wait up to 30 s for its Channel, and a signal
// in that time must still shut down cleanly.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdown().catch((err) => {
      console.error("shutdown failed", err);
      process.exit(1);
    });
  });
}

if (config.dispatch) {
  dispatcher = startDispatcher({ db, notifier, concurrency: config.dispatchConcurrency });
  console.log(`dispatcher started (concurrency ${config.dispatchConcurrency})`);
}

// Triggers and Slack outbound run in one process per database: each holds an advisory lock.
// The dispatcher needs none, because claims are atomic.
if (config.triggers) {
  triggers = startSingleton({
    url: config.databaseUrl,
    name: TRIGGERS_LOCK,
    log: (line) => console.warn(line),
    start: () => {
      const runner = startTriggers({ db, notifier, log: (line) => console.log(line) });
      console.log("triggers started");
      return runner;
    },
  });
  await triggers.ready;
}

const { botToken } = config.slack;
if (botToken) {
  const { startOutbound } = await import("./slack/outbound.js");
  const { startSlackStatus } = await import("./slack/status.js");
  outbound = startSingleton({
    url: config.databaseUrl,
    name: SLACK_OUTBOUND_LOCK,
    log: (line) => console.warn(line),
    start: async () => {
      const slack = { token: botToken, apiBase: config.slack.apiBase };
      const log = (line: string) => console.warn(line);
      const started = await startOutbound({ db, notifier, slack, publicUrl: config.publicUrl, log });
      console.log("slack outbound started");
      // The status worker runs in the same singleton: one process edits each room's status message.
      const status = await startSlackStatus({ db, notifier, slack, publicUrl: config.publicUrl, log });
      console.log("slack status started");
      return {
        async stop() {
          await status.stop();
          await started.stop();
        },
      };
    },
  });
  await outbound.ready;
}

try {
  bridge = await startSlackBridge({ db, config: config.slack.bridge });
  if (!bridge) console.log("slack bridge off (set CPK_INTELLIGENCE_API_KEY and TEAMKIT_SLACK_CHANNEL_NAME)");
} catch (err) {
  // The board keeps serving without Slack; say so loudly rather than exit.
  if (!shuttingDown) {
    console.error(
      `SLACK BRIDGE FAILED TO START: the server keeps running without Slack mentions, replies or buttons. ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
