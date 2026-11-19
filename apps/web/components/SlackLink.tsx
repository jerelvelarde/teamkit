"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { TeamkitError } from "@copilotkit/teamkit-client";
import type { ActorRef } from "@copilotkit/teamkit-protocol";
import { postJson } from "../lib/api";
import { useWhoami } from "../lib/session";
import { SignedOut } from "./SignedOut";
import styles from "./auth.module.css";

type Result =
  | { kind: "idle" }
  | { kind: "linked"; name: string }
  | { kind: "error"; message: string };

export function SlackLink() {
  const code = useSearchParams().get("code")?.trim() ?? "";
  const { state } = useWhoami();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });

  if (state === "loading") return null;
  if (state === "signed_out") {
    return (
      <SignedOut hint="Sign in with your invite link first, then open this Slack link again." />
    );
  }

  async function link() {
    setBusy(true);
    try {
      const res = await postJson<{ slackUserId: string; actor: ActorRef }>("/v1/slack/link", {
        code,
      });
      setResult({ kind: "linked", name: res.actor.name });
    } catch (err) {
      if (err instanceof TeamkitError && err.code === "not_found") {
        setResult({
          kind: "error",
          message:
            "This link is invalid, used or expired. Click the button in Slack again to get a new one.",
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
        <span>Slack</span>
        <div className={styles.line} />
      </div>
      <h2 className={styles.title}>Link your Slack account</h2>
      {!code ? (
        <p className={styles.text}>Open this page from the link TeamKit sent you in Slack.</p>
      ) : result.kind === "linked" ? (
        <p className={styles.text}>
          Linked. Your clicks in Slack now count as you, {result.name}.
        </p>
      ) : (
        <>
          <p className={styles.text}>
            This connects your Slack user to your TeamKit account, so approvals you click in Slack
            count as you.
          </p>
          <div className={styles.form}>
            <button type="button" className={`tk-button ${styles.submit}`} disabled={busy} onClick={link}>
              Link my Slack account
            </button>
          </div>
        </>
      )}
      {result.kind === "error" ? <p className={styles.error}>{result.message}</p> : null}
    </section>
  );
}
