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

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

/** How long to wait before reopening after `failures` failed opens in a row: 2 s, 4 s, 8 s, ... up to 60 s. */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, failures - 1));
}

/** Where a stream (re)opens: after the later of the last delivered event and the caller's starting cursor. */
export function resumeCursor(delivered: string | undefined, start: string | undefined): string | undefined {
  if (delivered === undefined) return start;
  if (start === undefined) return delivered;
  return cursorAfter(start, delivered) ? start : delivered;
}

/**
 * What a stream that failed to open does next, from the status of GET /v1/whoami
 * (null when that request failed too). A 401 or 403 means the session is gone and
 * retrying cannot help; anything else, such as a 502 while the server restarts, retries.
 */
export function afterFailure(whoamiStatus: number | null): "signed_out" | "retry" {
  return whoamiStatus === 401 || whoamiStatus === 403 ? "signed_out" : "retry";
}

async function whoamiStatus(): Promise<number | null> {
  try {
    return (await fetch("/v1/whoami", { cache: "no-store" })).status;
  } catch {
    return null;
  }
}

export interface BoardStreamOptions {
  enabled?: boolean;
  /**
   * Called every time the stream opens, including each reopen. A stream reopened after a
   * failure resumes from the last cursor it knew, but a live tail that had delivered nothing
   * yet knows none, so callers refetch here to pick up anything that happened while it was down.
   */
  onOpen?: () => void;
}

/**
 * Live board events over EventSource.
 *
 * The server ends a stream after 30 minutes, and EventSource reconnects on its own with
 * Last-Event-ID, which the server prefers over `after`. Delivery is at-least-once from the
 * client's point of view, so each event is dropped unless its cursor is above the last one
 * delivered. A non-200 reply closes an EventSource for good; the hook then checks the session,
 * stops if it is signed out, and otherwise reopens after a backoff from the later of the last
 * delivered cursor and `q.after`. `q.after` is only a starting point: changing it does not
 * reopen the stream.
 */
export function useBoardStream(
  q: StreamQuery,
  onEvent: (e: BoardEvent) => void,
  opts: BoardStreamOptions = {},
): { connected: boolean; signedOut: boolean } {
  const enabled = opts.enabled ?? true;
  const key = streamUrl({ ...q, after: undefined });
  const [connected, setConnected] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onOpenRef = useRef(opts.onOpen);
  onOpenRef.current = opts.onOpen;
  const queryRef = useRef(q);
  queryRef.current = q;

  useEffect(() => {
    if (!enabled) {
      setConnected(false);
      return;
    }
    setSignedOut(false);
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let lastCursor: string | undefined;
    let failures = 0;

    const open = () => {
      const q = queryRef.current;
      const es = new EventSource(streamUrl({ ...q, after: resumeCursor(lastCursor, q.after) }));
      source = es;
      es.onopen = () => {
        failures = 0;
        setConnected(true);
        onOpenRef.current?.();
      };
      es.onerror = () => {
        setConnected(false);
        // CONNECTING means the browser is retrying by itself; only CLOSED needs the hook.
        if (es.readyState !== EventSource.CLOSED || closed) return;
        failures += 1;
        void whoamiStatus().then((status) => {
          if (closed) return;
          if (afterFailure(status) === "signed_out") {
            setSignedOut(true);
            return;
          }
          retry = setTimeout(open, retryDelayMs(failures));
        });
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
    // `key` encodes every field of q except `after`, which is read through queryRef at each open.
  }, [key, enabled]);

  return { connected, signedOut };
}
