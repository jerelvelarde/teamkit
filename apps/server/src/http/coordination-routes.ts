import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";
import { BoardError, type ChangeStatus } from "@copilotkit/teamkit-protocol";
import { limitQuery, optString, optStringArray, pathParam, readBody, roomQuery } from "./body.js";
import { ackDecision, listDecisions, postDecision } from "../store/decisions.js";
import { answerRollCall, listRollCalls, startRollCall } from "../store/rollcalls.js";
import { heartbeat, listPresence } from "../store/presence.js";
import { listChanges, logChange, updateChange } from "../store/changes.js";
import { confirmAlert, listAlerts, raiseAlert, resolveAlert } from "../store/alerts.js";

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

  v1.post("/presence", async (c) => {
    const b = await readBody(c);
    const watching = optStringArray(b, "watching");
    if (watching === undefined) throw new BoardError("invalid_input", "watching is required");
    await heartbeat(db, c.get("auth"), { watching, status: optString(b, "status") });
    return c.json({ ok: true });
  });

  v1.get("/presence", async (c) => {
    return c.json({ presence: await listPresence(db, c.get("auth"), roomQuery(c)) });
  });

  v1.post("/changes", async (c) => {
    const b = await readBody(c);
    const change = await logChange(db, c.get("auth"), {
      room: b.room as string,
      threadId: optString(b, "threadId"),
      what: b.what as string,
      where: b.where as string,
      at: optString(b, "at"),
      undo: b.undo as string,
      undoWhen: optString(b, "undoWhen"),
    });
    return c.json({ change }, 201);
  });

  v1.post("/changes/:id", async (c) => {
    const b = await readBody(c);
    return c.json({ change: await updateChange(db, c.get("auth"), pathParam(c, "id"), b.status as ChangeStatus) });
  });

  v1.get("/changes", async (c) => {
    const status = c.req.query("status");
    const changes = await listChanges(db, c.get("auth"), roomQuery(c), {
      ...(status === undefined || status === "" ? {} : { status: status as ChangeStatus }),
      limit: limitQuery(c),
    });
    return c.json({ changes });
  });

  v1.post("/alerts", async (c) => {
    const b = await readBody(c);
    return c.json({ alert: await raiseAlert(db, c.get("auth"), { room: b.room as string, text: b.text as string }) }, 201);
  });

  v1.post("/alerts/:id/confirm", async (c) => {
    const b = await readBody(c);
    return c.json({ alert: await confirmAlert(db, c.get("auth"), pathParam(c, "id"), { source: optString(b, "source") }) });
  });

  v1.post("/alerts/:id/resolve", async (c) => {
    const b = await readBody(c);
    return c.json({ alert: await resolveAlert(db, c.get("auth"), pathParam(c, "id"), { source: optString(b, "source") }) });
  });

  v1.get("/alerts", async (c) => {
    const open = c.req.query("open");
    if (open !== undefined && open !== "true" && open !== "false") {
      throw new BoardError("invalid_input", "open must be true or false");
    }
    const alerts = await listAlerts(db, c.get("auth"), roomQuery(c), { open: open === "true", limit: limitQuery(c) });
    return c.json({ alerts });
  });
}
