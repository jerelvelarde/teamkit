"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { BoardEvent, Task } from "@copilotkit/teamkit-protocol";
import { api } from "../lib/api";
import { foldEvents } from "../lib/fold";
import { LOG_KINDS, buildLog, keepRecent, sameAuthor } from "../lib/log";
import { cursorAfter, useBoardStream } from "../lib/stream";
import { EventRenderer } from "./EventRenderer";
import { IconHash, StatusIcon } from "./Icons";
import { firstLine } from "./TaskCard";
import styles from "./log.module.css";

const PAGE = 1000;
const NEAR_BOTTOM_PX = 120;
const TITLE_MAX = 90;

/**
 * One running log of everything in a room (or across all rooms), laid out like a channel:
 * newest at the bottom, live, each run of events under the task it belongs to.
 */
export function RoomLog({ room, tasks, query }: { room: string | null; tasks: Task[] | null; query: string }) {
  const [events, setEvents] = useState<BoardEvent[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRef = useRef("0");
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** Where the log last put itself at the bottom; a scroll only counts as the reader's if it moves up from here. */
  const pinnedAt = useRef<number | null>(null);
  const streamRoom = room ?? undefined;

  /** Every log event after `from`, holding only the most recent LOG_LIMIT while paging. */
  const fetchFrom = useCallback(
    async (from: string): Promise<BoardEvent[]> => {
      let all: BoardEvent[] = [];
      let after = from;
      for (;;) {
        const page = await api.events({ room: streamRoom, kinds: LOG_KINDS, after, limit: PAGE });
        all = keepRecent([...all, ...page.events]);
        if (page.cursor === after || page.events.length === 0) return all;
        after = page.cursor;
      }
    },
    [streamRoom],
  );

  const merge = useCallback((incoming: BoardEvent[]) => {
    const fresh = incoming.filter((e) => cursorAfter(e.cursor, lastRef.current === "0" ? undefined : lastRef.current));
    if (fresh.length === 0) return;
    lastRef.current = fresh[fresh.length - 1]!.cursor;
    setEvents((prev) => keepRecent([...prev, ...fresh]));
  }, []);

  useEffect(() => {
    let live = true;
    setEvents([]);
    setReady(false);
    setError(null);
    lastRef.current = "0";
    stick.current = true;
    pinnedAt.current = null;
    fetchFrom("0").then(
      (log) => {
        if (!live) return;
        lastRef.current = log.length ? log[log.length - 1]!.cursor : "0";
        setEvents(log);
        setReady(true);
      },
      (err: unknown) => live && setError(err instanceof Error ? err.message : "Could not load the log."),
    );
    return () => {
      live = false;
    };
  }, [fetchFrom]);

  // On every (re)open, fetch anything past the last merged cursor, so a gap in the stream loses nothing.
  useBoardStream(
    { room: streamRoom, kinds: LOG_KINDS, after: lastRef.current },
    (e) => merge([e]),
    {
      enabled: ready,
      onOpen: () => {
        fetchFrom(lastRef.current).then(merge, () => {});
      },
    },
  );

  const rows = useMemo(() => {
    const byCursor = new Map(events.map((e) => [e.cursor, e]));
    return buildLog(foldEvents(events).items, byCursor, new Date());
  }, [events]);
  const taskById = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);

  // Open at the newest entry and follow new ones while the reader is at the bottom, as a chat does.
  const pin = useCallback(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
    pinnedAt.current = el.scrollTop;
  }, []);
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // Our own scroll lands a frame later, when the content may have grown; it is not the reader leaving.
    if (pinnedAt.current !== null && el.scrollTop >= pinnedAt.current - 2) return;
    pinnedAt.current = null;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);
  useLayoutEffect(pin, [rows, pin]);
  // Stay at the bottom when the content grows after it renders (the web font loads, a line wraps)
  // or the log itself gets shorter (an alert banner appears above it).
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(pin);
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pin]);

  return (
    <div className={styles.scroll} ref={scroller} onScroll={onScroll}>
      <div ref={content} className={styles.log} role="log" aria-label={room ? `Log for ${room}` : "Log for all rooms"}>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {!ready && !error ? (
          <>
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
            <div className={styles.skeleton} />
          </>
        ) : null}
        {ready && rows.length === 0 ? (
          <p className={styles.empty}>
            Nothing has happened {room ? "in this room" : "on the board"} yet. New tasks, claims, answers,
            decisions, changes and alerts appear here as they happen.
          </p>
        ) : null}
        {rows.map((row) =>
          row.kind === "day" ? (
            <div key={row.key} className={styles.day} role="separator">
              <span className={styles.dayLabel}>{row.label}</span>
            </div>
          ) : (
            <section key={row.key} className={styles.group}>
              <GroupHead
                threadId={row.threadId}
                room={row.room}
                topic={row.topic}
                task={row.threadId ? taskById.get(row.threadId) : undefined}
                showRoom={!room}
                query={query}
              />
              {row.items.map((li, i) => (
                <EventRenderer
                  key={li.item.id}
                  item={li.item}
                  at={li.at ?? undefined}
                  grouped={sameAuthor(row.items[i - 1]?.item, li.item)}
                />
              ))}
            </section>
          ),
        )}
      </div>
    </div>
  );
}

/** What a run of log entries is about: its task, as a link that opens the task's panel. */
function GroupHead({
  threadId,
  room,
  topic,
  task,
  showRoom,
  query,
}: {
  threadId: string | null;
  room: string;
  topic: string;
  task: Task | undefined;
  showRoom: boolean;
  query: string;
}) {
  const roomChip = showRoom || !threadId ? (
    <span className={styles.room}>
      <IconHash size={11} />
      {room}
    </span>
  ) : null;
  if (!threadId) return <div className={styles.head}>{roomChip}</div>;
  return (
    <div className={styles.head}>
      <Link href={`/t/${encodeURIComponent(threadId)}${query}`} scroll={false} className={styles.headLink}>
        {task ? <StatusIcon state={task.state} size={12} /> : null}
        <span className={styles.headTitle}>{task ? firstLine(task.brief, TITLE_MAX) : topic}</span>
      </Link>
      {roomChip}
    </div>
  );
}
