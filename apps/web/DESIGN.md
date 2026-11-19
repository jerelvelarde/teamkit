---
name: AG-UI TeamKit
description: A shared task board where people and agents claim and work tasks; Linear's kanban and Slack's thread pane, played straight.
colors:
  violet: "#6430ab"
  violet-deep: "#55259a"
  violet-soft: "rgba(100, 48, 171, 0.08)"
  violet-line: "rgba(100, 48, 171, 0.45)"
  on-violet: "#ffffff"
  frame-grey: "#f3f3f4"
  panel-grey: "#fbfbfb"
  raised-white: "#ffffff"
  sunken-grey: "#f4f4f5"
  hover-wash: "rgba(24, 24, 27, 0.045)"
  active-wash: "rgba(24, 24, 27, 0.08)"
  hairline: "#e5e5e8"
  hairline-strong: "#d4d4d8"
  ink: "#18181b"
  ink-2: "#4f4f57"
  ink-3: "#6e6e78"
  ink-4: "#a1a1aa"
  claimed-amber: "#d99a06"
  blocked-orange: "#e8590c"
  blocked-text: "#c2410c"
  blocked-soft: "#fff6ef"
  blocked-line: "#f8c7a4"
  done-green: "#1f9d55"
  failed-red: "#dc2626"
  failed-text: "#b91c1c"
typography:
  headline:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.012em"
  title:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "\"cv11\", \"ss01\""
  message:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.5
  card-title:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "13.5px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "-0.005em"
  label:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
  caption:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  full: "999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
components:
  button:
    backgroundColor: "{colors.raised-white}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "30px"
  button-hover:
    backgroundColor: "{colors.sunken-grey}"
  button-primary:
    backgroundColor: "{colors.violet}"
    textColor: "{colors.on-violet}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "{colors.violet-deep}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "30px"
  button-ghost-hover:
    backgroundColor: "{colors.hover-wash}"
    textColor: "{colors.ink}"
  icon-button:
    rounded: "{rounded.sm}"
    size: "28px"
  input:
    backgroundColor: "{colors.raised-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  pill:
    backgroundColor: "{colors.raised-white}"
    textColor: "{colors.ink-2}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "0 7px"
    height: "20px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.full}"
    padding: "0 6px"
    height: "20px"
  task-card:
    backgroundColor: "{colors.raised-white}"
    textColor: "{colors.ink}"
    typography: "{typography.card-title}"
    rounded: "{rounded.md}"
    padding: "11px 12px 10px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "30px"
  nav-item-current:
    backgroundColor: "{colors.active-wash}"
    textColor: "{colors.ink}"
  thread-panel:
    backgroundColor: "{colors.raised-white}"
    width: "560px"
  composer:
    backgroundColor: "{colors.raised-white}"
    textColor: "{colors.ink}"
    typography: "{typography.message}"
    rounded: "{rounded.md}"
  send-button:
    backgroundColor: "{colors.violet}"
    textColor: "{colors.on-violet}"
    rounded: "{rounded.sm}"
    width: "30px"
    height: "28px"
---

# Design System: AG-UI TeamKit

## Overview

**Creative North Star: "The Familiar Workbench"**

TeamKit is a working tool its users already know how to drive. The board is Linear's quiet kanban and the task thread is Slack's thread pane, both played straight, because the user pinned that canon: familiar beats novel. The build lands as a neutral grey frame holding an inset content panel, white cards on 1px hairlines, one CopilotKit violet for action and focus, and Linear-style circle glyphs for status. Nothing is decorative; every color, line and weight carries a state or an action.

Density is a work tool's density: a 14px body, 13px controls, 30px rows, 8–12px gaps. Five columns fit at 1440px. Depth is tonal (frame, panel, raised card) with hairline borders; shadows exist only on things that float over the board. Light and dark follow the operating system through `prefers-color-scheme`; both themes share every token name, so components never branch on theme.

The build rejects the old glass-and-gradient look, monospace pills as decoration, eyebrow labels and boxed chat bubbles.

**Key Characteristics:**
- Linear's frame: a slightly darker sidebar ground, the content in an inset rounded panel.
- Slack's messages: avatar, bold name, time, unboxed text, grouped follow-ups, typing dots.
- One violet accent for primary actions and focus; the current nav item is a grey fill, not violet.
- Status color stays small: a 14px glyph, one label line, a blocked card's 1px edge.
- Inter for everything; mono only for ids, secrets and code.
- No resting shadows; hover strengthens the border.

## Colors

Neutral zinc greys carry the whole interface; one violet speaks for action, and five small status hues speak for task state.

### Primary
- **CopilotKit Violet** (`violet`): fills the primary action on any surface (New task, Create task, Approve, the composer's send button, sign-in submit, admin create) and the brand mark. In dark mode it lifts to `#7a4ad4`, with `#b89ef6` for violet text.
- **Deep Violet** (`violet-deep`): hover and active fill of violet buttons.
- **Violet Wash and Violet Line** (`violet-soft`, `violet-line`): the focus treatment for inputs, the composer and cards (border to violet-line plus a 3px violet-soft ring), the selected card's outline, and text selection. The focus outline elsewhere is 2px of `rgba(100, 48, 171, 0.4)` at 2px offset.

### Tertiary (status, used small)
- **Claimed Amber** (`claimed-amber`): the half-filled claimed glyph, the live pulse ring around an agent holding a task, and the header's Live dot when disconnected.
- **Blocked Orange** (`blocked-orange`, `blocked-text`, `blocked-line`, `blocked-soft`): the solid blocked glyph, the "Approval needed" / "Question" kind line, a blocked card's 1px edge, and soft warning panels (sign-in warning, one-time secret reveal).
- **Done Green** (`done-green`): the check glyph, the connected Live dot and success status lines.
- **Failed Red** (`failed-red`, `failed-text`): the cross glyph, failed lines and form errors.

### Neutral
- **Frame Grey** (`frame-grey`): the app ground and sidebar; dark `#0d0d0f`.
- **Panel Grey** (`panel-grey`): the inset content panel behind the board; dark `#131315`.
- **Raised White** (`raised-white`): cards, buttons, inputs, the thread panel, dialogs, tables; dark `#1a1a1d`.
- **Sunken Grey** (`sunken-grey`): button hover, code and kbd chips, result blocks, skeletons, disabled send; dark `#212125`.
- **Hover and Active Washes** (`hover-wash`, `active-wash`): translucent fills for row, message and nav hover, and the current nav item.
- **Hairline / Strong Hairline** (`hairline`, `hairline-strong`): every border; strong for buttons, inputs, the question card, the composer and card hover.
- **Ink 1–4** (`ink` … `ink-4`): primary text, secondary text, meta (counts, times, labels), and faint (waiting glyph, system timestamps).

### Named Rules
**The One Voice Rule.** Violet appears only on a primary action, the focus ring, the selected card and the brand mark. Never on navigation selection, headings or decoration.

**The Small Status Rule.** Status hue is limited to the glyph, one line of kind text, a dot, or a blocked card's 1px border. No status-tinted card fills or column backgrounds.

**The Shared Name Rule.** Light and dark are one token set swapped under `prefers-color-scheme`; components reference tokens, never theme-specific values.

## Typography

**Display Font:** none
**Body Font:** Inter (self-hosted through next/font as `--tk-font-inter`, falling back to ui-sans-serif and the system stack), with `cv11` and `ss01` features on.
**Label/Mono Font:** ui-monospace / SF Mono / Menlo, for ids, device codes, secrets and code only.

**Character:** One face, Linear's, at work-tool sizes. Hierarchy comes from weight (400 / 500 / 600, 700 only for Slack message names) and ink tone, not size jumps.

### Hierarchy
- **Headline** (600, 18px, 1.35, -0.012em, balanced): the task title at the top of the thread panel. The largest type in the app; sign-in titles are 17px and the New task brief is 16px/500.
- **Title** (600, 14px): the page header room title, the brand name, the Activity heading at 13px; admin section heads at 15px.
- **Body** (400, 14px, 1.5): descriptions, notices, result text.
- **Message** (400, 14.5px, 1.5): Slack-style message text and the composer, with the sender name at 14px/700.
- **Card Title** (500, 13.5px, 1.4, -0.005em): task card titles.
- **Label** (500, 13px): buttons, nav items, column names, property values, panel bar state.
- **Caption** (500, 12px): chips and pills (11.5–12px), meta, field labels (12–12.5px), counts and times with tabular numerals.

### Named Rules
**The Weight Not Size Rule.** Separate levels with weight and ink tone; the whole app spans 11.5px to 18px.

**The Mono Is Data Rule.** Monospace marks machine values (ids, codes, secrets, tool payloads). Never use it for pills, labels or decoration.

## Layout

Linear's frame. A 224px sidebar sits on the frame ground; the content lives in an inset panel with 8px margins (top, right, bottom), a 1px hairline and a 12px radius. Every page opens with a 52px header with a bottom hairline: room icon and title, the Live indicator, a spacer, and the violet New task button at the right.

The board is five flexible columns (`flex: 1 0 220px`, max 360px) with 12px gaps and 12px/16px padding, so all five fit at 1440px and overflow scrolls horizontally. Column heads are 36px: glyph, name, count. Cards stack with 8px gaps.

The task thread opens as a 560px panel from the right edge over the board (absolutely positioned inside the content panel), with a 52px bar, scrolling details and activity, and a fixed footer holding the question card and composer. Deep links resolve to the same panel.

Admin is a single 820px column with 40px between sections. Sign-in pages are a centered 440px column starting at max(48px, 12vh).

Rhythm is a 4px base with 8, 12, 16, 20 and 24px steps; 20px is the panel's horizontal inset, 12–16px the board's.

**Below 900px:** the sidebar becomes a 280px (max 86vw) drawer over a 32% black scrim, opened from a menu button; the content panel loses its margin, border and radius and fills the screen; board columns become snapping cards of min(300px, 100vw − 48px); the thread panel goes full-screen; the dialog's two fields stack; keyboard hints hide.

## Elevation & Depth

Flat, tonal and hairlined. Depth is three grounds (frame, panel, raised) plus 1px borders. Cards and buttons carry no resting shadow (`--tk-shadow-card: none`); only surfaces that float over the board get a shadow, and dark mode deepens them.

### Shadow Vocabulary
- **Pop** (`box-shadow: 0 12px 32px -8px rgba(24, 24, 27, 0.2), 0 2px 6px rgba(24, 24, 27, 0.06)`): the New task dialog and the mobile sidebar drawer.
- **Panel** (`box-shadow: -16px 0 40px -16px rgba(24, 24, 27, 0.22)`): the thread panel's left edge over the board.
- **Focus ring** (`box-shadow: 0 0 0 3px violet-soft`, with a violet-line border): focused inputs, composer, cards and the selected card. A state, not elevation.

### Named Rules
**The Border-Not-Shadow Rule.** Hover strengthens a border (hairline to strong hairline); it never adds a shadow or lifts a card.

**The Only-Floaters-Cast Rule.** A shadow means the surface floats over the board (dialog, drawer, thread panel). Nothing in flow casts one.

## Shapes

Gently rounded rectangles. Controls, nav items and inputs are 6px; cards, the question card, the composer, tables and result blocks are 8px; the content panel, dialog and sign-in panels are 12px; chips, pills and the Live indicator are full pills; code and kbd chips are 4px. Every container edge is a 1px solid hairline; dashed borders appear only on empty-column placeholders and the waiting glyph. Avatars encode kind: a person is a circle, an agent a rounded square (28% of its size).

Icons are 16px line drawings on a 16-unit grid, 1.5 stroke, round caps and joins, in `currentColor`. Status glyphs are 14px Linear-style circles: dashed ring (waiting), ring (ready), amber half-fill (claimed), solid orange with an exclamation (blocked), solid green check (done), solid red cross (failed).

## Components

### Buttons
Quiet and compact; violet only when it is the action.
- **Shape:** gently curved (6px), 30px tall, 0 12px padding, 13px/500 label, 6px icon gap.
- **Primary:** violet fill, white text, transparent border; hover and active go to deep violet.
- **Default:** raised white with a strong hairline; hover fills sunken grey, active the active wash.
- **Ghost:** transparent, ink-2; hover gets the hover wash and full ink. In the build it appears only as the icon button.
- **Icon button:** a ghost button at 28×28 with a 16px icon (copy link, close, menu, drawer close, sign-out).
- **Danger (admin):** transparent with failed-red text, hover wash.
- **Disabled:** 50% opacity. Transitions are 120ms on background and border.

### Chips
- **Card chips:** 20px pills with a hairline border, no fill, 11.5px/500 ink-2 text, icon in ink-3 (`# launch`, `area: api`, `priority: high`).
- **Shared pill:** the same pill on raised white at 12px, used in the thread panel and the admin tables.

### Cards / Containers
- **Task card:** raised white, 1px hairline, 8px radius, 11px 12px 10px padding, 8px internal gap. Title at card-title type with the holder's avatar top-right; an optional need or blocked line (status glyph plus 12–12.5px text); chips and meta in the foot. Hover strengthens the border. Blocked cards take a blocked-line border. The card open in the panel takes the violet focus ring. Done and failed titles drop to ink-2.
- **Empty column:** 1px dashed strong hairline, 8px radius, 12.5px ink-3 text.
- **Skeleton:** 84px sunken-grey shimmer at 8px radius.
- **Shared raised surface:** raised white, hairline, 12px radius, for sign-in panels and notices.

### Inputs / Fields
- **Style:** 32px, 0 10px padding, strong hairline, 6px radius, raised white, 13px text, ink-3 placeholder.
- **Focus:** the border shifts to violet-line with a 3px violet-soft ring; no outline.
- **Labels:** 12–12.5px/500 ink-2 above the field, 6px gap.
- **Error:** 13px failed-text line beneath; no red borders.

### Navigation
- **Sidebar:** brand row (22px violet "TK" mark, "AG-UI" in ink-3 + "TeamKit" in ink at 14px/600), then All rooms and Admin, then a 12px/500 ink-3 "Rooms" group label and `#` room names, then the person and sign-out pinned at the bottom.
- **Items:** 30px, 0 8px, 6px radius, 13px/500 ink-2 with a 16px ink-3 icon. Hover: hover wash, full ink. Current: active-wash grey fill with full ink.
- **Mobile:** the sidebar becomes a drawer with a close button; a menu button joins the page header.

### Avatars
- **Person:** a circle; **agent:** a rounded square. Both take a per-identity hue background (`hsl(h 55% 91%)` with `hsl(h 42% 30%)` initials in light; `hsl(h 28% 24%)` / `hsl(h 70% 82%)` in dark), 42% initials at 600.
- **Live pulse (signature):** an agent holding a task gets a 1.5px claimed-amber ring 3px outside the avatar that scales from 0.92 to 1.18 and fades over 2.2s.

### Thread Panel (signature)
- **Bar:** 52px; status glyph and state name, `#` room in ink-3, then copy-link and close icon buttons.
- **Details:** headline title, ink-2 description, property rows on a 96px label column (13px ink-3 labels, 13px/500 values, 30px rows), an optional sunken result block.
- **Activity:** a hairline-topped 13px/600 heading, then the stream.
- **Messages (Slack):** 32px gutter avatar, 10px gap, bold 14px name, an "Agent" app badge for agents (10px/600 uppercase on sunken grey, 3px radius, Slack's APP tag), 12px tabular time, unboxed 14.5px text. Grouped follow-ups drop the header and show a hover time in the gutter. Rows take the hover wash at 8px radius. Streaming messages end in three 5px typing dots.
- **System lines:** 13px ink-3 with a 6px tone dot (neutral, success, warning, danger) and a right-aligned faint time, like Slack's "joined the channel".
- **Tool calls and reasoning:** fold into one quiet 13px line with a rotating chevron; the body shows 12px mono payloads on sunken grey.
- **Subagents:** nested under a 1px strong-hairline left rule, indented 50px.

### Question Card and Composer (signature)
- **Question card:** strong hairline, 8px radius, 12px 14px padding, in the panel footer above the composer. A blocked glyph plus the kind ("Approval needed", "Question") in 12.5px/600 blocked-text, "from agent" in ink-3; the question at 15px/500; approvers at 12.5px ink-3; choices as buttons with Approve primary; or a free-text input plus send.
- **Composer:** strong hairline, 8px radius, a 14.5px auto-growing textarea, a hint line (11.5px ink-3, keys in ink-2/600) and a 30×28 violet send button with an up-arrow icon that falls back to sunken grey when empty. Focus-within takes the violet ring.

### New Task Dialog
A Linear-style create sheet: 600px, 12px radius, raised white, pop shadow over a 32% scrim, rising 6px over 180ms. A 13px/500 ink-2 title, a borderless 16px/500 brief textarea, two field selects in a grid, and a hairline-topped action row with a kbd hint (18px kbd chips, 4px radius, sans) and Create task primary.

### Admin Tables
8px-radius bordered boxes on raised white; 12px/500 ink-3 headers and 13px cells at 9px 14px padding, hairline row dividers, and a hover wash per row.

## Do's and Don'ts

### Do:
- **Do** follow Linear for board patterns and Slack for thread patterns before inventing anything; the user pinned that canon.
- **Do** reserve violet for the one primary action per area, focus and the selected card (The One Voice Rule).
- **Do** show who holds a task the same way for people and agents: an avatar, circle for a person, rounded square for an agent, with the amber live pulse while an agent works.
- **Do** keep status to 14px glyphs, one kind line and a blocked card's 1px edge (The Small Status Rule).
- **Do** signal hover by strengthening the border from hairline to strong hairline.
- **Do** focus with the violet-line border plus a 3px violet-soft ring on fields and cards, and the 2px violet outline elsewhere.
- **Do** use tokens only, so light and dark swap from the OS with no component branching.

### Don't:
- **Don't** bring back glass, blur or gradient surfaces; the build refuses the old look.
- **Don't** use monospace pills as decoration; mono is for ids, codes and payloads.
- **Don't** add eyebrow or kicker labels above headings.
- **Don't** box chat messages in bubbles; messages are unboxed Slack rows.
- **Don't** fill the current nav item with violet; it takes the grey active wash.
- **Don't** put resting shadows on cards or buttons; shadows belong to the dialog, drawer and thread panel.
- **Don't** tint whole cards or columns with status color.
