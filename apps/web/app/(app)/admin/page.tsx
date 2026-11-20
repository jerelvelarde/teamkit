"use client";

import { PageHeader, useShell } from "../../../components/AppShell";
import { JoinLinks } from "../../../components/admin/JoinLinks";
import { People } from "../../../components/admin/People";
import { Rooms } from "../../../components/admin/Rooms";
import { Tokens } from "../../../components/admin/Tokens";
import { IconSettings } from "../../../components/Icons";
import styles from "../../../components/admin/admin.module.css";

export default function AdminPage() {
  const { who } = useShell();
  return (
    <>
      <PageHeader title="Admin" icon={<IconSettings />} />
      <div className={styles.scroll}>
        {who.role !== "admin" ? (
          <section className={`tk-glass ${styles.denied}`}>
            <p className={styles.deniedText}>Admins only.</p>
          </section>
        ) : (
          <div className={styles.page}>
            <People />
            <JoinLinks />
            <Tokens />
            <Rooms />
          </div>
        )}
      </div>
    </>
  );
}
