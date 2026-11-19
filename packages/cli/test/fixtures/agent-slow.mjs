// Test agent for `teamkit run`: prints "started", then exits 0 after AGENT_SLOW_MS (default 15000).
// Exits 130 on SIGINT and 143 on SIGTERM, AGENT_EXIT_DELAY_MS (default 0) after the signal.
// AGENT_PID_FILE gets its pid; AGENT_SIGNAL_LOG gets one line per signal it receives.
import { appendFileSync, writeFileSync } from "node:fs";

const onSignal = (signal, code) => () => {
  if (process.env.AGENT_SIGNAL_LOG) appendFileSync(process.env.AGENT_SIGNAL_LOG, `${signal}\n`);
  setTimeout(() => process.exit(code), Number(process.env.AGENT_EXIT_DELAY_MS || 0));
};
process.on("SIGINT", onSignal("SIGINT", 130));
process.on("SIGTERM", onSignal("SIGTERM", 143));
if (process.env.AGENT_PID_FILE) writeFileSync(process.env.AGENT_PID_FILE, String(process.pid));
console.log("started");
setTimeout(() => process.exit(0), Number(process.env.AGENT_SLOW_MS || 15000));
