# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a team lead who runs agents alongside people. They set up rooms, hand work to agents and teammates, watch the board to see what is moving and what is stuck, and step in when an agent asks a question or needs an approval. Teammates use the same board to pick up tasks, follow a task's thread and answer agents, on the web or in Slack.

## Product Purpose

AG-UI TeamKit is a shared task board where people and agents claim and work tasks. Success is a team that can hand a task to any agent, see it move across the board, and answer the agent's questions without leaving the board or Slack.

## Positioning

Any agent works the board. AG-UI service agents (LangGraph, Mastra, a CopilotKit BuiltInAgent) get tasks pushed to them over AG-UI. Coding agents (Claude Code, Codex) join through the native `teamkit` CLI, a skill and `teamkit run -- <agent>`. Every task is an AG-UI thread, so the board, the web thread and Slack show the same run.

## Operating Context

- Rooms group tasks (for example `launch`, `support`, `eng/api`). A room can have a default agent and a list of approvers.
- A task moves through waiting (needs another task), ready, claimed (an agent or person holds a lease), blocked (an agent asked a question or needs an approval) and done.
- People sign in with a one-time link. Admins manage people, agent tokens and rooms on the admin page.
- People answer agents on the web thread or in a Slack thread through the CopilotKit Channels SDK.
- Coding agents work from a terminal and report back with `teamkit` CLI commands.

## Capabilities and Constraints

- Web app: Next.js 15, React 19, CSS modules, no UI library. The server is Hono on Postgres.
- The board streams live updates. Task threads render AG-UI events: messages, tool calls, run lifecycle, questions and approvals.
- Open source, public repo `jerelvelarde/teamkit`. Nothing is on npm yet.

## Brand Commitments

- The name is "AG-UI TeamKit". Lead with AG-UI.
- The user asked for a minimal UI that follows patterns people already know: Linear-style kanban for the board and Slack-style chat for task threads. Familiar beats novel here.
- CopilotKit violet is the one accent color.

## Evidence on Hand

- Demo recordings in `docs/media/` (board, swarm, service agent). They show the old look and need re-recording after a redesign.
- No customers, testimonials or benchmarks exist. Do not invent any.

## Product Principles

- The board is the product. A person should see what is moving and what is stuck at a glance.
- Agents and people are peers on the board. Show who holds a task the same way for both.
- A blocked task is the loudest thing on the screen, because it is waiting on a person.
- Answering an agent should take one click, in the thread, without leaving the board.
