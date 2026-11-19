import styles from "./shell.module.css";

export function SignedOut({ hint }: { hint?: string }) {
  return (
    <section className={`tk-glass ${styles.signedOut}`}>
      <div className={styles.sectionLabel}>
        <span>Access</span>
        <div className={styles.sectionLine} />
      </div>
      <p className={styles.signedOutText}>
        You&apos;re not signed in. Ask an admin for a sign-in link (<code className={styles.code}>teamkit-admin people invite &lt;name&gt;</code>).
      </p>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </section>
  );
}
