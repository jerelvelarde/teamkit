import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";
import { limitQuery, optString, pathParam, readBody, roomQuery } from "./body.js";
import { ackDecision, listDecisions, postDecision } from "../store/decisions.js";

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
}
