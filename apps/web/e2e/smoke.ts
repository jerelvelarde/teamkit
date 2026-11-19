import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createClient } from "@copilotkit/teamkit-client";
import { invitePerson } from "../../server/src/store/people.js";
import { agentToken, startTestServer } from "../../server/test/helpers/server.js";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const SHOTS_DIR = fileURLToPath(new URL("../../../.tmp/smoke", import.meta.url));
// NEXT_DIST_DIR lets two smoke runs share the checkout without sharing a build directory.
const DIST_DIR = process.env.NEXT_DIST_DIR || ".next-smoke";
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`smoke assertion failed: ${message}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: WEB_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${out}`))));
  });
}

async function waitForHttp(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(250);
  }
  throw new Error(`GET ${url} did not return 200 within ${ms} ms (${last})`);
}

function killTree(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function main(): Promise<void> {
  const srv = await startTestServer();
  let next: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const { secret } = await invitePerson(srv.db, { name: "ada", role: "admin" });

    const worker = createClient({
      url: srv.url,
      token: await agentToken(srv.db, "worker", [{ room: "build", perms: ["read", "post", "claim", "create"] }]),
    });
    const task = await worker.createTask({ room: "build", brief: "Pick a database" });
    const claim = await worker.claim(task.id);
    await worker.block(task.id, claim.claimId, {
      kind: "needs_input",
      question: "Which database?",
      options: ["pg", "sqlite"],
    });

    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", NEXT_DIST_DIR: DIST_DIR, TEAMKIT_SERVER_URL: srv.url };
    const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));
    if (process.env.SMOKE_SKIP_BUILD !== "1") {
      await run(process.execPath, [nextBin, "build"], env);
    }
    const webPort = await freePort();
    const base = `http://127.0.0.1:${webPort}`;
    next = spawn(process.execPath, [nextBin, "start", "-p", String(webPort), "-H", "127.0.0.1"], {
      cwd: WEB_DIR,
      env,
      stdio: "ignore",
      detached: true,
    });
    let nextExit: number | null | undefined;
    next.once("exit", (code) => (nextExit = code));
    await Promise.race([
      waitForHttp(`${base}/`, 60_000),
      (async () => {
        while (nextExit === undefined) await sleep(200);
        throw new Error(`next start exited early with code ${nextExit}`);
      })(),
    ]);

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    // The sign-in link is spent only on a click, so a link scanner that runs scripts cannot use it up.
    await page.goto(`${base}/signin/${secret}`);
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    assert(page.url() === `${base}/signin/${secret}`, `the sign-in page waits for a click (now at ${page.url()})`);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`${base}/`);
    // The header shows the person without a reload: sign-in ends with a full page load.
    await page.locator("header").getByRole("button", { name: "Sign out" }).waitFor();
    const headerText = await page.locator("header").innerText();
    assert(/AG-UI\s+TeamKit/.test(headerText), `header reads "AG-UI TeamKit" (got ${JSON.stringify(headerText)})`);
    assert(headerText.includes("ada"), `header shows the signed-in person (got ${JSON.stringify(headerText)})`);

    const blockedCol = page.getByRole("region", { name: "Blocked" });
    const card = blockedCol.locator("a", { hasText: "Pick a database" });
    await card.waitFor();
    await card.click();
    await page.waitForURL(`${base}/t/${task.id}`);
    await page.getByText("Which database?").first().waitFor();

    await page.getByRole("button", { name: "pg", exact: true }).click();
    await page.waitForFunction(
      () => [...document.querySelectorAll("span")].some((s) => s.textContent === "ready"),
      undefined,
      { timeout: 10_000 },
    );
    const view = await worker.thread(task.id);
    assert(view.task?.state === "ready", `server state is ready (got ${view.task?.state})`);

    mkdirSync(SHOTS_DIR, { recursive: true });
    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      for (const [name, path] of [
        ["board", "/"],
        ["thread", `/t/${task.id}`],
      ] as const) {
        await page.goto(`${base}${path}`);
        await page.getByText("Pick a database").first().waitFor();
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: `${SHOTS_DIR}/${name}-${vp.width}.png`, fullPage: true });
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        assert(scrollWidth <= innerWidth, `${name} at ${vp.width}px has no horizontal overflow (${scrollWidth} > ${innerWidth})`);
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    killTree(next);
    await srv.stop();
  }
}

main().then(
  () => {
    console.log("smoke ok");
    process.exit(0);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
