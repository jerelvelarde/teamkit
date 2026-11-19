import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { registerTaskClaims } from "./task-claims.js";

export function registerTasks(program: Command, ctx: CliContext): void {
  const tasks = program.command("tasks").description("list, create and work on tasks");
  registerTaskClaims(tasks, ctx);
}
