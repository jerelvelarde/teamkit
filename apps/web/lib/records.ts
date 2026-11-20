"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** A room's decisions, changes or alerts, kept current by the board's event stream. */
export interface RoomList<T> {
  /** null while the first load runs (or when no room is selected). */
  items: T[] | null;
  error: string | null;
  reload(): void;
  /** Hand every board event's kind here; only kinds in this list's family trigger a reload. */
  onEvent(kind: string): void;
}

const RELOAD_DEBOUNCE_MS = 150;

/**
 * Loads `load(room)` and reloads it, debounced, when an event of `family` arrives. A reload that
 * returns the same JSON keeps the old array, so an unchanged list repaints nothing. A null room
 * loads nothing.
 */
export function useRoomList<T>(
  room: string | null,
  family: "decision." | "change." | "alert.",
  load: (room: string) => Promise<T[]>,
): RoomList<T> {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastJson = useRef("");
  const loadRef = useRef(load);
  loadRef.current = load;
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reload = useCallback(() => {
    if (room === null) return;
    const mine = ++latest.current;
    loadRef.current(room).then(
      (next) => {
        if (mine !== latest.current) return; // a newer load is on its way
        const json = JSON.stringify(next);
        if (json !== lastJson.current) {
          lastJson.current = json;
          setItems(next);
        }
        setError(null);
      },
      (err: unknown) => {
        if (mine === latest.current) setError(err instanceof Error ? err.message : "Could not load this list.");
      },
    );
  }, [room]);

  useEffect(() => {
    lastJson.current = "";
    setItems(null);
    setError(null);
    reload();
    return () => clearTimeout(timer.current);
  }, [reload]);

  const onEvent = useCallback(
    (kind: string) => {
      if (!kind.startsWith(family)) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(reload, RELOAD_DEBOUNCE_MS);
    },
    [family, reload],
  );

  return { items, error, reload, onEvent };
}
