"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { EVENT_KINDS } from "@copilotkit/teamkit-protocol";
import type { Task, TaskState } from "@copilotkit/teamkit-protocol";
import { api } from "../lib/api";
import { useBoardStream } from "../lib/stream";
import { PageHeader, useShell } from "./AppShell";
import { IconBoard, IconHash, IconPlus, StatusIcon } from "./Icons";
import { NewTaskForm } from "./NewTaskForm";
import { SignedOut } from "./SignedOut";
import { TaskCard } from "./TaskCard";
import styles from "./board.module.css";

const ALL_ROOMS = "*";
const TASK_KINDS: string[] = EVENT_KINDS.filter((k) => k.startsWith("task."));
const REFETCH_DEBOUNCE_MS = 150;
const CLOCK_MS = 30_000;

type ColumnKey = "waiting" | "ready" | "claimed" | "blocked" | "done";

const COLUMNS: Array<{ key: ColumnKey; title: string; icon: TaskState; states: TaskState[]; empty: string }> = [
  { key: "waiting", title: "Waiting", icon: "waiting", states: ["waiting"], empty: "Nothing is waiting on another task." },
  { key: "ready", title: "Ready", icon: "ready", states: ["ready"], empty: "No tasks are ready to claim." },
  { key: "claimed", title: "Claimed", icon: "claimed", states: ["claimed"], empty: "Nobody is working on a task right now." },
  { key: "blocked", title: "Blocked", icon: "blocked", states: ["blocked"], empty: "No task needs an answer." },
  { key: "done", title: "Done", icon: "completed", states: ["completed", "failed"], empty: "Nothing has finished yet." },
];

/** The query string that keeps the selected room when a task opens or closes. */
export function roomQuery(room: string | null): string {
  return room && room !== ALL_ROOMS ? `?room=${encodeURIComponent(room)}` : "";
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

export function Board({ children }: { children?: ReactNode }) {
  const params = useSearchParams();
  const path = usePathname();
  const selected = params.get("room") || ALL_ROOMS;
  const openId = path.startsWith("/t/") ? decodeURIComponent(path.slice(3)) : null;
  const { rooms, setRooms } = useShell();

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [creating, setCreating] = useState(false);
  const lastJson = useRef("");

  const load = useCallback(async () => {
    try {
      const [list, next] = await Promise.all([
        api.rooms(),
        api.tasks({ room: selected === ALL_ROOMS ? undefined : selected, state: "all" }),
      ]);
      setRooms(list);
      // Replace state only when the data changed, so an unchanged refetch repaints nothing.
      const json = JSON.stringify(next);
      if (json !== lastJson.current) {
        lastJson.current = json;
        setTasks(next);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tasks.");
    }
  }, [selected, setRooms]);

  useEffect(() => {
    lastJson.current = "";
    setTasks(null);
    void load();
  }, [load]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refetch = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), REFETCH_DEBOUNCE_MS);
  }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Refetch on every (re)open too: a live tail that reopens after a failure skips what
  // happened while it was down.
  const { connected, signedOut } = useBoardStream(
    { room: selected === ALL_ROOMS ? undefined : selected, kinds: TASK_KINDS },
    refetch,
    { onOpen: refetch },
  );

  // Lease countdowns advance on a slow clock; the cards do not need second precision.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  // "c" opens the new task form, as it does in Linear.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      setCreating(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const briefs = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t.brief])), [tasks]);

  const columns = useMemo(
    () =>
      COLUMNS.map((c) => ({
        ...c,
        tasks: (tasks ?? [])
          .filter((t) => c.states.includes(t.state))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      })),
    [tasks],
  );

  if (signedOut) return <SignedOut hint="Your session ended. Open a new sign-in link to continue." />;

  const allRooms = selected === ALL_ROOMS;
  const query = roomQuery(selected);

  return (
    <>
      <PageHeader title={allRooms ? "All rooms" : selected} icon={allRooms ? <IconBoard /> : <IconHash />}>
        <span className={styles.live} data-connected={connected} role="status">
          <span className={styles.liveDot} aria-hidden="true" />
          {connected ? "Live" : "Reconnecting"}
        </span>
        <div className={styles.headerSpacer} />
        <button
          type="button"
          className="tk-button tk-button-primary"
          onClick={() => setCreating(true)}
          aria-keyshortcuts="c"
          title="New task (C)"
        >
          <IconPlus size={14} />
          New task
        </button>
      </PageHeader>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.columnsScroll}>
        <div className={styles.columns}>
          {columns.map((c) => (
            <section key={c.key} className={styles.column} aria-label={c.title}>
              <div className={styles.columnHead}>
                <StatusIcon state={c.icon} />
                <span className={styles.columnTitle}>{c.title}</span>
                <span className={styles.count}>{tasks === null ? "" : c.tasks.length}</span>
              </div>
              <div className={styles.cards}>
                {tasks === null ? (
                  <>
                    <div className={styles.skeleton} />
                    <div className={styles.skeleton} />
                  </>
                ) : c.tasks.length === 0 ? (
                  <p className={styles.empty}>{c.empty}</p>
                ) : (
                  c.tasks.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      now={now}
                      href={`/t/${encodeURIComponent(t.id)}${query}`}
                      selected={t.id === openId}
                      showRoom={allRooms}
                      briefs={briefs}
                    />
                  ))
                )}
              </div>
            </section>
          ))}
        </div>
      </div>

      {children}

      <NewTaskForm
        open={creating}
        onClose={() => setCreating(false)}
        rooms={rooms}
        selected={selected}
        onCreated={load}
      />
    </>
  );
}
