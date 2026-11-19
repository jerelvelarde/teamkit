import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotifier } from "../src/notifier.js";
import { lockKey, startSingleton } from "../src/singleton.js";
import { startTriggers } from "../src/triggers/runner.js";
import { addTrigger, listTriggers } from "../src/triggers/store.js";
import { createTask } from "../src/store/tasks.js";
import { claimTask, complete } from "../src/store/claims.js";
import { agentAuth } from "./helpers/actors.js";
import { createTestDatabase } from "./helpers/db.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

test("lockKey is stable and differs per name", () => {
  assert.equal(lockKey("teamkit:triggers"), lockKey("teamkit:triggers"));
  assert.notEqual(lockKey("teamkit:triggers"), lockKey("teamkit:slack-outbound"));
});

test("one instance holds the lock; another takes over after the holder stops", async () => {
  const t = await createTestDatabase({ migrate: false });
  try {
    const logs: string[] = [];
    const started: string[] = [];
    const make = (id: string) =>
      startSingleton({
        url: t.url,
        name: "teamkit:test",
        retryMs: 40,
        log: (l) => logs.push(`${id}: ${l}`),
        start: () => {
          started.push(id);
          return { stop: async () => void started.push(`${id}-stopped`) };
        },
      });
    const a = make("a");
    await a.ready;
    const b = make("b");
    await b.ready;
    assert.equal(a.held(), true);
    assert.equal(b.held(), false);
    assert.deepEqual(started, ["a"]);
    assert.equal(logs.filter((l) => /^b: .*another instance holds/.test(l)).length, 1);
    await a.stop();
    await waitFor("b to take over", () => b.held());
    assert.deepEqual(started, ["a", "a-stopped", "b"]);
    await b.stop();
    assert.equal(b.held(), false);
    // The server drops the backend a moment after the client hangs up.
    await waitFor("the lock to be freed", async () => (await t.db`select 1 from pg_locks where locktype = 'advisory'`).length === 0);
  } finally {
    await t.drop();
  }
});

test("a holder whose connection was replaced gives the work up", async () => {
  const t = await createTestDatabase({ migrate: false });
  try {
    const logs: string[] = [];
    let stops = 0;
    const s = startSingleton({
      url: t.url,
      name: "teamkit:test",
      retryMs: 40,
      log: (l) => logs.push(l),
      start: () => ({ stop: async () => void stops++ }),
    });
    await s.ready;
    // Only this test database's advisory-lock holders: other test files run in parallel on the
    // same cluster and take transaction-level advisory locks (migrate, appendEvent).
    await t.db`
      select pg_terminate_backend(l.pid)
      from pg_locks l join pg_database d on d.oid = l.database
      where l.locktype = 'advisory' and l.granted
        and d.datname = current_database() and l.pid <> pg_backend_pid()`;
    await waitFor("the work to stop", () => stops === 1);
    // It then takes the lock again on its fresh connection.
    await waitFor("a restart", () => s.held());
    assert.match(logs.join("\n"), /lost the lock/);
    await s.stop();
    assert.equal(stops, 2);
  } finally {
    await t.drop();
  }
});

test("two trigger runners on one database deliver each event once", async () => {
  const t = await createTestDatabase();
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { event: { cursor: string } }).event.cursor);
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  const notifiers = await Promise.all([createNotifier(t.db), createNotifier(t.db)]);
  const runners = notifiers.map((notifier) =>
    startSingleton({
      url: t.url,
      name: "teamkit:triggers",
      retryMs: 40,
      start: () => startTriggers({ db: t.db, notifier, pollMs: 30 }),
    }),
  );
  try {
    await Promise.all(runners.map((r) => r.ready));
    assert.equal(runners.filter((r) => r.held()).length, 1);
    const bot = await agentAuth(t.db, "bot");
    await addTrigger(t.db, { name: "hook", room: "*", kinds: ["task.completed"], webhook: url });
    for (let i = 0; i < 3; i++) {
      const task = await createTask(t.db, bot, { room: "build", brief: `work ${i}` });
      const claim = await claimTask(t.db, bot, task.id);
      await complete(t.db, bot, task.id, claim.claimId, "done");
    }
    await waitFor("three deliveries", () => hits.length >= 3);
    await sleep(300);
    assert.equal(hits.length, 3);
    assert.equal(new Set(hits).size, 3);
    assert.equal((await listTriggers(t.db))[0]!.cursor, hits[hits.length - 1]);
  } finally {
    await Promise.all(runners.map((r) => r.stop()));
    await Promise.all(notifiers.map((n) => n.close()));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await t.drop();
  }
});
