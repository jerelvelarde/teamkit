import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createClient, type TeamkitClient } from "@copilotkit/teamkit-client";
import { startTestServer } from "../../../../apps/server/test/helpers/server.js";
import { billingTeam, type BillingTeam } from "../../../../apps/server/test/helpers/team.js";
import { createLeases, type Leases } from "../../src/mcp/leases.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createSession } from "../../src/mcp/session.js";

export interface McpTeam {
  srv: Awaited<ReturnType<typeof startTestServer>>;
  team: BillingTeam;
  anaToken: string;
  benToken: string;
  /** Clients with the agents' tokens, for checking server state. */
  anaClient: TeamkitClient;
  benClient: TeamkitClient;
}

/** A test server with the billing team (plan 02's billingTeam). */
export async function mcpTeam(): Promise<McpTeam> {
  const srv = await startTestServer();
  const team = await billingTeam(srv.db);
  return {
    srv,
    team,
    anaToken: team.anaAgent.token,
    benToken: team.benAgent.token,
    anaClient: createClient({ url: srv.url, token: team.anaAgent.token }),
    benClient: createClient({ url: srv.url, token: team.benAgent.token }),
  };
}

export interface McpHandle {
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  names(): Promise<string[]>;
  instructions(): string | undefined;
  /** Every tool text this handle has seen, in order. */
  transcript: string[];
  leases: Leases;
  close(): Promise<void>;
}

/** An MCP client linked in memory to a TeamKit MCP server that reads its login from `env`. */
export async function connectMcp(env: NodeJS.ProcessEnv): Promise<McpHandle> {
  const session = createSession({ env });
  const leases = createLeases(env);
  const server = createMcpServer({ session, leases }, { version: "test" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "teamkit-test", version: "test" });
  await client.connect(clientSide);
  const transcript: string[] = [];
  return {
    async call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { type: string; text?: string }[])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      transcript.push(text);
      return { text, isError: r.isError === true };
    },
    async names() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    instructions: () => client.getInstructions(),
    transcript,
    leases,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
