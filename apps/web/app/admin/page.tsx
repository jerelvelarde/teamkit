"use client";

import { People } from "../../components/admin/People";
import { Rooms } from "../../components/admin/Rooms";
import { Tokens } from "../../components/admin/Tokens";
import styles from "../../components/admin/admin.module.css";
import { ServerUnavailable, SignedOut } from "../../components/SignedOut";
import { useWhoami } from "../../lib/session";

export default function AdminPage() {
  const { state, who, refresh } = useWhoami();
  if (state === "loading") return null;
  if (state === "signed_out") return <SignedOut />;
  if (state === "unavailable") return <ServerUnavailable onRetry={refresh} />;
  if (who?.role !== "admin") {
    return (
      <section className={`tk-glass ${styles.denied}`}>
        <p className={styles.deniedText}>Admins only.</p>
      </section>
    );
  }
  return (
    <div className={styles.page}>
      <h2 className={styles.heading}>Admin</h2>
      <People />
      <Tokens />
      <Rooms />
    </div>
  );
}
