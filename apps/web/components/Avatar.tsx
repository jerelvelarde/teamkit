import styles from "./avatar.module.css";

const HUES = [262, 210, 168, 28, 330, 192, 12, 128];

function hueFor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length]!;
}

/** "builder-2" reads B2, "support-bot" SB, "maya" M. */
export function initials(name: string): string {
  const parts = name.split(/[\s\-_./]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0]!.toUpperCase();
  const last = parts.length > 1 ? parts[parts.length - 1]! : "";
  if (/^\d+$/.test(last)) return first + last.slice(0, 1);
  return last ? first + last[0]!.toUpperCase() : first;
}

/**
 * People are circles and agents are rounded squares, as Slack draws people and apps.
 * `live` puts a pulse on an agent that is working the task right now.
 */
export function Avatar({
  name,
  kind,
  size = 20,
  live = false,
  title,
}: {
  name: string;
  kind: "agent" | "person";
  size?: number;
  live?: boolean;
  title?: string;
}) {
  return (
    <span
      className={styles.avatar}
      data-kind={kind}
      data-live={live || undefined}
      style={{ ["--h" as string]: hueFor(name), ["--s" as string]: `${size}px` }}
      title={title ?? name}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
