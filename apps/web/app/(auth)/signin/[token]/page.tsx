"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { postJson } from "../../../../lib/api";
import styles from "../../../../components/auth.module.css";

type State =
  | { kind: "ready" }
  | { kind: "pending" }
  | { kind: "invalid" }
  | { kind: "failed"; message: string };

export default function SignInPage() {
  const params = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: "ready" });

  // A sign-in link is single use, so it is spent only on a click: link scanners that run
  // the page's script must not use it up.
  async function signIn() {
    setState({ kind: "pending" });
    try {
      await postJson("/v1/signin", { token: params.token });
    } catch (err) {
      if (err instanceof TeamkitError && err.status >= 400 && err.status < 500) {
        setState({ kind: "invalid" });
      } else {
        setState({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    // A full load, so the header (rendered before the session cookie existed) reads the new session.
    window.location.replace("/");
  }

  return (
    <section className={`tk-glass ${styles.panel}`} aria-live="polite">
      {state.kind === "invalid" ? (
        <p className={styles.text}>
          This sign-in link is invalid, used or expired. Ask an admin for a new one.
        </p>
      ) : (
        <>
          <h2 className={styles.title}>Sign in to AG-UI TeamKit as a person</h2>
          <p className={styles.text}>
            This link works once. It signs you in on this browser for 30 days.
          </p>
          <div className={styles.form}>
            {state.kind === "pending" ? (
              <p className={styles.text}>Signing you in…</p>
            ) : (
              <button type="button" className={`tk-button ${styles.submit}`} onClick={signIn}>
                {state.kind === "failed" ? "Try again" : "Sign in"}
              </button>
            )}
          </div>
          {state.kind === "failed" ? (
            <>
              <p className={styles.error}>Sign-in failed. Try again.</p>
              <p className={styles.detail}>{state.message}</p>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
