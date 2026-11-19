import Link from "next/link";
import type { ReactNode } from "react";
import { ROOM_TABS, roomQuery, type RoomTab } from "../lib/coord";
import styles from "./coord.module.css";

/** Board · Decisions · Changes for one room, Linear-style view tabs under the page header. */
export function RoomTabs({ room, tab, children }: { room: string; tab: RoomTab; children?: ReactNode }) {
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
    </div>
  );
}
