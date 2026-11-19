export interface SseFrame {
  id?: string;
  event: string;
  data: string;
}

export async function* parseSse(
  source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder("utf-8");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  if (typeof (source as ReadableStream<Uint8Array>).getReader === "function") {
    reader = (source as ReadableStream<Uint8Array>).getReader();
  } else {
    iterator = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  }

  // Tells the source to stop without waiting for it: an async generator parked in
  // next() only runs return() once that next() settles. Errors from stopping are
  // irrelevant here.
  const stopSource = () => {
    if (reader) {
      reader.cancel().catch(() => {});
      return;
    }
    try {
      if (iterator?.return) Promise.resolve(iterator.return()).catch(() => {});
    } catch {
      // ignore
    }
  };

  if (signal?.aborted) {
    stopSource();
    reader?.releaseLock();
    return;
  }

  let aborted = false;
  // Set while a read is pending; abort resolves it so the read is abandoned
  // rather than awaited.
  let abandonRead: (() => void) | undefined;
  const onAbort = () => {
    aborted = true;
    abandonRead?.();
    stopSource();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const read = async (): Promise<IteratorResult<Uint8Array> | undefined> => {
    const next = reader ? reader.read() : iterator!.next();
    if (!signal) return next;
    // A rejection after the read was abandoned has no one to report to.
    next.catch(() => {});
    try {
      return await new Promise<IteratorResult<Uint8Array> | undefined>((resolve, reject) => {
        abandonRead = () => resolve(undefined);
        next.then(resolve, reject);
      });
    } finally {
      abandonRead = undefined;
    }
  };

  let buffer = "";
  let pendingCr = false; // previous chunk ended with \r; swallow a following \n
  let id: string | undefined;
  let event = "";
  let data: string[] = [];
  let hasData = false;

  const frames: SseFrame[] = [];

  const handleLine = (line: string) => {
    if (line === "") {
      if (hasData) {
        const frame: SseFrame = { event: event || "message", data: data.join("\n") };
        if (id !== undefined) frame.id = id;
        frames.push(frame);
      }
      data = [];
      hasData = false;
      event = "";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      data.push(value);
      hasData = true;
    } else if (field === "id") {
      id = value;
    } else if (field === "event") {
      event = value;
    }
  };

  const feed = (text: string) => {
    // An empty chunk (e.g. half of a multi-byte character) must not clear pendingCr.
    if (pendingCr && text.length > 0) {
      if (text[0] === "\n") text = text.slice(1);
      pendingCr = false;
    }
    buffer += text;
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch === "\n" || ch === "\r") {
        handleLine(buffer.slice(start, i));
        if (ch === "\r") {
          if (i + 1 < buffer.length) {
            if (buffer[i + 1] === "\n") i++;
          } else {
            pendingCr = true;
          }
        }
        start = i + 1;
      }
    }
    buffer = buffer.slice(start);
  };

  try {
    while (!aborted) {
      const r = await read();
      if (aborted || r === undefined || r.done) break;
      feed(decoder.decode(r.value, { stream: true }));
      while (frames.length > 0) {
        yield frames.shift()!;
        if (aborted) return;
      }
    }
  } catch (err) {
    if (!aborted) throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (reader) {
      try {
        if (!aborted) await reader.cancel();
        reader.releaseLock();
      } catch {
        // already released or cancelled
      }
    } else if (iterator?.return && !aborted) {
      try {
        await iterator.return();
      } catch {
        // ignore
      }
    }
  }
  // End of input: any incomplete frame is dropped.
}
