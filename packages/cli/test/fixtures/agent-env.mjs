// Test agent for `teamkit run`: records which credentials it can see, then exits 0.
import { writeFileSync } from "node:fs";

writeFileSync(
  process.env.AGENT_ENV_OUT,
  JSON.stringify({
    admin: process.env.TEAMKIT_ADMIN_TOKEN ?? null,
    extra: process.env.TEAMKIT_ADMIN_EXTRA ?? null,
    token: process.env.TEAMKIT_TOKEN ?? null,
    task: process.env.TEAMKIT_TASK ?? null,
  }),
);
process.exit(0);
