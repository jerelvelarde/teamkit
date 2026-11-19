"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { RoomSummary } from "@copilotkit/teamkit-protocol";
import { api } from "../lib/api";
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

export function NewTaskForm({
  rooms,
  selected,
  onCreated,
}: {
  rooms: RoomSummary[];
  selected: string;
  onCreated: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [room, setRoom] = useState(selected === "*" ? "" : selected);
  const [brief, setBrief] = useState("");
  const [labels, setLabels] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (selected !== "*") setRoom(selected);
  }, [selected]);

  async function submit(e: FormEvent) {
    e.preventDefault();
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
      setOpen(false);
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the task.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className={styles.formClosed}>
        <button type="button" className="tk-button" onClick={() => setOpen(true)}>
          New task
        </button>
      </div>
    );
  }

  return (
    <form className={`tk-glass ${styles.form}`} onSubmit={submit}>
      <div className={styles.columnHead}>
        <span className={styles.columnTitle}>New task</span>
        <div className={styles.line} />
      </div>
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Room</span>
          <input
            className={`tk-input ${styles.formInput}`}
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
            className={`tk-input ${styles.formInput}`}
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="k=v, k=v"
          />
        </label>
        <label className={`${styles.field} ${styles.fieldWide}`}>
          <span className={styles.fieldLabel}>Brief</span>
          <textarea
            className={styles.textarea}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder="What should an agent do?"
          />
        </label>
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.formActions}>
        <button type="submit" className={`tk-button ${styles.primary}`} disabled={busy}>
          {busy ? "Creating…" : "Create task"}
        </button>
        <button type="button" className="tk-button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
