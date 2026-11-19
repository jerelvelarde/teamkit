import type { Db } from "../../src/db/pool.js";
import { createSlackLinkCode, redeemSlackLinkCode } from "../../src/slack/links.js";
import type { AuthContext } from "../../src/store/actors.js";
import { setRoom } from "../../src/store/rooms.js";
import { billingTeam } from "./team.js";

/** Invented Slack channel ids for the billing rooms. */
export const CHANNEL = { migration: "C0BILLMIG", prod: "C0BILLPRD" } as const;
/** Invented Slack user ids for the billing people. */
export const SLACK_USER = { ana: "U0ANA", ben: "U0BEN", sam: "U0SAM" } as const;

export interface Billing {
  ana: AuthContext;
  ben: AuthContext;
  sam: AuthContext;
  anaAgent: AuthContext & { token: string };
  benAgent: AuthContext & { token: string };
  samAgent: AuthContext & { token: string };
}

/**
 * The billing team (plan 02's billingTeam: ana admin, ben and sam members, their agents in both
 * rooms, sam approves billing-prod), with the rooms linked to Slack channels and the people linked
 * to Slack users unless asked not to.
 */
export async function seedBilling(db: Db, opts: { channels?: boolean; linkSlack?: boolean } = {}): Promise<Billing> {
  const team = await billingTeam(db);
  const b: Billing = {
    ana: team.ana.auth,
    ben: team.ben.auth,
    sam: team.sam.auth,
    anaAgent: { ...team.anaAgent.auth, token: team.anaAgent.token },
    benAgent: { ...team.benAgent.auth, token: team.benAgent.token },
    samAgent: { ...team.samAgent.auth, token: team.samAgent.token },
  };
  if (opts.channels !== false) {
    await setRoom(db, "billing-migration", { slackChannel: CHANNEL.migration });
    await setRoom(db, "billing-prod", { slackChannel: CHANNEL.prod });
  }
  if (opts.linkSlack !== false) {
    for (const who of ["ana", "ben", "sam"] as const) {
      const code = await createSlackLinkCode(db, SLACK_USER[who], { slackUserName: who });
      await redeemSlackLinkCode(db, b[who], code, SLACK_USER[who]);
    }
  }
  return b;
}

/** A request to the test server with a bearer token: POSTs JSON when `body` is given, else GETs. */
export async function api<T = any>(url: string, token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}
