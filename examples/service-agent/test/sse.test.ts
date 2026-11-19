import assert from "node:assert/strict";
import { test } from "node:test";
import { EventSchemas } from "@ag-ui/core/schemas";
import { Hono } from "hono";
import { createExampleApp } from "../src/app.js";
import { ev, readInput, sseResponse } from "../src/sse.js";

const i = { threadId: "t1", runId: "r1" };

test("ev builders produce schema-valid events", () => {
  const all = [
    ev.runStarted(i),
    ...ev.text("m1", "hello"),
    ev.success(i),
    ev.success(i, { ok: true }),
    ev.interrupt(i, {
      id: "int1",
      reason: "approval",
      message: "Approve?",
      responseSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    }),
    ...ev.toolCall("tc1", "board_comment", { text: "hi" }),
    ev.runError("boom", "failed"),
  ];
  for (const e of all) EventSchemas.parse(e);
  assert.equal("result" in ev.success(i), false);
  assert.deepEqual((ev.success(i, 1) as { result?: unknown }).result, 1);
});

test("sseResponse writes one data frame per event", async () => {
  const res = sseResponse([ev.runStarted(i), ev.success(i)]);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  const body = await res.text();
  const frames = body.split("\n\n").filter(Boolean);
  assert.equal(body.endsWith("\n\n"), true);
  assert.equal(frames.length, 2);
  for (const f of frames) assert.match(f, /^data: \{.*\}$/);
});

test("sseResponse streams from an emitter function", async () => {
  const res = sseResponse(async (emit) => {
    emit(ev.runStarted(i));
    emit(ev.success(i));
  });
  assert.equal((await res.text()).split("\n\n").filter(Boolean).length, 2);
});

test("readInput rejects a malformed body with 400", async () => {
  const app = new Hono();
  app.post("/", async (c) => {
    try {
      return c.json(await readInput(c));
    } catch (e) {
      if (e instanceof Response) return e;
      throw e;
    }
  });
  const bad = await app.request("/", { method: "POST", body: "{}" });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "bad RunAgentInput" });
  const ok = await app.request("/", {
    method: "POST",
    body: JSON.stringify({ ...i, messages: [] }),
  });
  assert.equal(ok.status, 200);
});

test("healthz reports ok and the mounted agents", async () => {
  const res = await createExampleApp({}).request("/healthz");
  const body = (await res.json()) as { ok: boolean; agents: string[] };
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.agents));
});
