/*
 * Slack bridge: a managed Channel on CopilotKit Intelligence that turns Slack mentions,
 * thread replies and answer-button clicks into board calls.
 *
 * Live check (needs a real Intelligence key and a Slack workspace; not part of the test suite):
 * 1. Setup: `npx copilotkit@latest channels add --name <name> --display-name TeamKit --adapter slack --json`,
 *    install the Slack app it generates, invite the bot to a channel, and map that channel with
 *    `teamkit rooms set build --slack-channel C...`. Start the server with CPK_INTELLIGENCE_API_KEY and
 *    TEAMKIT_SLACK_CHANNEL_NAME=<name>. The log shows `slack bridge status: online`, with no
 *    "Slack is NOT set up" warning.
 * 2. Mention: `@TeamKit add a dark mode toggle` in the channel. A task card appears in the Slack
 *    thread, and the task shows in room build with label source=slack, created by the linked person
 *    (or by slack-guest, with "(from Slack user ...)" in the brief).
 * 3. Reply: a reply in that Slack thread appears in the task's thread on the board.
 * 4. Button click (managed path): make an agent block the task with options. Slack outbound posts
 *    the question with buttons. Clicking one as a linked approver moves the task to ready, and the
 *    thread shows "<name> answered: <choice>". As an unlinked user the click gets an ephemeral link
 *    to /link/slack?code=..., and the task stays blocked.
 * 5. Fallback: if clicks never arrive, reply in the thread with an option's exact text (any case)
 *    as a linked person. That answers the block too.
 */
import type { Db } from "../db/pool.js";
import { slackBridgeEnabled, type SlackBridgeConfig } from "./bridge-config.js";
import type { SlackThreadLike, SlackTurn } from "./handlers.js";

export interface SlackBridgeOptions {
  db: Db;
  config: SlackBridgeConfig;
  log?: (line: string) => void;
}

export interface SlackBridge {
  status(): unknown;
  stop(): Promise<void>;
}

/** How long a turn's raw provider event stays available for slackCoordinates. */
const RAW_TTL_MS = 60_000;
const READY_TIMEOUT_MS = 30_000;

function errorText(e: unknown): string {
  if (e instanceof AggregateError && e.errors.length > 0) {
    return `${e.message}: ${e.errors.map(errorText).join("; ")}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Starts the Slack bridge, or returns null when CPK_INTELLIGENCE_API_KEY or
 * TEAMKIT_SLACK_CHANNEL_NAME is unset. The Slack handlers, Channels and the runtime are
 * imported only past that check, so a server without Slack never loads them.
 */
export async function startSlackBridge(o: SlackBridgeOptions): Promise<SlackBridge | null> {
  const { db, config } = o;
  if (!slackBridgeEnabled(config)) return null;
  const log = o.log ?? ((line: string) => console.log(line));
  const warn = o.log ?? ((line: string) => console.warn(line));
  const name = config.channelName;

  const [{ createSlackHandlers, ensureSlackGuest, slackCoordinates }, { createSlackAnswerHandler }, { findLinkedPerson }] =
    await Promise.all([import("./handlers.js"), import("./answer.js"), import("./links.js")]);
  const guest = await ensureSlackGuest(db);
  const handlers = createSlackHandlers({ db, publicUrl: config.publicUrl, defaultRoom: config.defaultRoom, guest });
  const answers = createSlackAnswerHandler({ db, publicUrl: config.publicUrl });

  const [{ createChannel }, { CopilotRuntime, CopilotKitIntelligence }, { createCopilotNodeListener }] =
    await Promise.all([
      import("@copilotkit/channels"),
      import("@copilotkit/runtime/v2"),
      import("@copilotkit/runtime/v2/node"),
    ]);

  // Handlers get only {thread, message}; identifyUser sees the raw provider event first, so keep
  // it briefly by event id. Map order is insertion order, so expired entries sit at the front.
  const raws = new Map<string, { raw: unknown; at: number }>();
  const remember = (eventId: string | undefined, raw: unknown) => {
    const now = Date.now();
    for (const [id, r] of raws) {
      if (now - r.at <= RAW_TTL_MS) break;
      raws.delete(id);
    }
    if (!eventId) return;
    raws.delete(eventId);
    raws.set(eventId, { raw, at: now });
  };
  const recall = (eventId: string | undefined): unknown => {
    const r = eventId ? raws.get(eventId) : undefined;
    return r && Date.now() - r.at <= RAW_TTL_MS ? r.raw : undefined;
  };

  const turn = (
    thread: SlackThreadLike,
    message: { text: string; actor: { id: string; name?: string }; eventId?: string },
  ): SlackTurn => ({
    thread,
    text: message.text,
    slackUserId: message.actor.id,
    slackUserName: message.actor.name ?? null,
    coordinates: slackCoordinates(thread.conversationKey, recall(message.eventId)),
  });

  // Errors never reach Channels: a throw there would fail the whole delivery.
  const guarded = async (kind: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      warn(`slack bridge: ${kind} handler failed: ${errorText(e)}`);
    }
  };

  const channel = createChannel({
    name,
    adapters: [],
    identifyUser: async (ctx) => {
      remember(ctx.event.id, ctx.raw);
      if (!ctx.actor.id) return null;
      try {
        const person = await findLinkedPerson(db, ctx.actor.id);
        return person ? { id: person.actor.id, name: person.actor.name } : null;
      } catch (e) {
        // The handlers look the person up again and report the failure there.
        warn(`slack bridge: identity lookup failed: ${errorText(e)}`);
        return null;
      }
    },
  });
  channel.onMention(({ thread, message }) => guarded("mention", () => handlers.onMention(turn(thread, message))));
  channel.onMessage(({ thread, message }) => guarded("message", () => handlers.onMessage(turn(thread, message))));
  channel.onInteraction("teamkit.answer", (ctx) =>
    guarded("answer", () =>
      answers.onAnswer({ thread: ctx.thread, slackUserId: ctx.actor.id, value: ctx.action.value }),
    ),
  );

  const runtime = new CopilotRuntime({
    agents: {},
    intelligence: new CopilotKitIntelligence({
      apiKey: config.intelligenceApiKey,
      ...(config.intelligenceApiUrl ? { apiUrl: config.intelligenceApiUrl } : {}),
      ...(config.intelligenceWsUrl ? { wsUrl: config.intelligenceWsUrl } : {}),
    }),
    channels: [channel],
  });
  // Creating the listener starts the Channel's connection; no HTTP server is needed.
  const listener = createCopilotNodeListener({ runtime, basePath: "/api/copilotkit" });

  try {
    await listener.channels.ready({ timeoutMs: READY_TIMEOUT_MS });
  } catch (e) {
    warn(`slack bridge: Channel "${name}" did not become ready: ${errorText(e)}`);
  }
  // ready() also resolves on setup_required, so the status decides what to say.
  const { overall } = listener.channels.status();
  log(`slack bridge status: ${overall}`);
  if (overall === "setup_required") {
    warn(
      `Slack is NOT set up for channel "${name}": run npx copilotkit@latest channels add --name ${name} --display-name TeamKit --adapter slack --json, then invite the bot`,
    );
  }

  return {
    status: () => listener.channels.status(),
    stop: () => listener.channels.stop(),
  };
}
