import {
  agentAppLabel,
  isAgentApp,
  isValidRoom,
  personAgentName,
  type AgentApp,
  type DeviceMode,
} from "@copilotkit/teamkit-protocol";
import { TeamkitError } from "@copilotkit/teamkit-client";
import { sentence } from "./join";

/** The device page approves an agent only when its URL says exactly `mode=agent`; the server enforces the real mode. */
export function deviceMode(params: { get(name: string): string | null }): DeviceMode {
  return params.get("mode") === "agent" ? "agent" : "admin";
}

/**
 * The app the device page's URL names (`&app=codex`), or null for none or one it does not know.
 * It only changes what the page says: the code itself carries the app the server names the agent after.
 */
export function deviceApp(params: { get(name: string): string | null }): AgentApp | null {
  const app = params.get("app");
  return isAgentApp(app) ? app : null;
}

export interface AgentDeviceText {
  title: string;
  lead: string;
  /** The agent the approval connects, as the page shows it before the server answers. */
  agent: string;
}

const AGENT_CAN = "It can read, post, claim and create tasks in the rooms you pick.";

/** What the agent-mode device page says for `person` (null before the page knows who is signed in). */
export function agentDeviceText(person: string | null, app: AgentApp | null): AgentDeviceText {
  if (app === null) {
    const agent = person === null ? "your agent" : personAgentName(person);
    return { title: "Connect your agent", lead: `This signs in ${agent}, an agent that belongs to you. ${AGENT_CAN}`, agent };
  }
  const label = agentAppLabel(app);
  const agent = person === null ? `your ${label} agent` : personAgentName(person, app);
  return { title: `Connect your ${label}`, lead: `Your agent will be ${agent}, an agent that belongs to you. ${AGENT_CAN}`, agent };
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
