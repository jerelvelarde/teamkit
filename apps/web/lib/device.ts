import { isValidRoom, type DeviceMode } from "@copilotkit/teamkit-protocol";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { sentence } from "./join";

/** The device page approves an agent only when its URL says exactly `mode=agent`; the server enforces the real mode. */
export function deviceMode(params: { get(name: string): string | null }): DeviceMode {
  return params.get("mode") === "agent" ? "agent" : "admin";
}

/** The picked rooms plus the typed ones (split on commas and spaces, lower-cased), without repeats. */
export function roomsToApprove(checked: readonly string[], typed: string): { rooms: string[]; invalid: string[] } {
  const rooms = [...checked];
  const invalid: string[] = [];
  for (const part of typed.split(/[\s,]+/)) {
    const room = part.trim().toLowerCase();
    if (room === "") continue;
    if (!isValidRoom(room)) invalid.push(room);
    else if (!rooms.includes(room)) rooms.push(room);
  }
  return { rooms, invalid };
}

export function deviceErrorMessage(err: unknown, mode: DeviceMode): string {
  if (err instanceof TeamkitError) {
    if (err.code === "not_found") {
      return `That code is unknown or expired. Run \`teamkit ${mode === "agent" ? "join" : "login"}\` again.`;
    }
    if (err.code === "invalid_input" || err.code === "name_taken") return sentence(err.message);
  }
  return err instanceof Error ? err.message : String(err);
}
