import { BoardError, CLAIM_NEXT_MAX_WAIT_MS } from "@copilotkit/teamkit-protocol";
import type { Hono } from "hono";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";
import { optLabels, readBody, reqString } from "./body.js";
import { claimNext } from "../store/claims.js";

function optWaitMs(b: Record<string, unknown>): number {
  const v = b.waitMs;
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new BoardError("invalid_input", "waitMs must be a number >= 0");
  }
  return v;
}

export function registerClaimNext(v1: Hono<AppEnv>, deps: AppDeps): void {
  v1.post("/tasks/claim-next", async (c) => {
    const b = await readBody(c);
    const room = reqString(b, "room");
    const labels = optLabels(b, "labels");
    const waitMs = optWaitMs(b);
    const auth = c.get("auth");
    const signal = c.req.raw.signal;
    const deadline = Date.now() + Math.min(waitMs, CLAIM_NEXT_MAX_WAIT_MS);

    // Subscribe before the first claimNext so an event between the attempt and the wait is not lost.
    let dirty = false;
    let wake: (() => void) | undefined;
    const poke = () => {
      dirty = true;
      wake?.();
    };
    const unsubscribe = deps.notifier.onEvent(poke);
    signal.addEventListener("abort", poke);
    let timer: NodeJS.Timeout | undefined;
    try {
      for (;;) {
        if (signal.aborted) return c.body(null, 204);
        dirty = false;
        const claim = await claimNext(deps.db, auth, { room, ...(labels ? { labels } : {}) });
        if (claim) return c.json(claim, 200);
        const left = deadline - Date.now();
        if (left <= 0 || signal.aborted) return c.body(null, 204);
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, left);
          });
          clearTimeout(timer);
          wake = undefined;
        }
      }
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", poke);
      clearTimeout(timer);
    }
  });
}
