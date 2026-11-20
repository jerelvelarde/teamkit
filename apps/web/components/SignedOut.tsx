import styles from "./shell.module.css";

export function SignedOut({ hint }: { hint?: string }) {
  return (
    <section className={`tk-glass ${styles.notice}`}>
      <h1 className={styles.noticeTitle}>You&apos;re not signed in</h1>
      <p className={styles.noticeText}>
        New here? Open your team&apos;s join link. Been here before? <a href="/signin">Email me a sign-in link</a>, or ask
        an admin for one.
      </p>
      {hint ? <p className={styles.hint}>{hint}</p> : null}
    </section>
  );
}

/** The server did not answer (it may be restarting). The session is unknown, not gone; the page retries by itself. */
export function ServerUnavailable({ onRetry }: { onRetry(): void }) {
  return (
    <section className={`tk-glass ${styles.notice}`} role="status">
      <h1 className={styles.noticeTitle}>Can&apos;t reach the server</h1>
      <p className={styles.noticeText}>
        TeamKit can&apos;t reach its server right now. It may be restarting; this page tries again every few seconds.
      </p>
      <button type="button" className={`tk-button ${styles.retry}`} onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}
