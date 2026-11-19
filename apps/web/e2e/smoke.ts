import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { createClient } from "@copilotkit/teamkit-client";
import type { Permission } from "@copilotkit/teamkit-protocol";
import { createAgent } from "../../server/src/store/actors.js";
import { invitePerson } from "../../server/src/store/people.js";
import { createJoinLink } from "../../server/src/store/join.js";
import { pollDevice, startDevice } from "../../server/src/store/device.js";
import { setRoom } from "../../server/src/store/rooms.js";
import { startTestServer } from "../../server/test/helpers/server.js";

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

const GRANTS: { room: string; perms: Permission[] }[] = [
  { room: "billing-migration", perms: ["read", "post", "claim", "create"] },
  { room: "billing-prod", perms: ["read", "post", "claim", "create"] },
];

async function main(): Promise<void> {
  const srv = await startTestServer();
  let next: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // The invented billing migration: sam (admin) approves billing-prod; ana and ben are members.
    const sam = await invitePerson(srv.db, { name: "sam", role: "admin" });
    const ana = await invitePerson(srv.db, { name: "ana", role: "member" });
    const anaAgent = createClient({
      url: srv.url,
      token: (await createAgent(srv.db, { name: "ana-agent", ownerId: ana.person.id, grants: GRANTS })).token,
    });
    await setRoom(srv.db, "billing-migration", {});
    await setRoom(srv.db, "billing-prod", { approvers: ["sam"] });

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
    mkdirSync(SHOTS_DIR, { recursive: true });

    /** Signs in with a one-time link. The link is spent only on a click, so a scanner cannot use it up. */
    const signIn = async (p: Page, secret: string): Promise<void> => {
      await p.goto(`${base}/signin/${secret}`);
      await p.getByRole("button", { name: "Sign in", exact: true }).waitFor();
      await p.waitForLoadState("networkidle");
      assert(p.url() === `${base}/signin/${secret}`, `the sign-in page waits for a click (now at ${p.url()})`);
      await p.getByRole("button", { name: "Sign in", exact: true }).click();
      await p.waitForURL(`${base}/`);
    };

    // ben joins the team with its join link, then connects ben-agent with a device code.
    const { secret: joinSecret } = await createJoinLink(srv.db, { createdBy: null, domains: ["example.com"] });
    const benPage = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    benPage.setDefaultTimeout(15_000);
    await benPage.goto(`${base}/join/${joinSecret}`);
    await benPage.getByLabel("Name").fill("ben");
    await benPage.getByLabel("Email").fill("ben@example.com");
    await benPage.getByRole("button", { name: "Join", exact: true }).click();
    await benPage.getByText("You're in, ben.").waitFor();
    await benPage.screenshot({ path: `${SHOTS_DIR}/join-390.png`, fullPage: true });
    const d = await startDevice(srv.db, "agent");
    await benPage.goto(`${base}/device?code=${d.userCode}&mode=agent`);
    await benPage.getByRole("checkbox", { name: "billing-migration" }).check();
    await benPage.getByRole("checkbox", { name: "billing-prod" }).check();
    await benPage.getByRole("checkbox", { name: /This code matches the one my agent printed/ }).check();
    await benPage.getByRole("button", { name: "Connect ben-agent" }).click();
    await benPage.getByText("ben-agent is connected").waitFor();
    await benPage.screenshot({ path: `${SHOTS_DIR}/device-agent-390.png`, fullPage: true });
    const polled = await pollDevice(srv.db, d.deviceCode);
    assert(polled.status === "approved" && polled.actor.name === "ben-agent", `the device poll hands out ben-agent (got ${JSON.stringify(polled)})`);
    const benWidth = await benPage.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    assert(benWidth.scrollWidth <= benWidth.innerWidth, `device page at 390px has no horizontal overflow (${benWidth.scrollWidth} > ${benWidth.innerWidth})`);
    const benAgent = createClient({ url: srv.url, token: polled.token });

    const copy = await benAgent.createTask({ room: "billing-migration", brief: "Copy invoices to the new database" });
    const copyClaim = await benAgent.claim(copy.id);
    await benAgent.block(copy.id, copyClaim.claimId, { kind: "needs_input", question: "Which batch size?", options: ["500", "5000"] });

    const writes = await anaAgent.createTask({ room: "billing-prod", brief: "Switch invoice writes to the new database" });
    const writesClaim = await anaAgent.claim(writes.id);
    await anaAgent.block(writes.id, writesClaim.claimId, {
      kind: "awaiting_approval",
      question: "Switch writes now?",
      options: ["approve", "reject"],
      approvers: ["sam"],
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await signIn(page, sam.secret);
    // The sidebar shows the person without a reload: sign-in ends with a full page load.
    const sidebar = page.getByRole("complementary", { name: "Workspace" });
    await sidebar.getByRole("button", { name: "Sign out" }).waitFor();
    const sidebarText = await sidebar.innerText();
    assert(/AG-UI\s+TeamKit/.test(sidebarText), `sidebar reads "AG-UI TeamKit" (got ${JSON.stringify(sidebarText)})`);
    assert(sidebarText.includes("sam"), `sidebar shows the signed-in person (got ${JSON.stringify(sidebarText)})`);

    const blockedCol = page.getByRole("region", { name: "Blocked" });
    const card = blockedCol.locator("a", { hasText: "Copy invoices to the new database" });
    await card.waitFor();
    await card.click();
    await page.waitForURL(`${base}/t/${copy.id}`);
    await page.getByText("Which batch size?").first().waitFor();

    await page.getByRole("button", { name: "500", exact: true }).click();
    // The open task panel shows the task's state as it changes.
    await page.locator('[data-task-state="ready"]').waitFor({ timeout: 10_000 });
    const view = await benAgent.thread(copy.id);
    assert(view.task?.state === "ready", `server state is ready (got ${view.task?.state})`);

    // The ask card names its approver; only sam (or an admin) may answer the approval.
    await page.goto(`${base}/t/${writes.id}?room=billing-prod`);
    const ask = page.getByRole("region", { name: "Question" });
    await ask.getByText("Approvers: sam").waitFor();
    assert(await ask.getByRole("button", { name: "Approve" }).isEnabled(), "sam may approve");
    const anaContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const anaPage = await anaContext.newPage();
    anaPage.setDefaultTimeout(15_000);
    await signIn(anaPage, ana.secret);
    await anaPage.goto(`${base}/t/${writes.id}?room=billing-prod`);
    const anaAsk = anaPage.getByRole("region", { name: "Question" });
    await anaAsk.getByText("Only sam or an admin can answer this.").waitFor();
    assert(await anaAsk.getByRole("button", { name: "Approve" }).isDisabled(), "ana may not approve");
    await anaContext.close();

    // A change logged on a task shows in its thread.
    await benAgent.logChange({
      room: "billing-migration",
      threadId: copy.id,
      what: "Copied invoices 1 to 500 to the new database",
      where: "billing-db-new",
      undo: "Delete the copied rows from billing-db-new",
      undoWhen: "If the row counts differ",
    });
    await page.goto(`${base}/t/${copy.id}?room=billing-migration`);
    const events = page.getByLabel("Events");
    await events.getByText("Copied invoices 1 to 500 to the new database").waitFor();
    await events.getByText("billing-db-new", { exact: true }).waitFor();

    // An answered question is held for the agent that asked; the approval card names its approver.
    await page.goto(`${base}/?room=billing-migration`);
    await page
      .getByRole("region", { name: "Ready" })
      .locator("a", { hasText: "Copy invoices to the new database" })
      .getByText("Held for ben-agent")
      .waitFor();
    await page.goto(`${base}/?room=billing-prod`);
    await page
      .getByRole("region", { name: "Blocked" })
      .locator("a", { hasText: "Switch invoice writes to the new database" })
      .getByText("Waiting on sam")
      .waitFor();

    // A person posts a decision on the board; an agent's ack shows live; the decision's thread lists it.
    const DECISION = "Freeze writes to the old billing database during the copy";
    await page.goto(`${base}/?room=billing-migration`);
    await page.getByRole("navigation", { name: "Room views" }).getByRole("link", { name: "Decisions" }).click();
    await page.waitForURL(`${base}/?room=billing-migration&view=decisions`);
    await page.getByRole("button", { name: "New decision" }).click();
    await page.getByLabel("Decision", { exact: true }).fill(DECISION);
    await page.getByRole("button", { name: "Post decision" }).click();
    const decisionRow = page.getByRole("region", { name: "Decisions" }).getByRole("link").filter({ hasText: DECISION });
    await decisionRow.getByText("No acks yet").waitFor();
    const [decision] = await anaAgent.decisions("billing-migration");
    assert(decision?.text === DECISION && decision.decidedBy.name === "sam", "the decision is sam's");
    await anaAgent.ackDecision(decision.id);
    await decisionRow.getByText("1 ack").waitFor();
    await decisionRow.click();
    await page.waitForURL(`${base}/t/${encodeURIComponent(decision.threadId)}?room=billing-migration&view=decisions`);
    const panel = page.getByRole("complementary", { name: "Task" });
    await panel.getByRole("heading", { name: DECISION }).waitFor();
    await panel.getByText("Acknowledged by ana-agent").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForURL(`${base}/?room=billing-migration&view=decisions`);

    // The change log lists the change with its undo and status.
    await page.getByRole("navigation", { name: "Room views" }).getByRole("link", { name: "Changes" }).click();
    await page.waitForURL(`${base}/?room=billing-migration&view=changes`);
    const changeRow = page
      .getByRole("region", { name: "Changes" })
      .getByRole("link")
      .filter({ hasText: "Copied invoices 1 to 500 to the new database" });
    await changeRow.getByText("Active", { exact: true }).waitFor();
    await changeRow.getByText("Undo: Delete the copied rows from billing-db-new").waitFor();

    // An agent's suspected alert shows on the room; sam confirms it; a person raises one and resolves it for everyone.
    await benAgent.raiseAlert({ room: "billing-prod", text: "Invoice totals differ between the old and new databases" });
    await page.goto(`${base}/?room=billing-prod`);
    const banner = page.getByRole("region", { name: "Alerts" });
    const raised = banner.getByRole("listitem").filter({ hasText: "Invoice totals differ" });
    await raised.getByText("Suspected", { exact: true }).waitFor();
    await raised.getByRole("button", { name: "Confirm" }).click();
    await raised.getByText("Confirmed", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Raise alert" }).click();
    await page.getByLabel("Alert", { exact: true }).fill("The nightly invoice export still reads the old database");
    await page.getByRole("dialog").getByRole("button", { name: "Raise alert" }).click();
    const mine = banner.getByRole("listitem").filter({ hasText: "nightly invoice export" });
    await mine.getByRole("button", { name: "Resolve" }).click();
    await mine.getByText("Resolved by sam").waitFor();
    await mine.waitFor({ state: "detached" });
    const open = await anaAgent.alerts("billing-prod", { open: true });
    assert(open.length === 1 && open[0]!.text.startsWith("Invoice totals differ"), "the resolved alert is closed on the server");
    await page.reload();
    await raised.waitFor();
    assert((await banner.getByText("nightly invoice export").count()) === 0, "a resolved alert stays gone after a reload");

    // An agent's heartbeat shows as a dot on each room it watches and in the room's agents-on list.
    await anaAgent.heartbeat({ watching: ["billing-migration", "billing-prod"], status: "copying invoices" });
    await page.goto(`${base}/?room=billing-migration`);
    const nav = page.getByRole("complementary", { name: "Workspace" });
    await nav.getByRole("link", { name: "billing-prod, 1 agent on" }).waitFor();
    await page.getByRole("button", { name: "1 agent on" }).click();
    const on = page.getByRole("group", { name: "Agents on" });
    await on.getByText("ana-agent").waitFor();
    await on.getByText("copying invoices").waitFor();
    await page.keyboard.press("Escape");

    // A person starts a roll call beside the agents-on list; an agent's answer shows in its thread.
    await page.getByRole("button", { name: "Start roll call" }).click();
    await page.waitForURL(new RegExp(`/t/[^?]+\\?room=billing-migration`));
    const [rollCall] = await anaAgent.rollCalls("billing-migration");
    assert(rollCall?.askedBy.name === "sam", "sam started the roll call");
    await benAgent.answerRollCall(rollCall.id, "on, copying invoices");
    const rcEvents = page.getByLabel("Events");
    await rcEvents.getByText("Roll call by sam").waitFor();
    await rcEvents.getByText("Roll call: ben-agent").waitFor();

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      for (const [name, path] of [
        ["board", "/"],
        ["thread", `/t/${copy.id}`],
      ] as const) {
        await page.goto(`${base}${path}`);
        await page.getByText("Copy invoices to the new database").first().waitFor();
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
