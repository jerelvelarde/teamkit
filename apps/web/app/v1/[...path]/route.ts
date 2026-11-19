import { proxy } from "../../../lib/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ path: string[] }> };

const upstream = () => process.env.TEAMKIT_SERVER_URL || "http://127.0.0.1:8787";

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  return proxy(req, (await ctx.params).path, upstream());
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  return proxy(req, (await ctx.params).path, upstream());
}
