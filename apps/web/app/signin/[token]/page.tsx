"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { postJson } from "../../../lib/api";
import styles from "../../../components/auth.module.css";

type State = { kind: "pending" } | { kind: "invalid" } | { kind: "failed"; message: string };

export default function SignInPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const started = useRef(false);
  const [state, setState] = useState<State>({ kind: "pending" });

  useEffect(() => {
    // StrictMode runs effects twice in dev; a sign-in link is single use.
    if (started.current) return;
    started.current = true;
    postJson("/v1/signin", { token: params.token }).then(
      () => router.replace("/"),
      (err: unknown) => {
        if (err instanceof TeamkitError && err.status >= 400 && err.status < 500) {
          setState({ kind: "invalid" });
        } else {
          setState({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
        }
      },
    );
  }, [params.token, router]);

  return (
    <section className={`tk-glass ${styles.panel}`} aria-live="polite">
      <div className={styles.label}>
        <span>Sign in</span>
        <div className={styles.line} />
      </div>
      {state.kind === "pending" ? <p className={styles.text}>Signing you in…</p> : null}
      {state.kind === "invalid" ? (
        <p className={styles.text}>
          This sign-in link is invalid, used or expired. Ask an admin for a new one.
        </p>
      ) : null}
      {state.kind === "failed" ? (
        <>
          <p className={styles.text}>Sign-in failed. Try again.</p>
          <p className={styles.detail}>{state.message}</p>
        </>
      ) : null}
    </section>
  );
}
