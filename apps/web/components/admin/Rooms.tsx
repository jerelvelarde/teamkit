"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { RoomInfo } from "@copilotkit/teamkit-protocol";
import { adminApi, errorText, SectionHead } from "./People";
import styles from "./admin.module.css";

type Announce = RoomInfo["slackAnnounce"];

function RoomEditor({ room, onSaved, onCancel }: { room: RoomInfo; onSaved: () => void; onCancel: () => void }) {
  const [approvers, setApprovers] = useState((room.approvers ?? []).join(", "));
  const [agent, setAgent] = useState(room.agent ?? "");
  const [channel, setChannel] = useState(room.slackChannel ?? "");
  const [announce, setAnnounce] = useState<Announce>(room.slackAnnounce);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const list = approvers
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a !== "");
      await adminApi.setRoom(room.name, {
        agent: agent.trim() === "" ? null : agent.trim(),
        approvers: list.length === 0 ? null : list,
        slackChannel: channel.trim() === "" ? null : channel.trim(),
        slackAnnounce: announce,
      });
      onSaved();
    } catch (err) {
      setError(errorText(err, "Could not save the room."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={save}>
      <label className={`${styles.field} ${styles.wide}`}>
        <span className={styles.fieldLabel}>Approvers (comma-separated names, empty for any person)</span>
        <input className={`tk-input ${styles.input}`} value={approvers} onChange={(e) => setApprovers(e.target.value)} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Agent</span>
        <input className={`tk-input ${styles.input}`} value={agent} onChange={(e) => setAgent(e.target.value)} />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Slack channel</span>
        <input
          className={`tk-input ${styles.input}`}
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          placeholder="channel id"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Slack announcements</span>
        <select
          className={`tk-input ${styles.select}`}
          value={announce}
          onChange={(e) => setAnnounce(e.target.value as Announce)}
        >
          <option value="blocked">Blocked tasks only</option>
          <option value="all">Every change</option>
          <option value="none">None</option>
        </select>
      </label>
      <div className={`${styles.formActions} ${styles.wide}`}>
        <button type="submit" className={`tk-button ${styles.primary}`} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="tk-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error ? (
        <p className={`${styles.error} ${styles.wide}`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function Rooms() {
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRooms(await adminApi.rooms());
    } catch (err) {
      setError(errorText(err, "Could not load rooms."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const editingRoom = rooms?.find((r) => r.name === editing) ?? null;

  return (
    <section className={`tk-glass ${styles.section}`} aria-label="Room settings">
      <SectionHead>Room settings</SectionHead>

      <div className={styles.tableBox}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Room</th>
              <th>Agent</th>
              <th>Approvers</th>
              <th>Slack</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rooms === null ? (
              <tr>
                <td colSpan={5} className={styles.muted}>
                  Loading…
                </td>
              </tr>
            ) : rooms.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.muted}>
                  No rooms yet.
                </td>
              </tr>
            ) : (
              rooms.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>{r.agent ?? <span className={styles.muted}>none</span>}</td>
                  <td>
                    {r.approvers && r.approvers.length > 0 ? (
                      r.approvers.join(", ")
                    ) : (
                      <span className={styles.muted}>any person</span>
                    )}
                  </td>
                  <td>
                    {r.slackChannel ? (
                      <>
                        <span className={styles.mono}>{r.slackChannel}</span> · {r.slackAnnounce}
                      </>
                    ) : (
                      <span className={styles.muted}>not linked</span>
                    )}
                  </td>
                  <td>
                    <div className={styles.rowActions}>
                      <button type="button" className="tk-button" onClick={() => setEditing(r.name)}>
                        Edit
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editingRoom ? (
        <>
          <SectionHead>{`Edit ${editingRoom.name}`}</SectionHead>
          <RoomEditor
            key={editingRoom.name}
            room={editingRoom}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void load();
            }}
          />
        </>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
