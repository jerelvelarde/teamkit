import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { ERROR_STATUS, errorBody, isBoardError } from "@copilotkit/teamkit-protocol";
import {
  eventQueryFromRequest,
  labelsFromQuery,
  optLabels,
  optString,
  optStringArray,
  readBody,
  reqString,
} from "../src/http/body.js";

const app = new Hono();
app.onError((e, c) => {
  if (isBoardError(e)) return c.json(errorBody(e), ERROR_STATUS[e.code]);
  throw e;
});
app.post("/body", async (c) => c.json(await readBody(c)));
app.post("/req", async (c) => c.json({ v: reqString(await readBody(c), "k") }));
app.post("/opt", async (c) => c.json({ v: optString(await readBody(c), "k") ?? null }));
app.post("/arr", async (c) => c.json({ v: optStringArray(await readBody(c), "k") ?? null }));
app.post("/labels", async (c) => c.json({ v: optLabels(await readBody(c), "k") ?? null }));
app.get("/lq", (c) => c.json({ v: labelsFromQuery(c.req.queries("label")) ?? null }));
app.get("/events", (c) => c.json(eventQueryFromRequest(c)));

const post = (path: string, body?: string) =>
  app.request(path, { method: "POST", body, headers: { "content-type": "application/json" } });

async function expectInvalid(res: Response): Promise<void> {
  assert.equal(res.status, 400);
  const j = (await res.json()) as { error: { code: string; message: string } };
  assert.equal(j.error.code, "invalid_input");
  assert.ok(j.error.message.length > 0);
}

test("readBody: empty body is {}, bad JSON and non-objects are invalid_input", async () => {
  const empty = await post("/body");
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), {});
  assert.deepEqual(await (await post("/body", '{"a":1}')).json(), { a: 1 });
  await expectInvalid(await post("/body", "{nope"));
  await expectInvalid(await post("/body", "[1]"));
  await expectInvalid(await post("/body", '"s"'));
  await expectInvalid(await post("/body", "null"));
});

test("reqString, optString, optStringArray, optLabels validate types", async () => {
  await expectInvalid(await post("/req", "{}"));
  assert.deepEqual(await (await post("/req", '{"k":"x"}')).json(), { v: "x" });
  await expectInvalid(await post("/opt", '{"k":5}'));
  assert.deepEqual(await (await post("/opt", "{}")).json(), { v: null });
  await expectInvalid(await post("/arr", '{"k":[1]}'));
  assert.deepEqual(await (await post("/arr", '{"k":["a"]}')).json(), { v: ["a"] });
  await expectInvalid(await post("/labels", '{"k":{"a":1}}'));
  await expectInvalid(await post("/labels", '{"k":["a"]}'));
  assert.deepEqual(await (await post("/labels", '{"k":{"a":"b"}}')).json(), { v: { a: "b" } });
});

test("labelsFromQuery splits at the first =", async () => {
  const ok = await app.request("/lq?label=a=b&label=c=d=e");
  assert.deepEqual(await ok.json(), { v: { a: "b", c: "d=e" } });
  await expectInvalid(await app.request("/lq?label=bad"));
  await expectInvalid(await app.request("/lq?label==x"));
});

test("eventQueryFromRequest reads after, room, thread, kinds and limit", async () => {
  const res = await app.request("/events?kind=task.created&kind=task.ready&after=5&limit=10&room=build/");
  assert.deepEqual(await res.json(), {
    after: "5",
    room: "build/",
    kinds: ["task.created", "task.ready"],
    limit: 10,
  });
  await expectInvalid(await app.request("/events?limit=abc"));
});
