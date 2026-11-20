"use client";

import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { HEARTBEAT_EVERY_MS, type Presence, type RoomSummary, type Whoami } from "@copilotkit/teamkit-protocol";
import { api } from "../lib/api";
import { useWhoami } from "../lib/session";
import { AuthFrame } from "./AuthFrame";
import { IconMenu } from "./Icons";
import { ServerUnavailable, SignedOut } from "./SignedOut";
import { Sidebar } from "./Sidebar";
import styles from "./shell.module.css";

interface Shell {
  who: Whoami;
  rooms: RoomSummary[];
  setRooms(rooms: RoomSummary[]): void;
  openNav(): void;
  /** Each room's agent sessions, polled; and when they were last polled. */
  presence: ReadonlyMap<string, Presence[]>;
  presenceAt: number;
}

const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell is used outside the app shell");
  return shell;
}

/** Signs the visitor in once for every page inside it, then draws the sidebar and the content panel. */
export function AppShell({ children }: { children: ReactNode }) {
  const { state, who, refresh } = useWhoami();
  const [rooms, setRoomsState] = useState<RoomSummary[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [presence, setPresence] = useState<ReadonlyMap<string, Presence[]>>(new Map());
  const [presenceAt, setPresenceAt] = useState(() => Date.now());
  const roomNames = useMemo(() => rooms.map((r) => r.name).join("\n"), [rooms]);

  // The board refetches rooms with every task change; replace the list only when it changed.
  const setRooms = useCallback((next: RoomSummary[]) => {
    setRoomsState((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);

  useEffect(() => {
    if (state !== "signed_in") return;
    let live = true;
    api.rooms().then(
      (list) => live && setRooms(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [state, setRooms]);

  // Presence is polled, not streamed: every room at once, right away, then every heartbeat while
  // the tab is visible, and once more when it becomes visible. A room that fails keeps its last list.
  useEffect(() => {
    if (state !== "signed_in" || roomNames === "") return;
    const names = roomNames.split("\n");
    let live = true;
    const poll = async () => {
      const results = await Promise.allSettled(names.map((n) => api.presence(n)));
      if (!live) return;
      setPresence((prev) => {
        const next = new Map(prev);
        results.forEach((r, i) => {
          if (r.status === "fulfilled") next.set(names[i]!, r.value);
        });
        return next;
      });
      setPresenceAt(Date.now());
    };
    void poll();
    const id = setInterval(() => {
      if (!document.hidden) void poll();
    }, HEARTBEAT_EVERY_MS);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state, roomNames]);

  const value = useMemo<Shell | null>(
    () => (who ? { who, rooms, setRooms, openNav: () => setNavOpen(true), presence, presenceAt } : null),
    [who, rooms, setRooms, presence, presenceAt],
  );

  if (state === "loading") return <div className={styles.blank} />;
  if (state === "signed_out") {
    return (
      <AuthFrame>
        <SignedOut />
      </AuthFrame>
    );
  }
  if (state === "unavailable" || !value) {
    return (
      <AuthFrame>
        <ServerUnavailable onRetry={refresh} />
      </AuthFrame>
    );
  }

  return (
    <ShellContext.Provider value={value}>
      <div className={styles.app} data-nav-open={navOpen || undefined}>
        <Suspense fallback={<div className={styles.sidebarSlot} />}>
          <Sidebar onNavigate={() => setNavOpen(false)} />
        </Suspense>
        <div className={styles.scrim} onClick={() => setNavOpen(false)} aria-hidden="true" />
        <main className={styles.main}>{children}</main>
      </div>
    </ShellContext.Provider>
  );
}

/** The bar across the top of the content panel: page title on the left, page actions on the right. */
export function PageHeader({ title, icon, children }: { title: string; icon?: ReactNode; children?: ReactNode }) {
  const { openNav } = useShell();
  return (
    <header className={styles.pageHeader}>
      <button
        type="button"
        className={`tk-button tk-button-ghost tk-icon-button ${styles.menuButton}`}
        aria-label="Open menu"
        onClick={openNav}
      >
        <IconMenu />
      </button>
      {icon ? <span className={styles.pageIcon}>{icon}</span> : null}
      <h1 className={styles.pageTitle}>{title}</h1>
      {children}
    </header>
  );
}
