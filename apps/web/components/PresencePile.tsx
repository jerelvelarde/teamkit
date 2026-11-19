"use client";

import { useEffect, useRef, useState } from "react";
import type { Presence } from "@copilotkit/teamkit-protocol";
import { presenceLine } from "../lib/coord";
import { Avatar } from "./Avatar";
import styles from "./coord.module.css";

const AVATARS_SHOWN = 3;

/** The agents on in a room: overlapping avatars that open a short list of who and what they are doing. */
export function PresencePile({ agents, now }: { agents: Presence[]; now: number }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // so the thread panel underneath does not also close
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (agents.length === 0) return null;
  const label = `${agents.length} ${agents.length === 1 ? "agent" : "agents"} on`;
  const shown = agents.slice(0, AVATARS_SHOWN);
  return (
    <div className={styles.pile} ref={box}>
      <button
        type="button"
        className={`tk-button tk-button-ghost ${styles.pileButton}`}
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.pileAvatars} aria-hidden="true">
          {shown.map((p) => (
            <Avatar key={p.actor.id} name={p.actor.name} kind={p.actor.kind} size={20} />
          ))}
        </span>
        {agents.length > shown.length ? <span className={styles.pileMore} aria-hidden="true">{`+${agents.length - shown.length}`}</span> : null}
      </button>
      {open ? (
        <div className={styles.popover} role="group" aria-label="Agents on">
          <div className={styles.popoverLabel}>On now</div>
          {agents.map((p) => {
            const latest = [...p.sessions].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
            return (
              <div key={p.actor.id} className={styles.popoverRow}>
                <Avatar name={p.actor.name} kind={p.actor.kind} size={20} />
                <span className={styles.popoverName}>{presenceLine(p, now)}</span>
                {latest?.status ? <span className={styles.popoverStatus}>{latest.status}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
