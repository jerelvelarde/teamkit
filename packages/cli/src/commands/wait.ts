import type { Command } from "commander";
import { EVENT_KINDS, type BoardEvent, type EventKind } from "@copilotkit/teamkit-protocol";
import { collect, clientFor, globalOpts, type CliContext } from "../context.js";
import { parseDuration, parseLabels } from "../args.js";
import { CliExit, UsageError } from "../errors.js";
import { formatEvent } from "../format.js";

interface WaitOpts {
  kind?: string[];
  label?: string[];
  after?: string;
  timeout?: string;
}

export function registerWait(program: Command, ctx: CliContext): void {
  program
    .command("wait")
    .description("wait for the next matching event on a room or thread")
    .argument("<target>", "room name (trailing / includes subrooms) or thread id (th_...)")
    .option("--kind <k>", "event kind to match (repeatable)", collect)
    .option("--label <k=v>", "thread label to match (repeatable)", collect)
    .option("--after <cursor>", "resume after this cursor instead of tailing live")
    .option("--timeout <duration>", "give up after this long (exit 3)")
    .action(async (target: string, opts: WaitOpts, cmd: Command) => {
      const kinds = (opts.kind ?? []).map((k) => {
        if (!(EVENT_KINDS as readonly string[]).includes(k)) {
          throw new UsageError(`unknown event kind: ${k} (expected one of ${EVENT_KINDS.join(", ")})`);
        }
        return k as EventKind;
      });
      const labels = parseLabels(opts.label);
      const timeoutMs = opts.timeout === undefined ? undefined : parseDuration(opts.timeout);
      const { json } = globalOpts(cmd);
      const client = clientFor(cmd, ctx);

      const labelCache = new Map<string, Record<string, string>>();
      const matches = async (e: BoardEvent): Promise<boolean> => {
        if (!labels) return true;
        if (e.threadId === null) return false;
        let have = labelCache.get(e.threadId);
        if (!have) {
          have = (await client.thread(e.threadId)).thread.labels;
          labelCache.set(e.threadId, have);
        }
        return Object.entries(labels).every(([k, v]) => have[k] === v);
      };

      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      // Race the read against the timeout so a parked stream read can never hold the wait open.
      const timedOut = new Promise<"timeout">((resolve) => {
        if (timeoutMs !== undefined) timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const stream = client.stream(
        {
          ...(target.startsWith("th_") ? { thread: target } : { room: target }),
          ...(kinds.length > 0 ? { kinds } : {}),
          ...(opts.after !== undefined ? { after: opts.after } : {}),
        },
        { signal: controller.signal },
      );
      const iterator = stream[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = iterator.next();
          next.catch(() => {}); // a read abandoned on timeout may still reject after abort
          const r = await Promise.race([next, timedOut]);
          if (r === "timeout") throw new CliExit(3, "timed out");
          if (r.done) throw new CliExit(1, "error: event stream ended");
          if (await matches(r.value)) {
            ctx.out(json ? JSON.stringify(r.value) : formatEvent(r.value));
            return;
          }
        }
      } finally {
        clearTimeout(timer);
        controller.abort();
        // Do not await: closing a parked generator can block until its read settles.
        Promise.resolve(iterator.return?.()).catch(() => {});
      }
    });
}
