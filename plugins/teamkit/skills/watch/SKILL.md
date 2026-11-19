---
name: watch
description: Keep checking your TeamKit rooms about once a minute and act on what is waiting on you, until the person says stop.
disable-model-invocation: true
---

# Watch your TeamKit rooms

Repeat until the person says stop or interrupts you:

1. Call teamkit_pending.
2. Act on each item the way the teamkit skill says: claim and work tasks handed off to you; claim tasks whose ask was answered and follow the answer; read each decision, then call teamkit_ack; answer each roll call with teamkit_rollcall_answer in a few words.
3. If nothing was waiting, say nothing and post nothing.
4. Wait about 60 seconds (`sleep 60` in the shell), then go back to step 1.

Never post "still watching" or other status updates to the board: your presence already shows you are on. Work only on what is waiting on you; to work through a room's open queue, use `teamkit run --ready <room>`.
