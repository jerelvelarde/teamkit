import { BoardError } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { answer } from "../store/blocks.js";
import { loadTask } from "../store/task-load.js";
import { parseAnswerValue } from "./blocks.js";
import { createSlackLinkCode, findLinkedPerson, slackLinkUrl } from "./links.js";

export interface SlackAnswerThread {
  post(ui: unknown): Promise<{ id: string }>;
  postEphemeral(user: { id: string } | string, ui: unknown, opts: { fallbackToDM: boolean }): Promise<unknown>;
}

export interface SlackInteraction {
  thread: SlackAnswerThread;
  slackUserId: string;
  value: unknown;
}

/**
 * Handles a click on a `teamkit.answer` button. The click answers as the person linked to the
 * Slack user (via "session", so approvals follow the same person-and-approver rule as the web).
 * An unlinked user gets a link prompt and nothing is answered.
 */
export function createSlackAnswerHandler(d: { db: Db; publicUrl: string }): {
  onAnswer(i: SlackInteraction): Promise<void>;
} {
  async function handle({ thread, slackUserId, value }: SlackInteraction): Promise<void> {
    const tell = (text: string) => thread.postEphemeral(slackUserId, text, { fallbackToDM: true });

    const parsed = parseAnswerValue(value);
    if (!parsed) {
      await tell("This button is no longer valid.");
      return;
    }
    const linked = await findLinkedPerson(d.db, slackUserId);
    if (!linked) {
      const code = await createSlackLinkCode(d.db, slackUserId);
      await tell(`To answer from Slack, link your account: ${slackLinkUrl(d.publicUrl, code)}`);
      return;
    }
    const task = await loadTask(d.db, parsed.taskId);
    if (!task || task.state !== "blocked" || !task.block || task.block.interruptId !== parsed.interruptId) {
      await tell("This question was already answered.");
      return;
    }
    try {
      await answer(
        d.db,
        { actor: linked.actor, via: "session", scope: null, role: linked.role },
        parsed.taskId,
        { choice: parsed.choice },
      );
    } catch (err) {
      if (err instanceof BoardError) {
        await tell(
          err.code === "approval_requires_person"
            ? "Only a listed approver can answer this approval."
            : err.message,
        );
        return;
      }
      throw err;
    }
    await thread.post(`${linked.actor.name} answered: ${parsed.choice}`);
  }

  return {
    async onAnswer(i) {
      try {
        await handle(i);
      } catch (err) {
        console.error("slack answer handler failed", err);
      }
    },
  };
}
