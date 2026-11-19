"use client";

import { useEffect, useState } from "react";
import type { RoomView, Task } from "@copilotkit/teamkit-protocol";
import { api, getJson } from "../lib/api";
import styles from "./thread.module.css";

function errorText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "approval_requires_person") return "Only a listed approver can answer this approval.";
  return err instanceof Error ? err.message : "Could not send the answer.";
}

export function AnswerForm({ task, onAnswered }: { task: Task; onAnswered(): void }) {
  const block = task.block;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvers, setApprovers] = useState<string[] | null | undefined>(undefined);
  const approval = block?.kind === "awaiting_approval";

  useEffect(() => {
    if (!approval) return;
    let live = true;
    getJson<RoomView>("/v1/room?name=" + encodeURIComponent(task.room)).then(
      (r) => live && setApprovers(r.room.approvers),
      () => live && setApprovers(undefined),
    );
    return () => {
      live = false;
    };
  }, [approval, task.room]);

  if (!block) return null;
  const options = block.options && block.options.length > 0 ? block.options : null;

  async function submit(input: { text?: string; choice?: string }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.answer(task.id, input);
      setText("");
      onAnswered();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`tk-glass ${styles.answer}`} aria-label="Question">
      <div className={styles.answerHead}>
        <span className={styles.label}>{approval ? "Approval needed" : "Question"}</span>
        {approval ? <span className={`${styles.statusPill} ${styles.toneWarning}`}>needs a person</span> : null}
      </div>
      <p className={styles.question}>{block.question}</p>
      {approval ? (
        <p className={styles.muted}>
          {approvers === undefined
            ? "Approvers: loading"
            : approvers && approvers.length > 0
              ? `Approvers: ${approvers.join(", ")}`
              : "Approvers: any member"}
        </p>
      ) : null}
      {options ? (
        <div className={styles.choices} role="group" aria-label="Choices">
          {options.map((o) => (
            <button key={o} type="button" className="tk-button" disabled={busy} onClick={() => submit({ choice: o })}>
              {o}
            </button>
          ))}
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void submit({ text: text.trim() });
          }}
        >
          <label className={styles.label} htmlFor="tk-answer">
            Your answer
          </label>
          <textarea
            id="tk-answer"
            className={`tk-input ${styles.textarea}`}
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className={styles.actions}>
            <button type="submit" className="tk-button" disabled={busy || text.trim() === ""}>
              {busy ? "Sending…" : "Send answer"}
            </button>
          </div>
        </form>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
