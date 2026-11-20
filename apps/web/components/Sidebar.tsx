"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { postJson } from "../lib/api";
import { agentsOn } from "../lib/coord";
import { useShell } from "./AppShell";
import { Avatar } from "./Avatar";
import { BrandMark } from "./AuthFrame";
import { IconBoard, IconHash, IconSettings, IconSignOut, IconX } from "./Icons";
import styles from "./shell.module.css";

export function Sidebar({ onNavigate }: { onNavigate(): void }) {
  const { who, rooms, presence, presenceAt } = useShell();
  const path = usePathname();
  const params = useSearchParams();
  const onBoard = path === "/" || path.startsWith("/t/");
  const room = onBoard ? params.get("room") : null;

  async function signOut() {
    try {
      await postJson("/v1/logout", {});
    } finally {
      window.location.reload();
    }
  }

  // `spoken` extends the link's name through aria-label: hidden text in a separate element would be
  // read after a space ("billing-prod , 1 agent on").
  const item = (
    href: string,
    label: string,
    icon: ReactNode,
    active: boolean,
    extra?: { trailing?: ReactNode; title?: string; spoken?: string },
  ) => (
    <Link
      href={href}
      className={styles.navItem}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      title={extra?.title ?? label}
      aria-label={extra?.spoken ? `${label}${extra.spoken}` : undefined}
    >
      <span className={styles.navIcon}>{icon}</span>
      <span className={styles.navLabel}>{label}</span>
      {extra?.trailing}
    </Link>
  );

  /** Up to three green dots for the agents on in a room, and ", n agents on" for the link's name. */
  const onDots = (name: string) => {
    const on = agentsOn(presence.get(name) ?? [], presenceAt);
    if (on.length === 0) return undefined;
    const shown = on.slice(0, 3);
    return {
      title: `${name} · ${on.map((p) => p.actor.name).join(", ")}`,
      spoken: `, ${on.length} ${on.length === 1 ? "agent" : "agents"} on`,
      trailing: (
        <span className={styles.onDots} aria-hidden="true">
          <span className={styles.onDotRow}>
            {shown.map((p) => (
              <span key={p.actor.id} className={styles.onDot} />
            ))}
          </span>
          {on.length > shown.length ? <span className={styles.onMore}>{`+${on.length - shown.length}`}</span> : null}
        </span>
      ),
    };
  };

  return (
    <aside className={styles.sidebar} aria-label="Workspace">
      <div className={styles.brandRow}>
        <BrandMark />
        <button
          type="button"
          className={`tk-button tk-button-ghost tk-icon-button ${styles.navClose}`}
          aria-label="Close menu"
          onClick={onNavigate}
        >
          <IconX />
        </button>
      </div>

      <nav className={styles.nav} aria-label="Main">
        {item("/", "All rooms", <IconBoard />, onBoard && !room)}
        {who.role === "admin" ? item("/admin", "Admin", <IconSettings />, path.startsWith("/admin")) : null}
      </nav>

      <div className={styles.groupLabel} id="tk-rooms-label">
        Rooms
      </div>
      <ul className={styles.roomList} aria-labelledby="tk-rooms-label">
        {rooms.map((r) => (
          <li key={r.name}>
            {item(`/?room=${encodeURIComponent(r.name)}`, r.name, <IconHash />, room === r.name, onDots(r.name))}
          </li>
        ))}
        {rooms.length === 0 ? <li className={styles.navEmpty}>No rooms yet</li> : null}
      </ul>

      <div className={styles.me}>
        <Avatar name={who.actor.name} kind="person" size={22} />
        <span className={styles.meName}>{who.actor.name}</span>
        <button
          type="button"
          className="tk-button tk-button-ghost tk-icon-button"
          onClick={signOut}
          aria-label="Sign out"
          title="Sign out"
        >
          <IconSignOut />
        </button>
      </div>
    </aside>
  );
}
