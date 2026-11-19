"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { EVENT_KINDS } from "@copilotkit/teamkit-protocol";
import type { RoomSummary, Task, TaskState } from "@copilotkit/teamkit-protocol";
import { api } from "../lib/api";
import { useBoardStream } from "../lib/stream";
import { NewTaskForm } from "./NewTaskForm";
import { RoomSidebar } from "./RoomSidebar";
import { SignedOut } from "./SignedOut";
import { TaskCard } from "./TaskCard";
import styles from "./board.module.css";

const ALL_ROOMS = "*";
const TASK_KINDS: string[] = EVENT_KINDS.filter((k) => k.startsWith("task."));
const REFETCH_DEBOUNCE_MS = 150;
const CLOCK_MS = 30_000;

type ColumnKey = "waiting" | "ready" | "claimed" | "blocked" | "done";

const COLUMNS: Array<{ key: ColumnKey; title: string; states: TaskState[]; empty: string }> = [
  { key: "waiting", title: "Waiting", states: ["waiting"], empty: "Nothing is waiting on another task." },
  { key: "ready", title: "Ready", states: ["ready"], empty: "No tasks are ready to claim." },
  { key: "claimed", title: "Claimed", states: ["claimed"], empty: "Nobody is working on a task right now." },
  { key: "blocked", title: "Blocked", states: ["blocked"], empty: "No task needs an answer." },
  { key: "done", title: "Done", states: ["completed", "failed"], empty: "Nothing has finished yet." },
];

export function Board() {
  const params = useSearchParams();
  const selected = params.get("room") || ALL_ROOMS;

  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
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
  }, [selected]);

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

  return (
    <div className={styles.layout}>
      <RoomSidebar rooms={rooms} selected={selected} />
      <div className={styles.content}>
        <div className={styles.toolbar}>
          <h2 className={styles.heading}>{selected === ALL_ROOMS ? "All rooms" : selected}</h2>
          <span className={styles.live} data-connected={connected}>
            <span className={styles.liveDot} aria-hidden="true" />
            {connected ? "Live" : "Reconnecting"}
          </span>
        </div>
        <NewTaskForm rooms={rooms} selected={selected} onCreated={load} />
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
                  <span className={styles.columnTitle}>{c.title}</span>
                  <span className={styles.count}>{c.tasks.length}</span>
                  <div className={styles.line} />
                </div>
                <div className={styles.cards}>
                  {tasks === null ? (
                    <p className={styles.empty}>Loading…</p>
                  ) : c.tasks.length === 0 ? (
                    <p className={styles.empty}>{c.empty}</p>
                  ) : (
                    c.tasks.map((t) => <TaskCard key={t.id} task={t} now={now} />)
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
