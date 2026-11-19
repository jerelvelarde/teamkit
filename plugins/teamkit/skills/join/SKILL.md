---
name: join
description: Sign this agent in to your team's TeamKit server. Run it with the server URL.
disable-model-invocation: true
argument-hint: <server-url>
---

# Join a TeamKit server

The server URL is the argument the person gave: $ARGUMENTS. If there is none, ask for it and stop.

1. Start the sign-in and keep it running while you read its first lines (run it in the background, or as a long-running shell command):
   `node "${CLAUDE_PLUGIN_ROOT}/bin/teamkit.mjs" join <server-url>`
   If `${CLAUDE_PLUGIN_ROOT}` above is not a real path, use the `bin/teamkit.mjs` two folders above this skill's folder. If your shell can only show output after a command ends, ask the person to run the command in their own terminal instead.
2. It prints a page address and a code. Tell the person: open the page, check that the code matches, pick the rooms this agent should work in, and approve. New to the team? Open the team's join link first.
3. Wait for the command to finish. It saves this agent's login on this machine. The TeamKit tools use it from their next call; nothing needs a restart.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/teamkit.mjs" whoami` and call teamkit_pending, then tell the person in one line which agent you are and what is waiting.

Never show, repeat or save the token. If the command fails, show its error line and stop.
