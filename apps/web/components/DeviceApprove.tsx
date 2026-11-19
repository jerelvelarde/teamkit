"use client";

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { postJson } from "../lib/api";
import { useWhoami } from "../lib/session";
import { ServerUnavailable, SignedOut } from "./SignedOut";
import styles from "./auth.module.css";

type Result = { kind: "idle" } | { kind: "approved" } | { kind: "error"; message: string };

export function DeviceApprove() {
  const initial = useSearchParams().get("code") ?? "";
  const { state, refresh } = useWhoami();
  const [code, setCode] = useState(initial.toUpperCase());
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });

  if (state === "loading") return null;
  if (state === "signed_out") {
    return <SignedOut hint="Sign in with your invite link first, then reopen this page." />;
  }
  if (state === "unavailable") return <ServerUnavailable onRetry={refresh} />;

  async function approve(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setBusy(true);
    try {
      await postJson("/v1/device/approve", { userCode: code.trim() });
      setResult({ kind: "approved" });
    } catch (err) {
      if (err instanceof TeamkitError && err.code === "not_found") {
        setResult({
          kind: "error",
          message: "That code is unknown or expired. Run `teamkit login` again.",
        });
      } else {
        setResult({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`tk-glass ${styles.panel}`} aria-live="polite">
      <div className={styles.label}>
        <span>Device</span>
        <div className={styles.line} />
      </div>
      <h2 className={styles.title}>Approve a command-line sign-in</h2>
      <p className={styles.text}>
        This lets the teamkit command-line tool run admin commands as you. It cannot post, claim or
        answer.
      </p>
      {result.kind === "approved" ? (
        <p className={styles.error}>Approved. You can return to your terminal.</p>
      ) : (
        <>
          <p className={styles.warning}>Never approve a code someone sent you.</p>
          <form className={styles.codeForm} onSubmit={approve}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Code shown in your terminal</span>
              <input
                className={`tk-input ${styles.codeDisplay}`}
                value={code}
                onChange={(e) => {
                  setCode(e.target.value.toUpperCase());
                  // The confirmation is for the code on screen; a new code needs a new one.
                  setConfirmed(false);
                }}
                placeholder="BCDF-GHJK"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>
                This code matches the one in my own terminal, and I just ran{" "}
                <code className={styles.mono}>teamkit login</code>
              </span>
            </label>
            <button
              type="submit"
              className={`tk-button ${styles.submit}`}
              disabled={busy || !code.trim() || !confirmed}
            >
              Approve this sign-in
            </button>
          </form>
        </>
      )}
      {result.kind === "error" ? <p className={styles.error}>{result.message}</p> : null}
    </section>
  );
}
