import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withTestDb } from "./helpers/db.js";
import { authenticate } from "../src/store/actors.js";
import { getRoomInfo } from "../src/store/rooms.js";
import { consumeSignInLink } from "../src/store/people.js";

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
      const r = run(url, ["agents", "create", "w", "--rooms", "*:read", spec]);
      assert.equal(r.code, 2, spec);
      assert.match(r.err, /no permissions/);
      assert.equal(r.out, "");
    }
    assert.equal((await db`select 1 from actors where name = 'w'`).length, 0);
    const ok = run(url, ["agents", "create", "w", "--rooms", "build:read,post", "ops/:read"]);
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

    assert.equal((await consumeSignInLink(db, secret)).role, "admin");
    // Re-inviting without --admin kept the existing role.
    const again = custom.out.trim().split("/signin/")[1]!;
    assert.equal((await consumeSignInLink(db, again)).role, "admin");
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
