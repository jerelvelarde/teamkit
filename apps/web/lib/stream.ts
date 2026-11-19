"use client";

import { useEffect, useRef, useState } from "react";
import type { BoardEvent } from "@copilotkit/teamkit-protocol";

export interface StreamQuery {
  room?: string;
  thread?: string;
  kinds?: string[];
  after?: string;
}

/** Same-origin stream URL. Parameter order is fixed: room, thread, after, then each kind. */
export function streamUrl(q: StreamQuery): string {
  const p = new URLSearchParams();
  if (q.room) p.set("room", q.room);
  if (q.thread) p.set("thread", q.thread);
  if (q.after) p.set("after", q.after);
  for (const k of q.kinds ?? []) p.append("kind", k);
  const s = p.toString();
  return s ? `/v1/events/stream?${s}` : "/v1/events/stream";
}

/** Cursors are decimal text from a sequence; compare as integers, not strings. */
export function cursorAfter(cursor: string, seen: string | undefined): boolean {
  if (seen === undefined) return true;
  if (!/^\d+$/.test(cursor) || !/^\d+$/.test(seen)) return cursor !== seen;
  return BigInt(cursor) > BigInt(seen);
}

const RETRY_MS = 2_000;

/**
 * Live board events over EventSource.
 *
 * The server ends a stream after 30 minutes, and EventSource reconnects on its own with
 * Last-Event-ID, which the server prefers over `after`. Delivery is at-least-once from the
 * client's point of view, so each event is dropped unless its cursor is above the last one
 * delivered; the same cursor is the resume point if the browser gives up and the hook has
 * to reopen the stream itself (a non-200 reply closes an EventSource for good).
 */
export function useBoardStream(
  q: StreamQuery,
  onEvent: (e: BoardEvent) => void,
  opts: { enabled?: boolean } = {},
): { connected: boolean } {
  const enabled = opts.enabled ?? true;
  const url = streamUrl(q);
  const [connected, setConnected] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let lastCursor: string | undefined;

    const open = () => {
      // Resume from the last delivered cursor when reopening by hand.
      const href = lastCursor === undefined ? url : streamUrl({ ...q, after: lastCursor });
      const es = new EventSource(href);
      source = es;
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        if (es.readyState === EventSource.CLOSED && !closed) {
          retry = setTimeout(open, RETRY_MS);
        }
      };
      es.addEventListener("board", (msg) => {
        let event: BoardEvent;
        try {
          event = JSON.parse((msg as MessageEvent<string>).data) as BoardEvent;
        } catch {
          return;
        }
        if (!cursorAfter(event.cursor, lastCursor)) return;
        lastCursor = event.cursor;
        onEventRef.current(event);
      });
    };

    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
      setConnected(false);
    };
    // `url` encodes every field of q.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, enabled]);

  return { connected };
}
