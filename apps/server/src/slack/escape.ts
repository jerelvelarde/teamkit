/**
 * Escape text that came from an agent or a person before it goes into a Slack
 * mrkdwn field. Slack's own rule: `&`, `<` and `>` become entities, so
 * `<!channel>`, `<@U123>` and `<http://x|y>` render as plain text. The Markdown
 * link form `[a](url)` would be turned into `<url|a>` by the renderer, so the
 * `](` pair is split with a zero-width space.
 */
export function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\]\(/g, "]​(");
}
