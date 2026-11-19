import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const serverDir = fileURLToPath(new URL("../..", import.meta.url));
const PROBE_TIMEOUT_MS = 60_000;

/** Off-thread hooks for Node without `module.registerHooks`: report each specifier to the main thread. */
const ASYNC_HOOKS = `
let port;
export async function initialize(data) { port = data.port; }
export async function resolve(specifier, context, next) {
  port.postMessage(specifier);
  return next(specifier, context);
}
`;

/*
 * The probe records specifiers as the importing source wrote them ("./handlers.js",
 * "@copilotkit/channels"). Hooks run last-registered first, so they must sit ahead of tsx's.
 * On Node with `module.registerHooks` (22.15+), tsx installs in-thread hooks, which run before
 * any off-thread `module.register` hook and rewrite "./x.js" to "./x.ts" on the way. So the probe
 * uses `registerHooks` there, and `module.register` with a MessageChannel only on older Node,
 * where tsx registers off-thread too.
 */
function probeScript(entryUrl: string): string {
  return `
import * as mod from "node:module";
import { MessageChannel } from "node:worker_threads";
const seen = [];
let settle = async () => {};
if (typeof mod.registerHooks === "function") {
  mod.registerHooks({
    resolve(specifier, context, next) {
      seen.push(specifier);
      return next(specifier, context);
    },
  });
} else {
  const { port1, port2 } = new MessageChannel();
  port1.on("message", (s) => seen.push(s));
  port1.unref();
  mod.register("data:text/javascript," + encodeURIComponent(${JSON.stringify(ASYNC_HOOKS)}), {
    data: { port: port2 },
    transferList: [port2],
  });
  settle = () => new Promise((r) => setTimeout(r, 50));
}
await import(${JSON.stringify(entryUrl)});
await settle();
process.stdout.write(JSON.stringify(seen), () => process.exit(0));
`;
}

/**
 * Every module specifier a fresh Node process (with tsx) resolves while importing `entry`,
 * an absolute path. Lets a test prove that importing a module does not load a heavy package.
 */
export async function loadedSpecifiers(entry: string): Promise<string[]> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", probeScript(pathToFileURL(entry).href)],
    { cwd: serverDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`module probe for ${entry} timed out after ${PROBE_TIMEOUT_MS} ms: ${err}`));
    }, PROBE_TIMEOUT_MS);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  if (code !== 0) throw new Error(`module probe for ${entry} exited ${code}: ${err}`);
  const parsed: unknown = JSON.parse(out);
  if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === "string")) {
    throw new Error(`module probe for ${entry} printed unexpected output: ${out.slice(0, 200)}`);
  }
  return parsed;
}
