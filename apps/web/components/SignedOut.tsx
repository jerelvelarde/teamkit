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

/** The server did not answer (it may be restarting). The session is unknown, not gone; the page retries by itself. */
export function ServerUnavailable({ onRetry }: { onRetry(): void }) {
  return (
    <section className={`tk-glass ${styles.signedOut}`} role="status">
      <div className={styles.sectionLabel}>
        <span>Server</span>
        <div className={styles.sectionLine} />
      </div>
      <p className={styles.signedOutText}>
        TeamKit can&apos;t reach its server right now. It may be restarting; this page tries again every few seconds.
      </p>
      <button type="button" className={`tk-button ${styles.retry}`} onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}
