import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppDeps } from "./app.js";
import { credentialsOf, credentialsValid, type AppEnv } from "./auth.js";
import { eventQueryFromRequest } from "./body.js";
import { currentCursor } from "../store/events.js";
import { readEvents, validateEventQuery } from "../store/feed.js";

const DRAIN_LIMIT = 500;
const DEFAULT_PING_MS = 15_000;
const DEFAULT_MAX_MS = 30 * 60_000;

/**
 * GET /events/stream: server-sent events with GET /events' query.
 *
 * Start cursor: Last-Event-ID, else `after`, else the current head (a live tail
 * with no history; pass after=0 to replay everything). The stream subscribes to the
 * notifier BEFORE its first replay query, and every notification sets a dirty flag
 * that is cleared BEFORE each drain, so an event committed at any point after the
 * subscription is either read by the drain in progress or triggers another drain.
 * Nothing is missed and, because the cursor only advances past events written, nothing repeats.
 * A live tail first writes an id-only frame holding its start cursor, so a client
 * that reconnects before any event arrives resumes from there, not from a newer head.
 *
 * Each ping re-checks the bearer token or session cookie the stream opened with and
 * ends the stream once it no longer authenticates (revoked, or a session that
 * expired). Every stream also ends after `maxMs`; the client then
 * reconnects with Last-Event-ID and is authenticated afresh.
 */
export function registerStream(
  v1: Hono<AppEnv>,
  deps: AppDeps,
  opts: { pingMs?: number; maxMs?: number } = {},
): void {
  const pingMs = opts.pingMs ?? DEFAULT_PING_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;

  v1.get("/events/stream", async (c) => {
    const auth = c.get("auth");
    const creds = credentialsOf(c);
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
      let lifetime: NodeJS.Timeout | undefined;

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
        clearInterval(ping);
        clearTimeout(lifetime);
        wake?.();
      };
      stream.onAbort(stop);
      c.req.raw.signal.addEventListener("abort", stop, { once: true });
      lifetime = setTimeout(stop, maxMs);

      let checking = false;
      const heartbeat = async () => {
        if (checking) return;
        checking = true;
        try {
          // Hash and look the credential up again: a revoked token or session loses its stream here.
          if (!(await credentialsValid(deps.db, creds))) return stop();
          await stream.write(": ping\n\n");
        } catch {
          stop();
        } finally {
          checking = false;
        }
      };
      ping = setInterval(() => void heartbeat(), pingMs);

      try {
        let cursor = q.after;
        if (cursor === undefined) {
          cursor = await currentCursor(deps.db);
          await stream.write(`id: ${cursor}\n\n`);
        }

        while (!stopped) {
          if (!dirty) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
            continue;
          }
          dirty = false;
          while (!stopped) {
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
