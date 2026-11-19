#!/usr/bin/env node
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/admin.ts");
process.exitCode = await main(process.argv);
