import { Hono } from "hono";
import { approverHandler } from "./approver.js";
import { researcherHandler } from "./researcher.js";

/** Names of the agents mounted on this server; later tasks push into it. */
export const agents: string[] = [];

export function createExampleApp(env: NodeJS.ProcessEnv = process.env): Hono {
  const app = new Hono();
  if (!agents.includes("approver")) agents.push("approver");
  app.post("/approver", approverHandler);
  if (env.OPENAI_API_KEY) {
    if (!agents.includes("researcher")) agents.push("researcher");
    app.post("/researcher", researcherHandler(env));
  }
  app.get("/healthz", (c) => c.json({ ok: true, agents }));
  return app;
}
