#!/usr/bin/env node
import { register } from "tsx/esm/api"; register();
const { main } = await import("../src/index.ts");
process.exitCode = await main(process.argv);
setTimeout(() => process.exit(), 2000).unref();
