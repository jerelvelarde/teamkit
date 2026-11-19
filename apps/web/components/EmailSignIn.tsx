"use client";

import { useState, type FormEvent } from "react";
import { postJson } from "../lib/api";
import { emailSignInErrorMessage } from "../lib/join";
import styles from "./auth.module.css";

type Result = { kind: "idle" } | { kind: "sent" } | { kind: "error"; message: string };

export function EmailSignIn() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await postJson("/v1/signin/email", { email });
      setResult({ kind: "sent" });
    } catch (err) {
      setResult({ kind: "error", message: emailSignInErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`tk-glass ${styles.panel}`} aria-live="polite">
      <h2 className={styles.title}>Sign in to AG-UI TeamKit</h2>
      {result.kind === "sent" ? (
        <p className={styles.success}>
          If that email belongs to someone here, a sign-in link is on its way. It works once, within 30 minutes.
        </p>
      ) : (
        <form className={styles.codeForm} onSubmit={send}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Email</span>
            <input
              className="tk-input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ana@example.com"
            />
          </label>
          <button type="submit" className={`tk-button ${styles.submit}`} disabled={busy || email.trim() === ""}>
            Email me a sign-in link
          </button>
        </form>
      )}
      {result.kind === "error" ? <p className={styles.error}>{result.message}</p> : null}
    </section>
  );
}
