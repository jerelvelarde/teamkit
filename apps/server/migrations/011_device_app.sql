-- The app an agent-mode device code connects (claude or codex), so the approval names the agent
-- after it: ana-claude, ana-codex. Null for admin logins and for agents connected without an app.
-- The server checks the value against the protocol's AGENT_APPS, so a new app needs no migration.
alter table device_codes add column app text;
