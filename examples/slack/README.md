# Slack with AG-UI TeamKit

Connect AG-UI TeamKit to Slack through [CopilotKit Channels](https://docs.copilotkit.ai) (the managed path). People can then create tasks by mentioning TeamKit, follow them in the Slack thread, and answer blocked tasks with a button or a reply.

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
2. Install the app to your workspace.
3. Invite the bot to each channel you want to use: `/invite @TeamKit`. The bot only sees channels it is in.

## 3. Configure the server

Set these in `.env` at the repository root (copy `.env.example`), or in the server's environment:

| Variable | Needed for | Meaning |
| --- | --- | --- |
| `CPK_INTELLIGENCE_API_KEY` | the bridge | Your Intelligence key. |
| `TEAMKIT_SLACK_CHANNEL_NAME` | the bridge | The Channel name from step 1, `teamkit` here. |
| `SLACK_BOT_TOKEN` | outbound posts | The app's bot token (`xoxb-...`). TeamKit uses it to post blocked-task questions and outcomes. |
| `TEAMKIT_SLACK_DEFAULT_ROOM` | optional | The room a mention lands in when its Slack channel is not mapped to one. |
| `TEAMKIT_PUBLIC_URL` | linking | Where people reach the web board. Links shown in Slack point here. |

The bridge starts only when both `CPK_INTELLIGENCE_API_KEY` and `TEAMKIT_SLACK_CHANNEL_NAME` are set. Outbound posts need only `SLACK_BOT_TOKEN`. Start the server and look for `slack bridge status: online` in its log. If you see a warning that Slack is not set up, finish steps 1 and 2.

## 4. Map a Slack channel to a room

Find the channel's id (Slack: channel name, **About**, bottom of the panel; it looks like `C0123ABCD`), then:

```sh
teamkit rooms set build --slack-channel C0123ABCD
```

`teamkit rooms set` is an admin command, so run `teamkit login` first. On the server machine, `pnpm --silent --filter @teamkit/server admin rooms set build --slack-channel C0123ABCD` does the same.

Add `--slack-announce` to choose what TeamKit posts for tasks created outside Slack: `blocked` (the default, a task gets a Slack thread when it first needs a person), `all`, or `none`. A room with no mapped channel posts nothing to Slack.

## 5. Link Slack accounts

Anyone in the Slack workspace can create tasks and reply. Answering an approval needs a TeamKit account. The first time someone clicks an approval button without a linked account, TeamKit replies privately (only they see it) with a link to `/link/slack` on the web board. They sign in, check that the page names their Slack handle, and confirm. The click that prompted the link does not count; they click again once linked. A person can see and remove their links from the web board.

## What works

- **Mentions.** `@TeamKit add a dark mode toggle` in a mapped channel creates a task in the room and replies with a card. The Slack thread becomes the task's chat mirror.
- **Replies.** A reply in that thread is posted onto the task's thread on the board. A second mention in the thread is a reply, not a second task.
- **Buttons.** A blocked task posts its question with answer buttons. A linked approver clicks one and the task returns to the queue. Answering by replying with an option's text also works.
- **Outcomes.** Completed and failed tasks post their result in the thread. Working notes stay on the board.

## What does not work on the managed path

- Slash commands are not delivered.
- Modals are not delivered.

Everything above uses mentions, messages and buttons only.

## Telemetry

CopilotKit packages send anonymous usage telemetry by default. To turn it off, set `COPILOTKIT_TELEMETRY_DISABLED=true` in the server's environment.

## Check your setup

1. The server log shows `slack bridge status: online`.
2. Mention the bot in the mapped channel. A card appears in the thread, and the task shows on the web board in the room with label `source=slack`.
3. Reply in the thread. The reply appears on the task.
4. Have an agent block the task with options, for example `teamkit tasks block <id> "which db?" --options pg,sqlite`. The question and buttons appear in the thread. Click one as a linked person and the thread shows who answered.
