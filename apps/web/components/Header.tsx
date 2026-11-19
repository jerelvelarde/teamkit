"use client";

import { usePathname } from "next/navigation";
import { postJson } from "../lib/api";
import { useWhoami } from "../lib/session";
import styles from "./shell.module.css";

export function Header() {
  const { state, who } = useWhoami();
  const path = usePathname();
  const isAdmin = who?.role === "admin";

  async function signOut() {
    try {
      await postJson("/v1/logout", {});
    } finally {
      window.location.reload();
    }
  }

  const link = (href: string, label: string) => {
    const active = href === "/" ? path === "/" : path.startsWith(href);
    return (
      <a href={href} className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}>
        {label}
      </a>
    );
  };

  return (
    <header className={styles.header}>
      <div className={`tk-glass ${styles.bar}`}>
        <h1 className={styles.title}>
          <span className="tk-pill">AG-UI</span> TeamKit
        </h1>
        <nav className={styles.nav} aria-label="Main">
          {link("/", "Board")}
          {isAdmin ? link("/admin", "Admin") : null}
        </nav>
        <div className={styles.spacer} />
        {state === "signed_in" && who ? (
          <div className={styles.who}>
            <span className={styles.name}>{who.actor.name}</span>
            <button type="button" className="tk-button" onClick={signOut}>
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
