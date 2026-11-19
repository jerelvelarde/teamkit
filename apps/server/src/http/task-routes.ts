import { BLOCK_KINDS, BoardError, TASK_STATES, type BlockKind, type PlanItem, type TaskState } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";
import { labelsFromQuery, optLabels, optString, optStringArray, pathParam, readBody, reqString } from "./body.js";
import { answer, block } from "../store/blocks.js";
import { claimTask, complete, fail, release, renew } from "../store/claims.js";
import { listTasks } from "../store/task-list.js";
import { createPlan, createTask } from "../store/tasks.js";

export function registerTaskRoutes(v1: Hono<AppEnv>, deps: AppDeps): void {
  const { db } = deps;

  v1.get("/tasks", async (c) => {
    const state = c.req.query("state");
    if (state !== undefined && state !== "all" && !(TASK_STATES as readonly string[]).includes(state)) {
      throw new BoardError("invalid_input", `state must be one of ${TASK_STATES.join(", ")} or all`);
    }
    const tasks = await listTasks(db, c.get("auth"), {
      room: c.req.query("room"),
      state: state as TaskState | "all" | undefined,
      labels: labelsFromQuery(c.req.queries("label")),
    });
    return c.json({ tasks });
  });

  v1.post("/tasks", async (c) => {
    const b = await readBody(c);
    const auth = c.get("auth");
    if (b.plan !== undefined) {
      if (!Array.isArray(b.plan)) throw new BoardError("invalid_input", "plan must be an array");
      const tasks = await createPlan(db, auth, reqString(b, "room"), b.plan as PlanItem[]);
      return c.json({ tasks }, 201);
    }
    const task = await createTask(db, auth, {
      room: reqString(b, "room"),
      brief: reqString(b, "brief"),
      labels: optLabels(b, "labels"),
      needs: optStringArray(b, "needs"),
      target: optString(b, "target"),
    });
    return c.json({ task }, 201);
  });

  v1.post("/tasks/:id/claim", async (c) => c.json(await claimTask(db, c.get("auth"), pathParam(c, "id"))));

  v1.post("/tasks/:id/renew", async (c) => {
    const b = await readBody(c);
    return c.json(await renew(db, c.get("auth"), pathParam(c, "id"), reqString(b, "claimId")));
  });

  v1.post("/tasks/:id/release", async (c) => {
    const b = await readBody(c);
    return c.json({ task: await release(db, c.get("auth"), pathParam(c, "id"), reqString(b, "claimId")) });
  });

  v1.post("/tasks/:id/complete", async (c) => {
    const b = await readBody(c);
    const task = await complete(db, c.get("auth"), pathParam(c, "id"), reqString(b, "claimId"), optString(b, "result") ?? null);
    return c.json({ task });
  });

  v1.post("/tasks/:id/fail", async (c) => {
    const b = await readBody(c);
    const task = await fail(db, c.get("auth"), pathParam(c, "id"), reqString(b, "claimId"), reqString(b, "reason"));
    return c.json({ task });
  });

  v1.post("/tasks/:id/block", async (c) => {
    const b = await readBody(c);
    const kind = optString(b, "kind") ?? "needs_input";
    if (!(BLOCK_KINDS as readonly string[]).includes(kind)) {
      throw new BoardError("invalid_input", `kind must be one of ${BLOCK_KINDS.join(", ")}`);
    }
    const task = await block(db, c.get("auth"), pathParam(c, "id"), reqString(b, "claimId"), {
      question: reqString(b, "question"),
      kind: kind as BlockKind,
      options: optStringArray(b, "options"),
      approvers: optStringArray(b, "approvers"),
    });
    return c.json({ task });
  });

  v1.post("/tasks/:id/answer", async (c) => {
    const b = await readBody(c);
    const task = await answer(db, c.get("auth"), pathParam(c, "id"), {
      text: optString(b, "text"),
      choice: optString(b, "choice"),
    });
    return c.json({ task });
  });
}
