import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppDeps } from "./app.js";
import type { AppEnv } from "./auth.js";
import { eventQueryFromRequest } from "./body.js";
import { currentCursor } from "../store/events.js";
import { readEvents, validateEventQuery } from "../store/feed.js";

const DRAIN_LIMIT = 500;
const DEFAULT_PING_MS = 15_000;

/**
 * GET /events/stream: server-sent events with GET /events' query.
 *
 * Start cursor: Last-Event-ID, else `after`, else the current head (a live tail
 * with no history; pass after=0 to replay everything). The stream subscribes to the
 * notifier BEFORE its first replay query, and every notification sets a dirty flag
 * that is cleared BEFORE each drain, so an event committed at any point after the
 * subscription is either read by the drain in progress or triggers another drain.
 * Nothing is missed and, because the cursor only advances past events written, nothing repeats.
 */
export function registerStream(v1: Hono<AppEnv>, deps: AppDeps, opts: { pingMs?: number } = {}): void {
  const pingMs = opts.pingMs ?? DEFAULT_PING_MS;

  v1.get("/events/stream", async (c) => {
    const auth = c.get("auth");
    const q = eventQueryFromRequest(c);
    const lastEventId = c.req.header("last-event-id");
    if (lastEventId !== undefined && lastEventId !== "") q.after = lastEventId;
    // Validate and check permissions before the stream starts, so errors are plain JSON.
    validateEventQuery(q);
    await readEvents(deps.db, auth, { ...q, after: q.after ?? "0", limit: 1 });

    return streamSSE(c, async (stream) => {
      let stopped = false;
      let wake: (() => void) | null = null;
      let dirty = true;
      let ping: NodeJS.Timeout | undefined;

      const notify = () => {
        dirty = true;
        wake?.();
      };
      // Subscribe before any replay query.
      const unsubscribe = deps.notifier.onEvent(notify);
      const stop = () => {
        if (stopped) return;
        stopped = true;
        unsubscribe();
        if (ping !== undefined) clearInterval(ping);
        wake?.();
      };
      stream.onAbort(stop);
      c.req.raw.signal.addEventListener("abort", stop, { once: true });

      try {
        let cursor = q.after ?? (await currentCursor(deps.db));

        ping = setInterval(() => {
          stream.write(": ping\n\n").catch(stop);
        }, pingMs);

        while (!stopped) {
          if (!dirty) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
            continue;
          }
          dirty = false;
          for (;;) {
            const page = await readEvents(deps.db, auth, { ...q, after: cursor, limit: DRAIN_LIMIT });
            for (const e of page.events) {
              if (stopped) return;
              await stream.writeSSE({ id: e.cursor, event: "board", data: JSON.stringify(e) });
            }
            if (page.cursor === cursor) break;
            cursor = page.cursor;
          }
        }
      } finally {
        stop();
      }
    });
  });
}
