import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, toError, TeamkitError } from "../src/client.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(body: unknown = {}, status = 200) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const header = (call: Call | undefined, name: string): string | undefined =>
  (call?.init.headers as Record<string, string> | undefined)?.[name];

test("no token: whoami hits /v1/whoami with no authorization header", async () => {
  const { calls, fetchFn } = fakeFetch({ kind: "person" });
  await createClient({ url: "", fetch: fetchFn }).whoami();
  assert.equal(calls[0]?.url, "/v1/whoami");
  assert.equal(header(calls[0], "authorization"), undefined);
});

test("empty token sends no authorization header", async () => {
  const { calls, fetchFn } = fakeFetch({});
  await createClient({ url: "", token: "", fetch: fetchFn }).whoami();
  assert.equal(header(calls[0], "authorization"), undefined);
});

test("a token sends a Bearer header", async () => {
  const { calls, fetchFn } = fakeFetch({});
  await createClient({ url: "", token: "tk_x", fetch: fetchFn }).whoami();
  assert.equal(header(calls[0], "authorization"), "Bearer tk_x");
});

test("createTask sends content-type application/json", async () => {
  const { calls, fetchFn } = fakeFetch({ task: { id: "t" } });
  await createClient({ url: "", fetch: fetchFn }).createTask({ room: "build", brief: "x" });
  assert.equal(header(calls[0], "content-type"), "application/json");
});

test("toError parses a server error body", async () => {
  const res = new Response(JSON.stringify({ error: { code: "forbidden", message: "m" } }), { status: 403 });
  const err = await toError(res);
  assert.ok(err instanceof TeamkitError);
  assert.equal(err.code, "forbidden");
  assert.equal(err.status, 403);
  assert.equal(err.message, "m");
});

test("toError of a non-JSON body is http_error", async () => {
  const err = await toError(new Response("oops", { status: 500 }));
  assert.equal(err.code, "http_error");
  assert.equal(err.status, 500);
});
