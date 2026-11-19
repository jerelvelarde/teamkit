// Test agent for `teamkit run`: prints "started", then exits 0 after AGENT_SLOW_MS (default 60000).
// Exits 130 on SIGINT and 143 on SIGTERM.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
console.log("started");
setTimeout(() => process.exit(0), Number(process.env.AGENT_SLOW_MS || 60000));
