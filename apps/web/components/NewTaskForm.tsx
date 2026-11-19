"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import type { RoomSummary } from "@copilotkit/teamkit-protocol";
import { api } from "../lib/api";
import { IconX } from "./Icons";
import styles from "./board.module.css";

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const part of text.split(",")) {
    const piece = part.trim();
    if (piece === "") continue;
    const eq = piece.indexOf("=");
    if (eq <= 0 || eq === piece.length - 1) {
      throw new Error(`Label "${piece}" should look like key=value.`);
    }
    labels[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  return labels;
}

/** Linear's "new issue" dialog: brief first, room and labels underneath, ⌘↵ creates. */
export function NewTaskForm({
  open,
  onClose,
  rooms,
  selected,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  rooms: RoomSummary[];
  selected: string;
  onCreated: () => void | Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [room, setRoom] = useState(selected === "*" ? "" : selected);
  const [brief, setBrief] = useState("");
  const [labels, setLabels] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (selected !== "*") setRoom(selected);
  }, [selected]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setError(null);
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    if (room.trim() === "") return setError("Pick a room for the task.");
    if (brief.trim() === "") return setError("Write a brief for the task.");
    setBusy(true);
    try {
      const parsed = parseLabels(labels);
      await api.createTask({
        room: room.trim(),
        brief: brief.trim(),
        ...(Object.keys(parsed).length > 0 ? { labels: parsed } : {}),
      });
      setBrief("");
      setLabels("");
      onClose();
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the task.");
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="tk-new-task-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <form className={styles.dialogForm} onSubmit={submit} onKeyDown={onKeyDown}>
        <div className={styles.dialogHead}>
          <h2 id="tk-new-task-title" className={styles.dialogTitle}>
            New task
          </h2>
          <button type="button" className="tk-button tk-button-ghost tk-icon-button" aria-label="Close" onClick={onClose}>
            <IconX />
          </button>
        </div>

        <label className="tk-visually-hidden" htmlFor="tk-new-brief">
          Brief
        </label>
        <textarea
          id="tk-new-brief"
          className={styles.briefInput}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={4}
          placeholder="What should an agent do?"
          autoFocus
        />

        <div className={styles.dialogFields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Room</span>
            <input
              className="tk-input"
              list="tk-room-options"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="room name"
            />
            <datalist id="tk-room-options">
              {rooms.map((r) => (
                <option key={r.name} value={r.name} />
              ))}
            </datalist>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Labels</span>
            <input
              className="tk-input"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="key=value, key=value"
            />
          </label>
        </div>

        {error ? (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.dialogActions}>
          <span className={styles.dialogHint}>
            <kbd>⌘</kbd>
            <kbd>↵</kbd> to create
          </span>
          <button type="button" className="tk-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="tk-button tk-button-primary" disabled={busy}>
            {busy ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
