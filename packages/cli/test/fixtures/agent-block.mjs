// Test agent for `teamkit run`: blocks its task on a question through the CLI and exits with the CLI's status.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../../bin/teamkit.mjs", import.meta.url));
const r = spawnSync(
  process.execPath,
  [BIN, "tasks", "block", process.env.TEAMKIT_TASK, "which db?", "--options", "pg,sqlite"],
  { stdio: "inherit", env: process.env },
);
process.exit(r.status ?? 1);
