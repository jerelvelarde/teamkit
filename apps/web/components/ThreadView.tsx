"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardEvent, ThreadView as ThreadData } from "@copilotkit/teamkit-protocol";
import { api } from "../lib/api";
import { foldEvents } from "../lib/fold";
import { cursorAfter, useBoardStream } from "../lib/stream";
import { AnswerForm } from "./AnswerForm";
import { EventRenderer } from "./EventRenderer";
import { ReplyBox } from "./ReplyBox";
import { SignedOut } from "./SignedOut";
import styles from "./thread.module.css";

const PAGE = 1000;

async function fetchEvents(thread: string, from: string): Promise<{ events: BoardEvent[]; cursor: string }> {
  const all: BoardEvent[] = [];
  let after = from;
  for (;;) {
    const page = await api.events({ thread, after, limit: PAGE });
    all.push(...page.events);
    if (page.cursor === after || page.events.length === 0) return { events: all, cursor: page.cursor };
    after = page.cursor;
  }
}

export function ThreadView({ id }: { id: string }) {
  const [data, setData] = useState<ThreadData | null>(null);
  const [events, setEvents] = useState<BoardEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const lastRef = useRef("0");

  const merge = useCallback((incoming: BoardEvent[]) => {
    const fresh = incoming.filter((e) => cursorAfter(e.cursor, lastRef.current === "0" ? undefined : lastRef.current));
    if (fresh.length === 0) return;
    lastRef.current = fresh[fresh.length - 1]!.cursor;
    setEvents((prev) => [...prev, ...fresh]);
  }, []);

  const refreshThread = useCallback(async () => {
    try {
      setData(await api.thread(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the thread.");
    }
  }, [id]);

  const refresh = useCallback(async () => {
    await refreshThread();
    try {
      merge((await fetchEvents(id, lastRef.current)).events);
    } catch {
      // the live stream will deliver anything missed
    }
  }, [id, merge, refreshThread]);

  useEffect(() => {
    let live = true;
    setData(null);
    setEvents([]);
    setError(null);
    setReady(false);
    lastRef.current = "0";
    (async () => {
      try {
        const [thread, log] = await Promise.all([api.thread(id), fetchEvents(id, "0")]);
        if (!live) return;
        setData(thread);
        lastRef.current = log.events.length ? log.events[log.events.length - 1]!.cursor : "0";
        setEvents(log.events);
        setReady(true);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : "Could not load the thread.");
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);

  const model = useMemo(() => foldEvents(events), [events]);

  // `after` is only where the stream starts; on every (re)open, refetch the thread and any
  // events past the last merged cursor, so nothing from a gap in the stream goes missing.
  const { signedOut } = useBoardStream(
    { thread: id, after: model.lastCursor },
    (e) => {
      merge([e]);
      if (e.kind.startsWith("task.")) void refreshThread();
    },
    { enabled: ready, onOpen: () => void refresh() },
  );

  if (signedOut) return <SignedOut hint="Your session ended. Open a new sign-in link to continue." />;

  if (error && !data) {
    return (
      <section className={`tk-glass ${styles.notice}`} role="alert">
        {error}
      </section>
    );
  }
  if (!data) return <section className={`tk-glass ${styles.notice}`}>Loading thread…</section>;

  const { task, thread } = data;
  const labels = Object.entries(thread.labels);
  const needs = task ? task.needs : [];

  return (
    <div className={styles.page}>
      <section className={`tk-glass ${styles.head}`}>
        <div className={styles.headTop}>
          <span className="tk-pill">{thread.room}</span>
          {task ? <span className={`${styles.statePill} ${styles[`state_${task.state}`] ?? ""}`}>{task.state}</span> : null}
        </div>
        {task ? <p className={styles.brief}>{task.brief}</p> : <p className={styles.muted}>Conversation thread</p>}
        <dl className={styles.meta}>
          {labels.length > 0 ? (
            <div>
              <dt>Labels</dt>
              <dd className={styles.chips}>
                {labels.map(([k, v]) => (
                  <span key={k} className="tk-pill">{`${k}=${v}`}</span>
                ))}
              </dd>
            </div>
          ) : null}
          {needs.length > 0 && task ? (
            <div>
              <dt>Needs</dt>
              <dd className={styles.chips}>
                {needs.map((n) => (
                  <a key={n} href={`/t/${encodeURIComponent(n)}`} className={`tk-pill ${styles.needLink}`}>
                    {`${n} · ${task.needStates[n] ?? "unknown"}`}
                  </a>
                ))}
              </dd>
            </div>
          ) : null}
          {task?.claim ? (
            <div>
              <dt>Claimed by</dt>
              <dd>{task.claim.actor.name}</dd>
            </div>
          ) : null}
        </dl>
        {task?.state === "completed" && task.result ? (
          <div className={styles.result}>
            <div className={styles.label}>Result</div>
            <div className={styles.text}>{task.result}</div>
          </div>
        ) : null}
      </section>

      <section className={styles.timeline} aria-label="Events" aria-live="polite">
        {model.items.length === 0 ? <p className={styles.muted}>No events yet.</p> : null}
        {model.items.map((item) => (
          <EventRenderer key={item.id} item={item} />
        ))}
      </section>

      {task?.state === "blocked" ? <AnswerForm key={task.block?.interruptId} task={task} onAnswered={refresh} /> : null}
      <ReplyBox threadId={id} onSent={refresh} />
    </div>
  );
}
