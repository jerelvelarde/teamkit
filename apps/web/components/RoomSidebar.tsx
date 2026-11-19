"use client";

import type { RoomSummary } from "@copilotkit/teamkit-protocol";
import styles from "./board.module.css";

export function RoomSidebar({ rooms, selected }: { rooms: RoomSummary[]; selected: string }) {
  const item = (value: string, label: string) => {
    const active = selected === value;
    const href = value === "*" ? "/" : `/?room=${encodeURIComponent(value)}`;
    return (
      <li key={value}>
        <a
          href={href}
          className={`${styles.roomLink} ${active ? styles.roomLinkActive : ""}`}
          aria-current={active ? "page" : undefined}
        >
          {label}
        </a>
      </li>
    );
  };

  return (
    <aside className={`tk-glass ${styles.sidebar}`} aria-label="Rooms">
      <div className={styles.columnHead}>
        <span className={styles.columnTitle}>Rooms</span>
        <div className={styles.line} />
      </div>
      <ul className={styles.roomList}>
        {item("*", "All rooms")}
        {rooms.map((r) => item(r.name, r.name))}
      </ul>
    </aside>
  );
}
