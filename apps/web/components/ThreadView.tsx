"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { BoardEvent, ThreadView as ThreadData } from "@copilotkit/teamkit-protocol";
import { api } from "../lib/api";
import { parseTab, reservationLeft, roomQuery } from "../lib/coord";
import { foldEvents } from "../lib/fold";
import type { ViewItem } from "../lib/fold";
import { cursorAfter, useBoardStream } from "../lib/stream";
import { AnswerForm } from "./AnswerForm";
import { Avatar } from "./Avatar";
import { EventRenderer } from "./EventRenderer";
import { IconHash, IconLink, IconX, STATE_LABEL, StatusIcon } from "./Icons";
import { ReplyBox } from "./ReplyBox";
import { SignedOut } from "./SignedOut";
import { firstLine, leaseText } from "./TaskCard";
import styles from "./thread.module.css";

const PAGE = 1000;
const NEAR_BOTTOM_PX = 120;
/** The server posts a block's question as a plain message too; the question card already shows it. */
const QUESTION_TEXT = /^Question \((needs_input|awaiting_approval)\): /;

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

function sameAuthor(a: ViewItem | undefined, b: ViewItem): boolean {
  return (
    a?.kind === "message" &&
    b.kind === "message" &&
    a.role === b.role &&
    a.actor?.name === b.actor?.name &&
    a.actor?.kind === b.actor?.kind
  );
}

/** The task's thread in a side panel over the board, laid out like a Slack thread. */
export function ThreadView({ id }: { id: string }) {
  const [data, setData] = useState<ThreadData | null>(null);
  const [events, setEvents] = useState<BoardEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const lastRef = useRef("0");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(false);
  const router = useRouter();
  const params = useSearchParams();
  const query = roomQuery(params.get("room"), parseTab(params.get("view")));
  const closeHref = `/${query}`;

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
  const times = useMemo(() => new Map(events.map((e) => [e.cursor, e.createdAt])), [events]);
  const blocked = data?.task?.state === "blocked";

  // Ask once: drop the server's plain-text copy of each question, and while the question card
  // is open, the "Waiting" line for the same question.
  const items = useMemo(() => {
    const list = model.items.filter((i) => !(i.kind === "message" && QUESTION_TEXT.test(i.text)));
    if (!blocked) return list;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i]!;
      if (it.kind === "status" && it.label.startsWith("Waiting")) return [...list.slice(0, i), ...list.slice(i + 1)];
    }
    return list;
  }, [model.items, blocked]);

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

  // Follow new activity the way a chat does: only when the reader is already at the bottom.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  // Escape closes the panel unless the visitor is typing or a dialog is open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("dialog[open]")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) {
        t.blur();
        return;
      }
      router.push(closeHref, { scroll: false });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, closeHref]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/t/${encodeURIComponent(id)}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked; the address bar still has the link
    }
  }

  if (signedOut) return <SignedOut hint="Your session ended. Open a new sign-in link to continue." />;

  const task = data?.task ?? null;
  const thread = data?.thread ?? null;
  const labels = thread ? Object.entries(thread.labels) : [];
  const needs = task ? task.needs : [];
  const briefLines = task ? task.brief.trim().split("\n") : [];
  const title = task ? firstLine(task.brief, 400) : (model.headline ?? "Conversation thread");
  const held = task ? reservationLeft(task, Date.now()) : null;
  const description = briefLines.length > 1 ? briefLines.slice(1).join("\n").trim() : "";

  return (
    <aside className={styles.panel} aria-label="Task">
      <div className={styles.bar}>
        {task ? (
          <span className={styles.state} data-task-state={task.state}>
            <StatusIcon state={task.state} />
            {STATE_LABEL[task.state]}
          </span>
        ) : null}
        {thread ? (
          <span className={styles.room}>
            <IconHash size={13} />
            {thread.room}
          </span>
        ) : null}
        <span className={styles.barSpacer} />
        <button
          type="button"
          className="tk-button tk-button-ghost tk-icon-button"
          onClick={copyLink}
          aria-label={copied ? "Link copied" : "Copy link"}
          title={copied ? "Link copied" : "Copy link"}
        >
          <IconLink />
        </button>
        <Link
          href={closeHref}
          scroll={false}
          className="tk-button tk-button-ghost tk-icon-button"
          aria-label="Close"
          title="Close (Esc)"
        >
          <IconX />
        </Link>
      </div>

      {!data ? (
        <div className={styles.notice} role={error ? "alert" : "status"}>
          {error ?? "Loading thread…"}
        </div>
      ) : (
        <>
          <div className={styles.scroll} ref={scroller} onScroll={onScroll}>
            <div className={styles.details}>
              <h2 className={styles.title}>{title}</h2>
              {description ? <p className={styles.description}>{description}</p> : null}

              <dl className={styles.props}>
                {task?.claim ? (
                  <div className={styles.prop}>
                    <dt>Claimed by</dt>
                    <dd>
                      <Avatar name={task.claim.actor.name} kind={task.claim.actor.kind} size={18} />
                      {task.claim.actor.name}
                      <span className={styles.propMuted}>· {leaseText(task.claim.leaseExpiresAt, Date.now())}</span>
                    </dd>
                  </div>
                ) : null}
                {held && task?.reservedFor ? (
                  <div className={styles.prop}>
                    <dt>Held for</dt>
                    <dd>
                      <Avatar name={task.reservedFor.name} kind={task.reservedFor.kind} size={18} />
                      {task.reservedFor.name}
                      <span className={styles.propMuted}>· {held} left</span>
                    </dd>
                  </div>
                ) : null}
                {task?.state === "blocked" && task.block && !task.claim ? (
                  <div className={styles.prop}>
                    <dt>Asked by</dt>
                    <dd>
                      <Avatar name={task.block.blockedBy.name} kind={task.block.blockedBy.kind} size={18} />
                      {task.block.blockedBy.name}
                    </dd>
                  </div>
                ) : null}
                {labels.length > 0 ? (
                  <div className={styles.prop}>
                    <dt>Labels</dt>
                    <dd className={styles.chips}>
                      {labels.map(([k, v]) => (
                        <span key={k} className="tk-pill">{`${k}: ${v}`}</span>
                      ))}
                    </dd>
                  </div>
                ) : null}
                {needs.length > 0 && task ? (
                  <div className={styles.prop}>
                    <dt>Needs</dt>
                    <dd className={styles.chips}>
                      {needs.map((n) => {
                        const st = task.needStates[n];
                        return (
                          <Link
                            key={n}
                            href={`/t/${encodeURIComponent(n)}${query}`}
                            scroll={false}
                            className={`tk-pill ${styles.needLink}`}
                          >
                            {st ? <StatusIcon state={st} size={12} /> : null}
                            {`Task ${n.slice(-6)}`}
                          </Link>
                        );
                      })}
                    </dd>
                  </div>
                ) : null}
                {thread ? (
                  <div className={styles.prop}>
                    <dt>Created by</dt>
                    <dd>
                      <Avatar name={thread.createdBy.name} kind={thread.createdBy.kind} size={18} />
                      {thread.createdBy.name}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {task?.state === "completed" && task.result ? (
                <div className={styles.result}>
                  <div className={styles.resultHead}>
                    <StatusIcon state="completed" size={12} /> Result
                  </div>
                  <div className={styles.resultText}>{task.result}</div>
                </div>
              ) : null}
            </div>

            <h3 className={styles.activityTitle}>Activity</h3>
            <div className={styles.activity} aria-label="Events" aria-live="polite">
              {items.length === 0 ? <p className={styles.muted}>No events yet.</p> : null}
              {items.map((item, i) => (
                <EventRenderer
                  key={item.id}
                  item={item}
                  grouped={sameAuthor(items[i - 1], item)}
                  at={times.get(item.cursor)}
                />
              ))}
            </div>
          </div>

          <div className={styles.foot}>
            {task?.state === "blocked" ? (
              <AnswerForm key={task.block?.interruptId} task={task} onAnswered={refresh} />
            ) : null}
            <ReplyBox threadId={id} onSent={refresh} />
          </div>
        </>
      )}
    </aside>
  );
}
