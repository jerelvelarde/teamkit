"use client";

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { postJson } from "../lib/api";
import { useWhoami } from "../lib/session";
import { SignedOut } from "./SignedOut";
import styles from "./auth.module.css";

type Result = { kind: "idle" } | { kind: "approved" } | { kind: "error"; message: string };

export function DeviceApprove() {
  const initial = useSearchParams().get("code") ?? "";
  const { state } = useWhoami();
  const [code, setCode] = useState(initial.toUpperCase());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });

  if (state === "loading") return null;
  if (state === "signed_out") {
    return <SignedOut hint="Sign in with your invite link first, then reopen this page." />;
  }

  async function approve(e: FormEvent) {
    e.preventDefault();
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
        <form className={styles.form} onSubmit={approve}>
          <input
            className={`tk-input ${styles.codeInput}`}
            aria-label="Device code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="BCDF-GHJK"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className={`tk-button ${styles.submit}`} disabled={busy || !code.trim()}>
            Approve this sign-in
          </button>
        </form>
      )}
      {result.kind === "error" ? <p className={styles.error}>{result.message}</p> : null}
    </section>
  );
}
