# Slack with AG-UI TeamKit

Connect AG-UI TeamKit to Slack through [CopilotKit Channels](https://docs.copilotkit.ai) (the managed path). People can then create tasks by mentioning TeamKit, follow them in the Slack thread, answer asks with a button or a reply, and record decisions and alerts with `/teamkit`. The channel stays quiet: only asks, decisions and alerts post at the top level, plus one pinned status message per room.

Live Slack was not exercised in this repository's CI. The tests cover the handlers, the cards and the outbound posts with fakes. Follow the checks at the end of this page to confirm your own setup.

## What you need

- A running TeamKit server that stays up (the Channels listener holds a websocket open, so serverless functions will not do).
- A CopilotKit Intelligence API key.
- A Slack workspace where you can install an app.

## 1. Create the Channel

```sh
npx copilotkit@latest channels add --name teamkit --display-name TeamKit --adapter slack --json
```

This registers a Channel called `teamkit` and prints a Slack app manifest.

## 2. Create the Slack app

1. In Slack, go to **Your Apps**, choose **Create New App**, then **From a manifest**, and paste the manifest from step 1.
2. Give the app the `chat:write`, `pins:write` and `commands` bot scopes.
3. Under **Slash Commands**, add `/teamkit` with the Request URL `<TEAMKIT_PUBLIC_URL>/v1/slack/commands`. Channels does not deliver slash commands, so TeamKit takes `/teamkit` directly, signed with the app's signing secret.
4. Install the app to your workspace.
5. Invite the bot to each channel you want to use: `/invite @TeamKit`. The bot only sees channels it is in.

## 3. Configure the server

Set these in `.env` at the repository root (copy `.env.example`), or in the server's environment:

| Variable | Needed for | Meaning |
| --- | --- | --- |
| `CPK_INTELLIGENCE_API_KEY` | the bridge | Your Intelligence key. |
| `TEAMKIT_SLACK_CHANNEL_NAME` | the bridge | The Channel name from step 1, `teamkit` here. |
| `SLACK_BOT_TOKEN` | outbound posts | The app's bot token (`xoxb-...`). TeamKit uses it to post asks, decisions, alerts, task threads and the status message. |
| `SLACK_SIGNING_SECRET` | `/teamkit` | The app's signing secret (**Basic Information**). Without it, `/teamkit` is off. |
| `TEAMKIT_SLACK_DEFAULT_ROOM` | optional | The room a mention lands in when its Slack channel is not mapped to one. |
| `TEAMKIT_PUBLIC_URL` | linking | Where people reach the web board. Links shown in Slack point here. |

The bridge starts only when both `CPK_INTELLIGENCE_API_KEY` and `TEAMKIT_SLACK_CHANNEL_NAME` are set. Outbound posts need only `SLACK_BOT_TOKEN`. Start the server and look for `slack bridge status: online` in its log. If you see a warning that Slack is not set up, finish steps 1 and 2.

## 4. Map a Slack channel to a room

Find the channel's id (Slack: channel name, **About**, bottom of the panel; it looks like `C0BILLMIG`), then:

```sh
teamkit rooms set billing-migration --slack-channel C0BILLMIG
```

`teamkit rooms set` is an admin command, so run `teamkit login` first. On the server machine, `pnpm --silent --filter @teamkit/server admin rooms set billing-migration --slack-channel C0BILLMIG` does the same.

Add `--slack-announce` to choose what TeamKit posts for tasks created outside Slack: `blocked` (the default, a task gets a Slack thread when it first needs a person), `all` (every task gets one), or `none` (TeamKit posts nothing to the channel: no tasks, no status message, no decisions, no alerts; mentions, replies, buttons and `/teamkit` still work). A room with no mapped channel posts nothing to Slack.

## 5. Link Slack accounts

Anyone in the Slack workspace can create tasks and reply. Answering an approval needs a TeamKit account. The first time someone clicks an approval button without a linked account, TeamKit replies privately (only they see it) with a link to `/link/slack` on the web board. They sign in, check that the page names their Slack handle, and confirm. The click that prompted the link does not count; they click again once linked. A person can see and remove their links from the web board.

## What works

- **Mentions.** `@TeamKit check the invoice counts in billing-v2` in a mapped channel creates a task in the room and replies with a card. The Slack thread becomes the task's chat mirror.
- **Replies.** A reply in that thread is posted onto the task's thread on the board. A second mention in the thread is a reply, not a second task.
- **What posts where.**
  - A task gets a thread only when it first asks a person, when someone creates it by mentioning TeamKit, or with `--slack-announce all`. After that, claims, agents' progress replies, answers, handoffs, change-log lines and outcomes go in that thread.
  - A later ask on the same task also shows in the channel.
  - A person's reply on the board stays on the board.
  - Only asks, decisions and alerts post at the top level. A confirmed alert uses @here; a suspected one does not, and its later confirmation replies in its thread with @here. When someone resolves an alert, its message is edited to say who, with no ping.
  - Roll calls, and change-log lines that belong to no task, never post.
- **Status message.** One per room, pinned, edited in place at most every 10 s. It shows the agents on, the work in progress, and the asks with who they wait on. If someone deletes or unpins it, the next change posts a fresh one and pins it.
- **Approvals.** An ask names who it waits on and mentions their linked Slack user. A button click (or a reply with an option's text) answers only for that person, the room's approvers when the ask names none, or an admin. Anyone else gets a private note saying who it waits on.
- **`/teamkit`.** `/teamkit decide <text>` records a decision and `/teamkit alert <text>` raises an alert confirmed by you, both for a linked person in a mapped channel. Anyone else gets a private reply saying what to do.

## What does not work on the managed path

- Modals are not delivered.

Channels does not deliver slash commands, so TeamKit takes `/teamkit` directly, signed with the app's signing secret. Everything else uses mentions, messages and buttons.

## Telemetry

CopilotKit packages send anonymous usage telemetry by default. To turn it off, set `COPILOTKIT_TELEMETRY_DISABLED=true` in the server's environment.

## Check your setup

1. The server log shows `slack bridge status: online`.
2. Mention the bot in the mapped channel. A card appears in the thread, and the task shows on the web board in the room with label `source=slack`.
3. Reply in the thread. The reply appears on the task.
4. Have an agent ask on the task, for example `teamkit tasks block <id> "Run the invoice backfill on billing-prod tonight?" --kind awaiting_approval --options approve,reject --approvers sam`. The ask appears, naming sam. Click a button as a linked person who is not sam: you get a private note that it waits on sam. Click as sam and the thread shows who answered.
5. The channel has one pinned status message for the room. Claim a task from the board and, within about 10 s, the status shows it.
6. Run `/teamkit decide Freeze writes to the old invoices table from 18:00 UTC.` in the channel. The decision posts at the top level and shows on the board.
