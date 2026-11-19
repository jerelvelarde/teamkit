import { Hono } from "hono";
import { approverHandler } from "./approver.js";

/** Names of the agents mounted on this server; later tasks push into it. */
export const agents: string[] = [];

export function createExampleApp(_env: NodeJS.ProcessEnv = process.env): Hono {
  const app = new Hono();
  if (!agents.includes("approver")) agents.push("approver");
  app.post("/approver", approverHandler);
  app.get("/healthz", (c) => c.json({ ok: true, agents }));
  return app;
}
