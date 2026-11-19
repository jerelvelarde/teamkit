import { MAX_BODY_BYTES } from "@copilotkit/teamkit-protocol";

const FORWARDED_REQUEST_HEADERS = ["authorization", "cookie", "content-type", "accept", "last-event-id"];

// Hop-by-hop headers (RFC 9110 section 7.6.1) plus the framing headers that
// no longer describe the body once it is re-streamed.
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "set-cookie",
]);

function badGateway(): Response {
  return new Response(
    JSON.stringify({ error: { code: "bad_gateway", message: "teamkit-server is unreachable" } }),
    { status: 502, headers: { "content-type": "application/json" } },
  );
}

function tooLarge(): Response {
  return new Response(
    JSON.stringify({ error: { code: "too_large", message: "request body too large" } }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

/**
 * Passes the body through chunk by chunk and errors the stream once more than
 * `max` bytes have gone by, so a body with no Content-Length (chunked) is capped too.
 */
function capped(body: ReadableStream<Uint8Array>, max: number, onOver: () => void): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          onOver();
          controller.error(new Error("request body too large"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export async function proxy(req: Request, path: string[], upstream: string): Promise<Response> {
  const target = `${upstream.replace(/\/+$/, "")}/v1/${path.map(encodeURIComponent).join("/")}${new URL(req.url).search}`;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  // The body is streamed to the server, never buffered here: one large upload must not
  // grow this process. A declared length over the limit is refused before reading a byte.
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (hasBody && !(declared <= MAX_BODY_BYTES)) return tooLarge();
  let over = false;
  const body = hasBody ? capped(req.body!, MAX_BODY_BYTES, () => (over = true)) : undefined;

  let res: Response;
  try {
    // `duplex: "half"` is required to send a stream body; the DOM RequestInit type lacks it.
    res = await fetch(target, {
      method: req.method,
      headers,
      body,
      duplex: "half",
      redirect: "manual",
      signal: req.signal,
    } as RequestInit);
  } catch {
    if (over) return tooLarge();
    // The browser went away: nobody is left to read a response.
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return badGateway();
  }

  // Also drop anything the upstream named in its Connection header.
  const dropped = new Set(DROPPED_RESPONSE_HEADERS);
  for (const token of (res.headers.get("connection") ?? "").split(",")) {
    const name = token.trim().toLowerCase();
    if (name) dropped.add(name);
  }

  const out = new Headers();
  res.headers.forEach((value, name) => {
    if (!dropped.has(name.toLowerCase())) out.set(name, value);
  });
  for (const cookie of res.headers.getSetCookie()) out.append("set-cookie", cookie);

  if ((res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  }

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}
