import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withTestDb } from "./helpers/db.js";
import { authenticate } from "../src/store/actors.js";
import { getRoomInfo } from "../src/store/rooms.js";

const CWD = fileURLToPath(new URL("..", import.meta.url));

function run(url: string, args: string[], entry: string[] = ["--import", "tsx", "src/admin.ts"]) {
  const r = spawnSync(process.execPath, [...entry, ...args], {
    cwd: CWD,
    env: { ...process.env, DATABASE_URL: url },
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
