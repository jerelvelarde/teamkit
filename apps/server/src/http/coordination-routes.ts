import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";
import { limitQuery, optString, pathParam, readBody, roomQuery } from "./body.js";
import { ackDecision, listDecisions, postDecision } from "../store/decisions.js";
import { answerRollCall, listRollCalls, startRollCall } from "../store/rollcalls.js";

/** Decisions, roll calls, presence, the change log, alerts and what is waiting on the caller. */
export function registerCoordinationRoutes(v1: Hono<AppEnv>, deps: AppDeps): void {
  const { db } = deps;

  v1.post("/decisions", async (c) => {
    const b = await readBody(c);
    const decision = await postDecision(db, c.get("auth"), {
      room: b.room as string,
      text: b.text as string,
      decidedBy: optString(b, "decidedBy"),
    });
    return c.json({ decision }, 201);
  });

  v1.post("/decisions/:id/ack", async (c) => {
    return c.json({ decision: await ackDecision(db, c.get("auth"), pathParam(c, "id")) });
  });

  v1.get("/decisions", async (c) => {
    return c.json({ decisions: await listDecisions(db, c.get("auth"), roomQuery(c), { limit: limitQuery(c) }) });
  });

  v1.post("/rollcalls", async (c) => {
    const b = await readBody(c);
    return c.json({ rollCall: await startRollCall(db, c.get("auth"), b.room as string) }, 201);
  });

  v1.post("/rollcalls/:id/answer", async (c) => {
    const b = await readBody(c);
    return c.json({ rollCall: await answerRollCall(db, c.get("auth"), pathParam(c, "id"), b.status as string) });
  });

  v1.get("/rollcalls", async (c) => {
    return c.json({ rollCalls: await listRollCalls(db, c.get("auth"), roomQuery(c), { limit: limitQuery(c) }) });
  });
}
