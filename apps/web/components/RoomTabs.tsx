import Link from "next/link";
import type { ReactNode } from "react";
import { ROOM_TABS, roomQuery, type RoomTab } from "../lib/coord";
import type { Presence } from "@copilotkit/teamkit-protocol";
import { IconAlert, IconRollCall } from "./Icons";
import { PresencePile } from "./PresencePile";
import styles from "./coord.module.css";

/** Board · Decisions · Changes for one room, Linear-style view tabs under the page header. */
export function RoomTabs({
  room,
  tab,
  agents,
  now,
  onStartRollCall,
  onRaiseAlert,
  children,
}: {
  room: string;
  tab: RoomTab;
  agents: Presence[];
  now: number;
  onStartRollCall(): void;
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
      <PresencePile agents={agents} now={now} />
      <button type="button" className={`tk-button tk-button-ghost ${styles.raise}`} aria-label="Start roll call" onClick={onStartRollCall}>
        <IconRollCall size={14} />
        <span className={styles.raiseLabel}>Start roll call</span>
      </button>
      <button type="button" className={`tk-button tk-button-ghost ${styles.raise}`} aria-label="Raise alert" onClick={onRaiseAlert}>
        <IconAlert size={14} />
        <span className={styles.raiseLabel}>Raise alert</span>
      </button>
    </div>
  );
}
