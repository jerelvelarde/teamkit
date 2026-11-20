import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withTestDb } from "./helpers/db.js";
import { authenticate } from "../src/store/actors.js";
import { getRoomInfo } from "../src/store/rooms.js";
import { getAgent } from "../src/dispatch/registry.js";
import { consumeSignInLink } from "../src/store/people.js";
import { redeemJoinLink } from "../src/store/join.js";

const CWD = fileURLToPath(new URL("..", import.meta.url));

function run(
  url: string,
  args: string[],
  entry: string[] = ["--import", "tsx", "src/admin.ts"],
  extraEnv: Record<string, string> = {},
) {
  const r = spawnSync(process.execPath, [...entry, ...args], {
    cwd: CWD,
    env: { ...process.env, TEAMKIT_PUBLIC_URL: "", ...extraEnv, DATABASE_URL: url },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("agents create --count prints one name/token line per agent and the tokens authenticate", async () => {
  await withTestDb(async (db, url) => {
    const r = run(url, ["agents", "create", "worker", "--rooms", "build/:read,post,claim", "--count", "3"]);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split("\n").filter(Boolean);
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^worker-1\ttk_[A-Za-z0-9_-]{43}$/);
    const token = lines[0]!.split("\t")[1]!;
    const auth = await authenticate(db, token);
    assert.equal(auth?.actor.name, "worker-1");
  });
});

test("tokens list then tokens revoke", async () => {
  await withTestDb(async (db, url) => {
    const c = run(url, ["agents", "create", "bot", "--rooms", "*:read"]);
    assert.equal(c.code, 0, c.err);
    const token = c.out.trim().split("\t")[1]!;
    const l = run(url, ["tokens", "list"]);
    assert.equal(l.code, 0, l.err);
    const [id, name, scope, state] = l.out.trim().split("\t");
    assert.match(id!, /^tok_/);
    assert.deepEqual([name, scope, state], ["bot", "agent", "active"]);
    const rv = run(url, ["tokens", "revoke", id!]);
    assert.equal(rv.code, 0, rv.err);
    assert.equal(await authenticate(db, token), null);
    assert.equal(run(url, ["tokens", "list"]).out.trim().split("\t")[3], "revoked");
  });
});

test("rooms set stores settings and prints the room info", async () => {
  await withTestDb(async (db, url) => {
    const r = run(url, ["rooms", "set", "build", "--approvers", "ada,bob", "--slack-announce", "all"]);
    assert.equal(r.code, 0, r.err);
    const info = await getRoomInfo(db, "build");
    assert.deepEqual(info?.approvers, ["ada", "bob"]);
    assert.equal(info?.slackAnnounce, "all");
    assert.deepEqual(JSON.parse(r.out), info);
  });
});

test("a bad permission exits 1 with invalid_input", async () => {
  await withTestDb(async (_db, url) => {
    const r = run(url, ["agents", "create", "bot", "--rooms", "build/:read,fly"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /^error: invalid_input: /);
    assert.equal(r.out, "");
  });
});

test("a room spec with no permissions exits 2 and creates no agent", async () => {
  await withTestDb(async (db, url) => {
    for (const spec of ["build:", "build: , "]) {
      const r = run(url, ["agents", "create", "w", "--rooms", "*:read", "--rooms", spec]);
      assert.equal(r.code, 2, spec);
      assert.match(r.err, /no permissions/);
      assert.equal(r.out, "");
    }
    assert.equal((await db`select 1 from actors where name = 'w'`).length, 0);
    const ok = run(url, ["agents", "create", "w", "--rooms", "build:read,post", "--rooms", "ops/:read"]);
    assert.equal(ok.code, 0, ok.err);
    const grants = await db`
      select g.room_pattern, g.perms from grants g join actors a on a.id = g.actor_id
      where a.name = 'w' order by g.room_pattern`;
    assert.deepEqual(
      grants.map((g) => [g.room_pattern, g.perms]),
      [["build", ["read", "post"]], ["ops/", ["read"]]],
    );
  });
});

test("an unknown subcommand exits 2", async () => {
  await withTestDb(async (_db, url) => {
    assert.equal(run(url, ["frobnicate"]).code, 2);
    assert.equal(run(url, ["agents", "frobnicate"]).code, 2);
  });
});

test("the bin wrapper runs", async () => {
  await withTestDb(async (_db, url) => {
    const r = run(url, ["tokens", "list"], ["bin/teamkit-admin.mjs"]);
    assert.equal(r.code, 0, r.err);
  });
});

test("people invite prints one sign-in link and people list shows the person", async () => {
  await withTestDb(async (db, url) => {
    const r = run(url, ["people", "invite", "ada", "--admin"]);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^http:\/\/127\.0\.0\.1:3000\/signin\/sl_[A-Za-z0-9_-]{43}$/);
    const secret = lines[0]!.split("/signin/")[1]!;

    const custom = run(url, ["people", "invite", "ada"], undefined, { TEAMKIT_PUBLIC_URL: "https://board.example.com/" });
    assert.equal(custom.code, 0, custom.err);
    assert.ok(custom.out.startsWith("https://board.example.com/signin/sl_"), custom.out);

    const l = run(url, ["people", "list"]);
    assert.equal(l.code, 0, l.err);
    assert.equal(l.out, "ada\tadmin\tnever\n");

    // Re-inviting without --admin kept the existing role.
    const again = custom.out.trim().split("/signin/")[1]!;
    assert.equal((await consumeSignInLink(db, again)).role, "admin");
    // Signing in with one link cancelled the other.
    await assert.rejects(consumeSignInLink(db, secret), (e: unknown) => (e as { code?: string }).code === "unauthorized");
  });
});

test("people invite refuses a name an agent holds", async () => {
  await withTestDb(async (_db, url) => {
    assert.equal(run(url, ["agents", "create", "bot", "--rooms", "*:read"]).code, 0);
    const r = run(url, ["people", "invite", "bot"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /invalid_input/);
    assert.equal(r.out, "");
  });
});

test("agents register prints info without header values, and agents list shows the line", async () => {
  await withTestDb(async (db, url) => {
    const r = run(url, [
      "agents", "register", "researcher", "--url", "http://127.0.0.1:9/agent",
      "--rooms", "research,lab", "--header", "Authorization=Bearer-x",
    ]);
    assert.equal(r.code, 0, r.err);
    const info = JSON.parse(r.out);
    assert.deepEqual(info.headerNames, ["Authorization"]);
    assert.deepEqual(info.rooms, ["research", "lab"]);
    assert.ok(!r.out.includes("Bearer-x"));
    assert.equal((await getAgent(db, "researcher"))?.headers.Authorization, "Bearer-x");
    const l = run(url, ["agents", "list"]);
    assert.equal(l.code, 0, l.err);
    assert.equal(l.out, "researcher\thttp://127.0.0.1:9/agent\tresearch,lab\tenabled\n");
    assert.ok(!l.out.includes("Bearer-x"));
  });
});

test("agents register splits a header at the first '=' and accepts several", async () => {
  await withTestDb(async (db, url) => {
    const r = run(url, [
      "agents", "register", "bot", "--url", "http://127.0.0.1:9/a", "--rooms", "lab",
      "--header", "X-Key=a=b", "--header", "X-Other=c",
    ]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual((await getAgent(db, "bot"))?.headers, { "X-Key": "a=b", "X-Other": "c" });
  });
});

test("agents register with a bad url or a malformed header exits 1 without echoing the secret", async () => {
  await withTestDb(async (db, url) => {
    const bad = run(url, ["agents", "register", "bot", "--url", "not a url", "--rooms", "lab"]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /^error: invalid_input: /);
    const h = run(url, ["agents", "register", "bot", "--url", "http://127.0.0.1:9/a", "--rooms", "lab", "--header", "s3cret"]);
    assert.equal(h.code, 1);
    assert.match(h.err, /^error: invalid_input: /);
    assert.ok(!h.err.includes("s3cret"));
    assert.equal(await getAgent(db, "bot"), null);
  });
});

test("triggers add a webhook prints the info and the secret once; list shows no secret; remove deletes", async () => {
  await withTestDb(async (_db, url) => {
    const r = run(url, [
      "triggers", "add", "notify", "--room", "build/", "--kinds", "task.completed,task.failed",
      "--label", "team=a", "--webhook", "http://127.0.0.1:9/hook",
    ]);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    const info = JSON.parse(lines[0]!);
    assert.equal(info.name, "notify");
    assert.deepEqual(info.labels, { team: "a" });
    assert.match(lines[1]!, /^secret\twhsec_[A-Za-z0-9_-]{43}$/);

    const l = run(url, ["triggers", "list"]);
    assert.equal(l.code, 0, l.err);
    assert.match(
      l.out,
      /^notify\tbuild\/\ttask\.completed,task\.failed\twebhook http:\/\/127\.0\.0\.1:9\/hook\t\d+\n$/,
    );
    assert.ok(!l.out.includes("whsec_"));

    assert.equal(run(url, ["triggers", "remove", "notify"]).code, 0);
    assert.equal(run(url, ["triggers", "list"]).out, "");
    const again = run(url, ["triggers", "remove", "notify"]);
    assert.equal(again.code, 1);
    assert.match(again.err, /^error: not_found: /);
  });
});

test("triggers add for an unregistered agent exits 1 invalid_input; a registered one prints no secret", async () => {
  await withTestDb(async (_db, url) => {
    const bad = run(url, ["triggers", "add", "wake", "--room", "build/", "--kinds", "task.completed", "--agent", "ghost"]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /^error: invalid_input: /);
    assert.equal(bad.out, "");
    assert.equal(run(url, ["agents", "register", "lead", "--url", "http://127.0.0.1:9/a", "--rooms", "build"]).code, 0);
    const ok = run(url, ["triggers", "add", "wake", "--room", "build/", "--kinds", "task.completed", "--agent", "lead"]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(ok.out.split("\n").filter(Boolean).length, 1);
    assert.deepEqual(JSON.parse(ok.out).action, { type: "agent", agent: "lead" });
  });
});

test("triggers add needs exactly one of --webhook and --agent (exit 2) and creates nothing", async () => {
  await withTestDb(async (_db, url) => {
    const base = ["triggers", "add", "t", "--room", "build/", "--kinds", "task.completed"];
    assert.equal(run(url, [...base, "--webhook", "http://127.0.0.1:9/h", "--agent", "lead"]).code, 2);
    assert.equal(run(url, base).code, 2);
    assert.equal(run(url, ["triggers", "list"]).out, "");
  });
});

test("teamkit-admin refuses embedded credentials in an agent url and a webhook url", async () => {
  await withTestDb(async (db, url) => {
    const a = run(url, ["agents", "register", "bot", "--url", "http://u:pw@127.0.0.1:9/a", "--rooms", "lab"]);
    assert.equal(a.code, 1);
    assert.match(a.err, /invalid_input: .*credentials/);
    assert.ok(!a.err.includes("pw@"));
    assert.equal((await db`select 1 from agents`).length, 0);
    const t = run(url, [
      "triggers", "add", "notify", "--room", "build/", "--kinds", "task.completed",
      "--webhook", "https://u:pw@example.com/h",
    ]);
    assert.equal(t.code, 1);
    assert.match(t.err, /invalid_input: .*credentials/);
    assert.equal((await db`select 1 from triggers`).length, 0);
  });
});

test("agents create takes --rooms before or after the name, and repeats it for more rooms", async () => {
  await withTestDb(async (db, url) => {
    const first = run(url, ["agents", "create", "--rooms", "build:read,post", "alpha"]);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /^alpha\ttk_/);
    const second = run(url, ["agents", "create", "beta", "--rooms", "build:read", "--rooms", "ops/:read,post"]);
    assert.equal(second.code, 0, second.err);
    const auth = await authenticate(db, second.out.split("\t")[1]!.trim());
    assert.equal(auth?.actor.name, "beta");
  });
});

test("people invite --email stores the email", async () => {
  await withTestDb(async (db, url) => {
    const r = run(url, ["people", "invite", "ben", "--email", "Ben@Example.com"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out.trim(), /^http:\/\/127\.0\.0\.1:3000\/signin\/sl_/);
    assert.equal((await db`select email from actors where name = 'ben'`)[0]!.email, "ben@example.com");
    const taken = run(url, ["people", "invite", "sam", "--email", "ben@example.com"]);
    assert.equal(taken.code, 1);
    assert.equal((await db`select count(*)::int as n from actors where name = 'sam'`)[0]!.n, 0);
  });
});

test("join-links create prints a join link; list and revoke", async () => {
  await withTestDb(async (db, url) => {
    const c = run(url, ["join-links", "create", "--days", "14", "--domain", "example.com"], undefined,
      { TEAMKIT_PUBLIC_URL: "https://teamkit.example.com" });
    assert.equal(c.code, 0, c.err);
    assert.match(c.out.trim(), /^https:\/\/teamkit\.example\.com\/join\/jc_[A-Za-z0-9_-]{43}$/);
    const secret = c.out.trim().split("/join/")[1]!;
    assert.equal((await redeemJoinLink(db, { code: secret, name: "ana", email: "ana@example.com" })).actor.name, "ana");
    const [id, uses, expires, domains, state] = run(url, ["join-links", "list"]).out.trim().split("\t");
    assert.match(id!, /^jl_/);
    assert.deepEqual([uses, domains, state], ["1", "example.com", "active"]);
    assert.ok(Date.parse(expires!) > Date.now());
    assert.equal(run(url, ["join-links", "revoke", id!]).code, 0);
    assert.equal(run(url, ["join-links", "list"]).out.trim().split("\t")[4], "revoked");
    assert.equal(run(url, ["join-links", "revoke", "jl_nope"]).code, 1);
    assert.equal(run(url, ["join-links", "create", "--days", "0"]).code, 1);
  });
});

test("rooms set --reservation-minutes stores the hold length", async () => {
  await withTestDb(async (db, url) => {
    const r = run(url, ["rooms", "set", "billing-prod", "--reservation-minutes", "45"]);
    assert.equal(r.code, 0, r.err);
    const info = await getRoomInfo(db, "billing-prod");
    assert.equal(info?.reservationMinutes, 45);
    assert.deepEqual(JSON.parse(r.out), info);
    const bad = run(url, ["rooms", "set", "billing-migration", "--reservation-minutes", "soon"]);
    assert.equal(bad.code, 1);
    assert.equal(await getRoomInfo(db, "billing-migration"), null);
  });
});
