import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { TASK_STATES, type PlanItem, type TaskState } from "@copilotkit/teamkit-protocol";
import { parseLabels } from "../args.js";
import { clientFor, collect, globalOpts, type CliContext } from "../context.js";
import { UsageError } from "../errors.js";
import { formatTaskList } from "../format.js";
import { registerTaskClaims } from "./task-claims.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseState(s: string | undefined): TaskState | "all" | undefined {
  if (s === undefined || s === "all") return s;
  if ((TASK_STATES as readonly string[]).includes(s)) return s as TaskState;
  throw new UsageError(`invalid state: ${s} (expected ${[...TASK_STATES, "all"].join("|")})`);
}

function parseItem(raw: unknown, index: number): PlanItem {
  const where = `plan item ${index}`;
  if (!isRecord(raw)) throw new UsageError(`${where} must be an object`);
  const { key, text, labels, needs, target } = raw;
  if (typeof key !== "string" || key === "") throw new UsageError(`${where}: "key" must be a non-empty string`);
  if (typeof text !== "string") throw new UsageError(`${where}: "text" must be a string`);
  const item: PlanItem = { key, text };
  if (labels !== undefined) {
    if (!isRecord(labels) || !Object.values(labels).every((v) => typeof v === "string")) {
      throw new UsageError(`${where}: "labels" must be an object of strings`);
    }
    item.labels = labels as Record<string, string>;
  }
  if (needs !== undefined) {
    if (!Array.isArray(needs) || !needs.every((n) => typeof n === "string")) {
      throw new UsageError(`${where}: "needs" must be an array of strings`);
    }
    item.needs = (needs as string[]).map((n) => (n.startsWith("th_") ? { id: n } : { key: n }));
  }
  if (target !== undefined) {
    if (typeof target !== "string") throw new UsageError(`${where}: "target" must be a string`);
    item.target = target;
  }
  return item;
}

function readPlan(file: string): PlanItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read plan file ${file}: ${(e as Error).message}`);
  }
  const list = isRecord(parsed) ? parsed.tasks : parsed;
  if (!Array.isArray(list)) throw new UsageError(`plan file ${file} must be a JSON array or {"tasks": [...]}`);
  return list.map(parseItem);
}

export function registerTasks(program: Command, ctx: CliContext): void {
  const tasks = program
    .command("tasks")
    .description("list, create and work on tasks");

  // The parent declares no options of its own: commander gives an option written after a subcommand to the
  // parent when both declare it, so list is the default subcommand and owns --state/--label.
  tasks
    .command("list", { isDefault: true })
    .description("list tasks (the default: `tasks [room]`)")
    .argument("[room]", "only tasks in this room")
    .option("--state <s>", "task state, or all")
    .option("--label <k=v>", "label filter (repeatable)", collect)
    .action(async (room: string | undefined, opts: { state?: string; label?: string[] }, cmd: Command) => {
      const state = parseState(opts.state);
      const labels = parseLabels(opts.label);
      const list = await clientFor(cmd, ctx).tasks({ room, state, labels });
      ctx.out(globalOpts(cmd).json ? JSON.stringify(list) : formatTaskList(list));
    });

  tasks
    .command("create")
    .description("create a task, or a whole plan with --file")
    .argument("<room>", "room to create the task in")
    .argument("[brief]", "task brief")
    .option("--needs <id>", "task this one needs (repeatable)", collect)
    .option("--label <k=v>", "label (repeatable)", collect)
    .option("--target <t>", "target agent")
    .option("--file <plan.json>", "create a plan from a JSON file")
    .action(
      async (
        room: string,
        brief: string | undefined,
        opts: {
          needs?: string[];
          label?: string[];
          target?: string;
          file?: string;
        },
        cmd: Command,
      ) => {
        const json = globalOpts(cmd).json;
        const labels = parseLabels(opts.label);
        if (opts.file !== undefined) {
          const ignored = [
            brief !== undefined && "[brief]",
            opts.label?.length && "--label",
            opts.needs?.length && "--needs",
            opts.target !== undefined && "--target",
          ].filter(Boolean);
          if (ignored.length > 0) {
            throw new UsageError(
              `--file creates a plan from the file; ${ignored.join(", ")} cannot be combined with it`,
            );
          }
          const created = await clientFor(cmd, ctx).createPlan(room, readPlan(opts.file));
          ctx.out(
            json
              ? JSON.stringify(created)
              : Object.entries(created)
                  .map(([key, t]) => `${key}\t${t.id}\t${t.state}`)
                  .join("\n"),
          );
          return;
        }
        if (brief === undefined) throw new UsageError("tasks create needs a brief or --file");
        const task = await clientFor(cmd, ctx).createTask({
          room,
          brief,
          labels,
          needs: opts.needs,
          target: opts.target,
        });
        ctx.out(json ? JSON.stringify(task) : `${task.id}\t${task.state}`);
      },
    );

  registerTaskClaims(tasks, ctx);
}
