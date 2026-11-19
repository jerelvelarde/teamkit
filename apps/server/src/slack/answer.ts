import { BoardError } from "@copilotkit/teamkit-protocol";
import type { Db } from "../db/pool.js";
import { answer } from "../store/blocks.js";
import { parseAnswerValue } from "./blocks.js";
import { escapeMrkdwn } from "./cards.js";
import { createSlackLinkCode, findLinkedPerson, slackLinkUrl } from "./links.js";

export interface SlackAnswerThread {
  post(ui: unknown): Promise<{ id: string }>;
  postEphemeral(user: { id: string } | string, ui: unknown, opts: { fallbackToDM: boolean }): Promise<unknown>;
}

export interface SlackInteraction {
  thread: SlackAnswerThread;
  slackUserId: string;
  /** The clicker's Slack handle, shown on the link page when they are not linked yet. */
  slackUserName: string | null;
  value: unknown;
}

/**
 * Handles a click on a `teamkit.answer` button. The click answers as the person linked to the
 * Slack user (via "session", so approvals follow the same person-and-approver rule as the web).
 * An unlinked user gets a link prompt and nothing is answered. Text posted back to Slack that an
 * agent or a person wrote (the choice, a name, an error message) is escaped first.
 */
export function createSlackAnswerHandler(d: { db: Db; publicUrl: string }): {
  onAnswer(i: SlackInteraction): Promise<void>;
} {
  async function handle({ thread, slackUserId, slackUserName, value }: SlackInteraction): Promise<void> {
    const tell = (text: string) => thread.postEphemeral(slackUserId, text, { fallbackToDM: true });

    const parsed = parseAnswerValue(value);
    if (!parsed) {
      await tell("This button is no longer valid.");
      return;
    }
    const linked = await findLinkedPerson(d.db, slackUserId);
    if (!linked) {
      const code = await createSlackLinkCode(d.db, slackUserId, { slackUserName });
      await tell(`To answer from Slack, link your account: ${slackLinkUrl(d.publicUrl, code)}`);
      return;
    }
    try {
      // The interrupt check happens inside answer's transaction, so a click on an old card can
      // never answer a newer question.
      await answer(
        d.db,
        { actor: linked.actor, via: "session", scope: null, role: linked.role },
        parsed.taskId,
        { choice: parsed.choice },
        { expectedInterruptId: parsed.interruptId },
      );
    } catch (err) {
      if (err instanceof BoardError) {
        if (err.code === "approval_requires_person") {
          await tell("Only a listed approver can answer this approval.");
        } else if (err.code === "invalid_state" || err.code === "not_found") {
          await tell("This question was already answered.");
        } else {
          await tell(escapeMrkdwn(err.message));
        }
        return;
      }
      throw err;
    }
    // The "<person> answered: <choice>" line is posted by outbound, for answers from Slack and the board alike.
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
