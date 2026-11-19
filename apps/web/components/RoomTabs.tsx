import Link from "next/link";
import type { ReactNode } from "react";
import { ROOM_TABS, roomQuery, type RoomTab } from "../lib/coord";
import { IconAlert } from "./Icons";
import styles from "./coord.module.css";

/** Board · Decisions · Changes for one room, Linear-style view tabs under the page header. */
export function RoomTabs({
  room,
  tab,
  onRaiseAlert,
  children,
}: {
  room: string;
  tab: RoomTab;
  onRaiseAlert(): void;
  children?: ReactNode;
}) {
  return (
    <div className={styles.tabsRow}>
      <nav aria-label="Room views" className={styles.tabs}>
        {ROOM_TABS.map((t) => (
          <Link
            key={t.tab}
            href={`/${roomQuery(room, t.tab)}`}
            scroll={false}
            className={styles.tab}
            aria-current={t.tab === tab ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
      <span className={styles.tabsSpacer} />
      <button type="button" className={`tk-button tk-button-ghost ${styles.raise}`} aria-label="Raise alert" onClick={onRaiseAlert}>
        <IconAlert size={14} />
        <span className={styles.raiseLabel}>Raise alert</span>
      </button>
    </div>
  );
}
