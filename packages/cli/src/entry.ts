import { checkNodeVersion } from "./node-version.js";

// Checked before anything else loads, so an old Node gets one clear line instead of a syntax error.
const problem = checkNodeVersion(process.versions.node);
if (problem !== null) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
const { main } = await import("./index.js");
process.exitCode = await main(process.argv);
setTimeout(() => process.exit(), 2000).unref();
