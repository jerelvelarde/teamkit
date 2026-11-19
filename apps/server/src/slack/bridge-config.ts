/**
 * Slack bridge settings, read from the environment. This module stays import-free so that
 * config.ts can read it without loading Channels, the runtime or the Slack handlers.
 */
export interface SlackBridgeConfig {
  intelligenceApiKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  channelName?: string;
  /** The web board's public origin, for links shown in Slack. */
  publicUrl: string;
  /** The room a mention lands in when its Slack channel is not mapped to one. */
  defaultRoom: string | null;
}

function optVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === "" ? undefined : raw;
}

export function slackBridgeConfigFromEnv(env: NodeJS.ProcessEnv, publicUrl: string): SlackBridgeConfig {
  return {
    intelligenceApiKey: optVar(env, "CPK_INTELLIGENCE_API_KEY"),
    intelligenceApiUrl: optVar(env, "CPK_INTELLIGENCE_API_URL"),
    intelligenceWsUrl: optVar(env, "CPK_INTELLIGENCE_WS_URL"),
    channelName: optVar(env, "TEAMKIT_SLACK_CHANNEL_NAME"),
    publicUrl,
    defaultRoom: optVar(env, "TEAMKIT_SLACK_DEFAULT_ROOM") ?? null,
  };
}

/** True when both the Intelligence API key and the Channel name are set. */
export function slackBridgeEnabled(
  c: SlackBridgeConfig,
): c is SlackBridgeConfig & { intelligenceApiKey: string; channelName: string } {
  return Boolean(c.intelligenceApiKey && c.channelName);
}
