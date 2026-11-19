"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EVENT_KINDS } from "@copilotkit/teamkit-protocol";
import type { Alert, BoardEvent, ChangeEntry, Decision, Task, TaskState } from "@copilotkit/teamkit-protocol";
import { api } from "../lib/api";
import { agentsOn, parseTab, roomQuery } from "../lib/coord";
import { useRoomList } from "../lib/records";
import { useBoardStream } from "../lib/stream";
import { PageHeader, useShell } from "./AppShell";
import { IconBoard, IconHash, IconPlus, StatusIcon } from "./Icons";
import { AlertBanner } from "./AlertBanner";
import { ChangeLog } from "./ChangeLog";
import { DecisionList } from "./DecisionList";
import { NewTaskForm } from "./NewTaskForm";
import { RoomTabs } from "./RoomTabs";
import { SignedOut } from "./SignedOut";
import { TaskCard } from "./TaskCard";
import { TextDialog } from "./TextDialog";
import styles from "./board.module.css";

const ALL_ROOMS = "*";
/** The board's one stream carries tasks, decisions, changes and alerts. */
const STREAM_KINDS: string[] = EVENT_KINDS.filter((k) => /^(task|decision|change|alert)\./.test(k));
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

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

export function Board({ children }: { children?: ReactNode }) {
  const params = useSearchParams();
  const path = usePathname();
  const selected = params.get("room") || ALL_ROOMS;
  const openId = path.startsWith("/t/") ? decodeURIComponent(path.slice(3)) : null;
  const { rooms, setRooms, presence, presenceAt } = useShell();
  const router = useRouter();

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [alerting, setAlerting] = useState(false);
  const lastJson = useRef("");
  const allRooms = selected === ALL_ROOMS;
  const room = allRooms ? null : selected;
  const tab = allRooms ? "board" : parseTab(params.get("view"));
  const query = roomQuery(selected, tab);
  const decisions = useRoomList<Decision>(room, "decision.", (r) => api.decisions(r));
  const changes = useRoomList<ChangeEntry>(room, "change.", (r) => api.changes(r));
  const alerts = useRoomList<Alert>(room, "alert.", (r) => api.alerts(r, { open: true }));

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
    { room: selected === ALL_ROOMS ? undefined : selected, kinds: STREAM_KINDS },
    (e: BoardEvent) => {
      if (e.kind.startsWith("task.")) refetch();
      decisions.onEvent(e.kind);
      changes.onEvent(e.kind);
      alerts.onEvent(e.kind);
    },
    {
      onOpen: () => {
        refetch();
        decisions.reload();
        changes.reload();
        alerts.reload();
      },
    },
  );

  // Lease countdowns advance on a slow clock; the cards do not need second precision.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, []);

  // "c" opens the tab's create form, as it does in Linear: a decision on Decisions, else a task.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "c" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      if (tab === "decisions") setDeciding(true);
      else setCreating(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);

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

  return (
    <>
      <PageHeader title={allRooms ? "All rooms" : selected} icon={allRooms ? <IconBoard /> : <IconHash />}>
        <span className={styles.live} data-connected={connected} role="status">
          <span className={styles.liveDot} aria-hidden="true" />
          {connected ? "Live" : "Reconnecting"}
        </span>
        <div className={styles.headerSpacer} />
        {tab === "decisions" ? (
          <button
            type="button"
            className="tk-button tk-button-primary"
            onClick={() => setDeciding(true)}
            aria-keyshortcuts="c"
            title="New decision (C)"
          >
            <IconPlus size={14} />
            New decision
          </button>
        ) : (
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
        )}
      </PageHeader>
      {room ? (
        <RoomTabs
          room={room}
          tab={tab}
          agents={agentsOn(presence.get(room) ?? [], presenceAt)}
          now={presenceAt}
          onStartRollCall={async () => {
            try {
              const rollCall = await api.startRollCall(room);
              router.push(`/t/${encodeURIComponent(rollCall.threadId)}${query}`, { scroll: false });
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not start the roll call.");
            }
          }}
          onRaiseAlert={() => setAlerting(true)}
        />
      ) : null}
      {room && alerts.items ? <AlertBanner alerts={alerts.items} query={query} now={now} onChanged={alerts.reload} /> : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {tab === "decisions" && room ? (
        <DecisionList decisions={decisions.items} room={room} openId={openId} query={query} />
      ) : tab === "changes" && room ? (
        <ChangeLog changes={changes.items} room={room} openId={openId} query={query} />
      ) : (
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
      )}

      {children}

      <NewTaskForm
        open={creating}
        onClose={() => setCreating(false)}
        rooms={rooms}
        selected={selected}
        onCreated={load}
      />
      {room ? (
        <TextDialog
          open={deciding}
          title="New decision"
          room={room}
          label="Decision"
          placeholder="What did the team decide?"
          submitLabel="Post decision"
          busyLabel="Posting…"
          emptyError="Write the decision first."
          onSubmit={async (text) => {
            await api.postDecision({ room, text });
            decisions.reload();
          }}
          onClose={() => setDeciding(false)}
        />
      ) : null}
      {room ? (
        <TextDialog
          open={alerting}
          title="Raise alert"
          room={room}
          label="Alert"
          placeholder="What looks wrong?"
          submitLabel="Raise alert"
          busyLabel="Raising…"
          emptyError="Describe what looks wrong."
          onSubmit={async (text) => {
            await api.raiseAlert({ room, text });
            alerts.reload();
          }}
          onClose={() => setAlerting(false)}
        />
      ) : null}
    </>
  );
}
