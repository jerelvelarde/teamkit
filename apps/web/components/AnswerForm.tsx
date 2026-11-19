"use client";

import { useEffect, useState } from "react";
import type { RoomView, Task } from "@copilotkit/teamkit-protocol";
import { api, getJson } from "../lib/api";
import { IconSend, StatusIcon } from "./Icons";
import styles from "./thread.module.css";

/** "approve" reads "Approve" on the button; the agent still gets the value it offered. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function errorText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "approval_requires_person") return "Only a listed approver can answer this approval.";
  return err instanceof Error ? err.message : "Could not send the answer.";
}

/** The agent's question as an interactive message: its options are one click each. */
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
    <section className={styles.ask} aria-label="Question">
      <div className={styles.askHead}>
        <StatusIcon state="blocked" size={14} />
        <span className={styles.askKind}>{approval ? "Approval needed" : "Question"}</span>
        <span className={styles.askFrom}>from {block.blockedBy.name}</span>
      </div>
      <p className={styles.askQuestion}>{block.question}</p>
      {approval ? (
        <p className={styles.askMeta}>
          {approvers === undefined
            ? "Approvers: loading"
            : approvers && approvers.length > 0
              ? `Approvers: ${approvers.join(", ")}`
              : "Approvers: any member"}
        </p>
      ) : null}
      {options ? (
        <div className={styles.choices} role="group" aria-label="Choices">
          {options.map((o, i) => (
            <button
              key={o}
              type="button"
              className={`tk-button ${approval && i === 0 ? "tk-button-primary" : ""}`}
              disabled={busy}
              onClick={() => submit({ choice: o })}
            >
              {approval ? sentence(o) : o}
            </button>
          ))}
        </div>
      ) : (
        <form
          className={styles.askForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void submit({ text: text.trim() });
          }}
        >
          <label className="tk-visually-hidden" htmlFor="tk-answer">
            Your answer
          </label>
          <input
            id="tk-answer"
            className={`tk-input ${styles.askInput}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type your answer"
          />
          <button type="submit" className="tk-button tk-button-primary" disabled={busy || text.trim() === ""}>
            <IconSend size={14} />
            {busy ? "Sending…" : "Send answer"}
          </button>
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
