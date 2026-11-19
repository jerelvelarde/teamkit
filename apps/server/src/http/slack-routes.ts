import { BoardError } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";
import { readBody, reqString } from "./body.js";
import { redeemSlackLinkCode } from "../slack/links.js";

export function registerSlackRoutes(v1: Hono<AppEnv>, deps: AppDeps): void {
  const { db } = deps;

  v1.post("/slack/link", async (c) => {
    const auth = c.get("auth");
    // A cookie authenticates this route, so a cross-site form post could link the victim's
    // account to an attacker's Slack user. Only a fetch that passed CORS can send JSON.
    // Token callers skip this check; redeemSlackLinkCode refuses them with 403.
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (auth.via === "session" && type !== "application/json") {
      throw new BoardError("invalid_input", "linking must send content-type: application/json");
    }
    const body = await readBody(c);
    return c.json(await redeemSlackLinkCode(db, auth, reqString(body, "code")));
  });
}
