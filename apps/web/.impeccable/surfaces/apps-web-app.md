---
version: 1
slug: "apps-web-app"
primary_target: "apps/web/app"
related_targets: ["apps/web/components"]
---

# Board surface (web app shell, board, task thread panel)

Mode: Operate. Visitors are a team lead and teammates working tasks alongside agents. Job: see what is moving and what is stuck, open a task, answer an agent in one click. Constraints: keep every route, behavior and copy fact; the board streams live; tasks deep-link at /t/<id>.

User answers (2026-11-19): minimal, familiar patterns (Linear-style kanban, Slack-style chat); task opens in a right side panel over the board; follow the system light/dark setting; neutral grays plus one CopilotKit violet accent; status colors stay small.

## Direction contract

THESIS: TeamKit is a working tool its users already know how to drive: Linear's quiet kanban plus Slack's thread pane, played straight. It refuses the old glass-and-gradient look, monospace pills as decoration, eyebrow labels and boxed chat bubbles.

OWN-WORLD: Neutral grey canvas with a slightly darker sidebar layer, white raised cards with 1px hairlines, 6–8px radii, no resting shadows (hover strengthens the border instead). One violet accent for primary actions (New task, Create task, Approve, send) and focus. The current sidebar item takes a grey fill, as Linear's does, not violet. Status is Linear-style circle glyphs: dashed (waiting), ring (ready), amber half (claimed), orange alert (blocked), green check (done), red cross (failed). Status color stays small: glyphs, one label line, a blocked card's 1px edge. Inter for everything (Linear's face), self-hosted; mono only for ids and code. Light and dark from the OS.

STORY: The lead scans five columns, sees blocked cards stand out, opens one, reads the agent's thread in a side panel, clicks Approve, and watches the card move.

FIRST VIEWPORT: 224px sidebar: brand, then All rooms and Admin as top nav items (Linear keeps workspace views up top), then Rooms as # names, the person and sign-out at the bottom. Main: 52px header with the room title, a live dot and a violet New task button at the right. Five flexible columns (220–360px, so all five fit at 1440) with glyph, name and count. The thread panel is 560px from the right: state, room, copy link and close; title and property rows; Slack-style messages with times; the agent's question once, as an interactive card with Approve primary; a composer at the bottom.

FORM: canon by the user's choice. The user pinned it in their own words: "make it minimalistic and match known patterns for popular apps for kanban, chat (slack)". Linear and Slack set the bar. Signature move: an agent holding a task shows its square avatar with a live pulse, and its messages stream with Slack's typing dots. seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
