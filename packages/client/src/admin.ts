import type {
  CreatedToken,
  GrantSpec,
  Invite,
  PersonInfo,
  RoomInfo,
  RoomSettingsInput,
  TokenInfo,
  Whoami,
} from "@copilotkit/teamkit-protocol";
import { DEFAULT_TIMEOUT_MS, TeamkitError, toError, type ClientOptions } from "./client.js";

export interface AdminClient {
  whoami(): Promise<Whoami>;
  people(): Promise<PersonInfo[]>;
  /** Needs an admin signed in on the web board (cookie mode); an admin-scope token gets 403. */
  invitePerson(input: { name: string; role?: "admin" | "member" }): Promise<Invite>;
  /** Needs an admin signed in on the web board (cookie mode); an admin-scope token gets 403. */
  personLink(name: string): Promise<{ link: string }>;
  tokens(): Promise<TokenInfo[]>;
  createTokens(input: { name: string; rooms: GrantSpec[]; count?: number }): Promise<CreatedToken[]>;
  revokeToken(id: string): Promise<void>;
  rooms(): Promise<RoomInfo[]>;
  setRoom(name: string, settings: RoomSettingsInput): Promise<RoomInfo>;
  logout(): Promise<void>;
}

export function createAdminClient(opts: ClientOptions): AdminClient {
  const base = `${opts.url.replace(/\/+$/, "")}/v1`;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const enc = encodeURIComponent;

  async function json<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const timer = timeoutMs > 0 && Number.isFinite(timeoutMs) ? AbortSignal.timeout(timeoutMs) : undefined;
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timer,
      });
      if (!res.ok) throw await toError(res);
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new TeamkitError("http_error", res.status, text);
      }
    } catch (e) {
      const serverCode = e instanceof TeamkitError && e.code !== "http_error";
      if (timer?.aborted && !serverCode) {
        throw new TeamkitError("timeout", 0, `${method} ${path} got no response within ${timeoutMs} ms`);
      }
      throw e;
    }
  }

  return {
    whoami: () => json("GET", "/whoami"),
    people: () => json("GET", "/admin/people"),
    invitePerson: (input) => json("POST", "/admin/people", input),
    personLink: (name) => json("POST", `/admin/people/${enc(name)}/link`, {}),
    tokens: () => json("GET", "/admin/tokens"),
    createTokens: async (input) => (await json<{ tokens: CreatedToken[] }>("POST", "/admin/tokens", input)).tokens,
    revokeToken: async (id) => {
      await json("POST", `/admin/tokens/${enc(id)}/revoke`, {});
    },
    rooms: () => json("GET", "/admin/rooms"),
    setRoom: (name, settings) => json("POST", `/admin/rooms/${enc(name)}`, settings),
    logout: async () => {
      await json("POST", "/logout", {});
    },
  };
}
