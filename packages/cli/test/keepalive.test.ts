import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { TeamkitError, type TeamkitClient } from "@copilotkit/teamkit-client";
import { startKeepalive, watchedRooms } from "../src/mcp/keepalive.js";
import { createLeases } from "../src/mcp/leases.js";
import { createSession, NotSignedInError, type Session } from "../src/mcp/session.js";
import { isolatedEnv } from "./helpers/cli.js";
import { mcpTeam } from "./helpers/mcp.js";

interface Fake {
  client: TeamkitClient;
  calls: { rooms: number; heartbeat: { watching: string[]; status?: string }[]; renew: [string, string][] };
}

function fake(over: Partial<Record<"heartbeat" | "renew", (...a: never[]) => Promise<unknown>>> = {}): Fake {
  const calls: Fake["calls"] = { rooms: 0, heartbeat: [], renew: [] };
  const client = {
    rooms: async () => {
      calls.rooms++;
      return [{ name: "billing-migration" }];
    },
    heartbeat: async (input: { watching: string[]; status?: string }) => {
      calls.heartbeat.push(input);
      if (over.heartbeat) await over.heartbeat();
    },
    renew: async (taskId: string, claimId: string) => {
      calls.renew.push([taskId, claimId]);
      if (over.renew) return over.renew();
      return { leaseExpiresAt: new Date(Date.now() + 300_000).toISOString() };
    },
  } as unknown as TeamkitClient;
  return { client, calls };
}

const sessionOf = (client: TeamkitClient): Session => ({ client: () => client });

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await delay(5);
  }
}

test("watchedRooms prefers TEAMKIT_ROOMS, trimmed and de-duplicated", async () => {
  const f = fake();
  assert.deepEqual(await watchedRooms({ TEAMKIT_ROOMS: " billing-migration, billing-prod ,,billing-prod" }, f.client),
    ["billing-migration", "billing-prod"]);
  assert.equal(f.calls.rooms, 0);
});

test("watchedRooms falls back to the rooms the agent can read", async () => {
  const f = fake();
  assert.deepEqual(await watchedRooms({}, f.client), ["billing-migration"]);
  assert.equal(f.calls.rooms, 1);
});

test("beats at start and then every interval", async () => {
  const f = fake();
  const env = isolatedEnv();
  const ka = startKeepalive({ session: sessionOf(f.client), leases: createLeases(env), env, log: () => {}, heartbeatMs: 20 });
  try {
    await delay(70);
    assert.ok(f.calls.heartbeat.length >= 3, String(f.calls.heartbeat.length));
    for (const h of f.calls.heartbeat) assert.deepEqual(h, { watching: ["billing-migration"] });
  } finally {
    ka.stop();
  }
});

test("not signed in: no calls and one log line, then resumes after join", async () => {
  const f = fake();
  let ticks = 0;
  const session: Session = {
    client() {
      if (++ticks <= 3) throw new NotSignedInError();
      return f.client;
    },
  };
  const lines: string[] = [];
  const env = isolatedEnv();
  const ka = startKeepalive({ session, leases: createLeases(env), env, log: (l) => lines.push(l), heartbeatMs: 10 });
  try {
    await waitFor(() => ticks >= 3);
    assert.equal(f.calls.heartbeat.length, 0);
    await waitFor(() => f.calls.heartbeat.length > 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /not signed in/);
  } finally {
    ka.stop();
  }
});

test("the same heartbeat failure is logged once and the loop goes on", async () => {
  const f = fake({ heartbeat: async () => { throw new TeamkitError("http_error", 502, "bad gateway"); } });
  const lines: string[] = [];
  const env = isolatedEnv();
  const ka = startKeepalive({ session: sessionOf(f.client), leases: createLeases(env), env, log: (l) => lines.push(l), heartbeatMs: 10 });
  try {
    await waitFor(() => f.calls.heartbeat.length >= 3);
  } finally {
    ka.stop();
  }
  assert.deepEqual(lines, ["teamkit mcp: heartbeat failed: http_error: bad gateway"]);
});

test("renewAll drops a lost claim", async () => {
  const f = fake({ renew: async () => { throw new TeamkitError("claim_lost", 409, ""); } });
  const lines: string[] = [];
  const env = isolatedEnv();
  const leases = createLeases(env);
  leases.hold("th_a", "cl_1");
  const ka = startKeepalive({ session: sessionOf(f.client), leases, env, log: (l) => lines.push(l), heartbeatMs: 60_000, renewEveryMs: 60_000 });
  try {
    await ka.renewAll();
    assert.deepEqual(f.calls.renew, [["th_a", "cl_1"]]);
    assert.deepEqual(leases.held(), []);
    assert.ok(lines.some((l) => /claim lost on th_a/.test(l)), lines.join("\n"));
  } finally {
    ka.stop();
  }
});

test("renewAll keeps a claim on any other error", async () => {
  const f = fake({ renew: async () => { throw new TeamkitError("timeout", 0, "no response"); } });
  const env = isolatedEnv();
  const leases = createLeases(env);
  leases.hold("th_a", "cl_1");
  const ka = startKeepalive({ session: sessionOf(f.client), leases, env, log: () => {}, heartbeatMs: 60_000, renewEveryMs: 60_000 });
  try {
    await ka.renewAll();
    assert.deepEqual(leases.held(), [{ taskId: "th_a", claimId: "cl_1" }]);
  } finally {
    ka.stop();
  }
});

test("stop ends both loops", async () => {
  const f = fake();
  const env = isolatedEnv();
  const leases = createLeases(env);
  leases.hold("th_a", "cl_1");
  const ka = startKeepalive({ session: sessionOf(f.client), leases, env, log: () => {}, heartbeatMs: 10, renewEveryMs: 10 });
  await waitFor(() => f.calls.heartbeat.length > 0 && f.calls.renew.length > 0);
  ka.stop();
  await delay(15);
  const seen = [f.calls.heartbeat.length, f.calls.renew.length];
  await delay(60);
  assert.deepEqual([f.calls.heartbeat.length, f.calls.renew.length], seen);
});

test("renewal keeps a real claim's lease moving", async () => {
  const t = await mcpTeam();
  const env = isolatedEnv({ TEAMKIT_URL: t.srv.url, TEAMKIT_TOKEN: t.benToken });
  const leases = createLeases(env);
  const ka = startKeepalive({ session: createSession({ env }), leases, env, log: () => {}, heartbeatMs: 60_000, renewEveryMs: 300 });
  try {
    const task = await t.benClient.createTask({ room: "billing-migration", brief: "Copy the invoices table to billing-v2" });
    const claim = await t.benClient.claim(task.id);
    leases.hold(task.id, claim.claimId);
    const first = claim.leaseExpiresAt;
    await delay(1200);
    const later = (await t.benClient.thread(task.id)).task!.claim!.leaseExpiresAt;
    assert.ok(Date.parse(later) > Date.parse(first), `${later} > ${first}`);
  } finally {
    ka.stop();
    await t.srv.stop();
  }
});
