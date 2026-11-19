// Swarm test agent: reads its task, replies twice, blocks on a question when the brief asks for one and nobody has
// answered yet, and otherwise completes the task itself, as a real agent should.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = new URL("../../bin/teamkit.mjs", import.meta.url);
const { TEAMKIT_TASK: task, TEAMKIT_URL: url, TEAMKIT_TOKEN: token } = process.env;

function cli(args) {
  const r = spawnSync(process.execPath, [fileURLToPath(BIN), ...args], { env: process.env, encoding: "utf8" });
  if (r.status !== 0) {
    process.stderr.write(`teamkit ${args.join(" ")} exited ${r.status}: ${r.stderr}\n`);
    process.exit(1);
  }
  return r.stdout;
}

const view = JSON.parse(cli(["read", task, "--json"]));
cli(["reply", task, "Plan: do the work in two steps."]);
cli(["reply", task, "Step one done."]);

const res = await fetch(`${url}/v1/events?thread=${encodeURIComponent(view.thread.id)}&kind=task.answered`, {
  headers: { authorization: `Bearer ${token}` },
});
if (!res.ok) {
  process.stderr.write(`events query failed: ${res.status}\n`);
  process.exit(1);
}
const answered = (await res.json()).events.length > 0;

if (view.task.brief.includes("[ask]") && !answered) {
  cli(["tasks", "block", task, "which db?", "--options", "pg,sqlite"]);
} else {
  cli(["tasks", "complete", task, "Did the brief in two steps."]);
}
process.exit(0);
