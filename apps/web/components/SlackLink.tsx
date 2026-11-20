"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { getJson, postJson } from "../lib/api";
import { useWhoami } from "../lib/session";
import { ServerUnavailable, SignedOut } from "./SignedOut";
import styles from "./auth.module.css";

interface SlackUser {
  slackUserId: string;
  slackUserName: string | null;
}

interface LinkedSlackUser extends SlackUser {
  linkedAt: string;
}

type Step =
  | { kind: "no_code" }
  | { kind: "checking" }
  | { kind: "confirm"; user: SlackUser }
  | { kind: "linked"; user: SlackUser }
  | { kind: "invalid" };

const INVALID =
  "This link is invalid, used or expired. Click the button in Slack again to get a new one.";

/** "@handle (U123)", or just the id when Slack gave no handle. */
function slackLabel(u: SlackUser): string {
  return u.slackUserName ? `@${u.slackUserName} (${u.slackUserId})` : u.slackUserId;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SlackLink() {
  const code = useSearchParams().get("code")?.trim() ?? "";
  const { state, who, refresh } = useWhoami();
  const [step, setStep] = useState<Step>(code ? { kind: "checking" } : { kind: "no_code" });
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<LinkedSlackUser[] | null>(null);

  const loadLinks = useCallback(() => {
    getJson<{ links: LinkedSlackUser[] }>("/v1/slack/links").then(
      (r) => setLinks(r.links),
      (err: unknown) => setError(errorText(err)),
    );
  }, []);

  // Which Slack user the code is for, without using it up.
  useEffect(() => {
    if (state !== "signed_in" || !code) return;
    let live = true;
    postJson<SlackUser>("/v1/slack/link/preview", { code }).then(
      (user) => live && setStep({ kind: "confirm", user }),
      (err: unknown) => {
        if (!live) return;
        if (err instanceof TeamkitError && err.code === "not_found") setStep({ kind: "invalid" });
        else setError(errorText(err));
      },
    );
    return () => {
      live = false;
    };
  }, [state, code]);

  useEffect(() => {
    if (state === "signed_in") loadLinks();
  }, [state, loadLinks]);

  if (state === "loading") return null;
  if (state === "signed_out") {
    return (
      <SignedOut hint="Sign in with your invite link first, then open this Slack link again." />
    );
  }
  if (state === "unavailable") return <ServerUnavailable onRetry={refresh} />;
  const me = who?.actor.name ?? "you";

  async function link(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== "confirm" || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await postJson<SlackUser>("/v1/slack/link", {
        code,
        slackUserId: step.user.slackUserId,
      });
      setStep({ kind: "linked", user: res });
      loadLinks();
    } catch (err) {
      if (err instanceof TeamkitError && err.code === "not_found") setStep({ kind: "invalid" });
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function unlink(slackUserId: string) {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/v1/slack/links/${encodeURIComponent(slackUserId)}/unlink`);
      loadLinks();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`tk-glass ${styles.panel}`} aria-live="polite">

      {step.kind === "confirm" ? (
        <>
          <h2 className={styles.title}>
            Link Slack {slackLabel(step.user)} to {me}?
          </h2>
          <p className={styles.text}>
            Once linked, buttons you click and replies you send in Slack as this Slack user count as
            you, {me}, on the board. That includes approvals.
          </p>
          <div className={styles.slackUser}>
            <span className={styles.slackHandle}>
              {step.user.slackUserName ? `@${step.user.slackUserName}` : "Slack user"}
            </span>
            <code className={styles.mono}>{step.user.slackUserId}</code>
          </div>
          <p className={styles.warning}>
            Only link your own Slack account. If someone sent you this link, close this page.
          </p>
          <form className={styles.codeForm} onSubmit={link}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                {slackLabel(step.user)} is my own Slack account, and I just clicked a TeamKit button
                in Slack
              </span>
            </label>
            <button
              type="submit"
              className={`tk-button ${styles.submit}`}
              disabled={busy || !confirmed}
            >
              Link to {me}
            </button>
          </form>
        </>
      ) : step.kind === "linked" ? (
        <>
          <h2 className={styles.title}>Slack account linked</h2>
          <p className={styles.text}>
            Linked Slack {slackLabel(step.user)} to {me}. Your clicks and replies in Slack now count
            as you.
          </p>
        </>
      ) : (
        <>
          <h2 className={styles.title}>Link your Slack account</h2>
          {step.kind === "no_code" ? (
            <p className={styles.text}>
              Open this page from the link TeamKit sent you in Slack.
            </p>
          ) : step.kind === "invalid" ? (
            <p className={styles.error}>{INVALID}</p>
          ) : (
            <p className={styles.text}>Checking this link…</p>
          )}
        </>
      )}
      {error ? <p className={styles.error}>{error}</p> : null}

      <h3 className={styles.subhead}>Your linked Slack accounts</h3>
      {links === null ? null : links.length === 0 ? (
        <p className={styles.text}>No Slack account is linked to you.</p>
      ) : (
        <ul className={styles.linkList}>
          {links.map((l) => (
            <li key={l.slackUserId} className={styles.linkRow}>
              <span className={styles.linkName}>
                {l.slackUserName ? `@${l.slackUserName}` : "Slack user"}{" "}
                <code className={styles.mono}>{l.slackUserId}</code>
              </span>
              <button
                type="button"
                className={`tk-button ${styles.unlink}`}
                disabled={busy}
                onClick={() => unlink(l.slackUserId)}
                aria-label={`Unlink Slack ${slackLabel(l)}`}
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
