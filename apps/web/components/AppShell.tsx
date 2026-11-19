"use client";

import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { RoomSummary, Whoami } from "@copilotkit/teamkit-protocol";
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

  const value = useMemo<Shell | null>(
    () => (who ? { who, rooms, setRooms, openNav: () => setNavOpen(true) } : null),
    [who, rooms, setRooms],
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
