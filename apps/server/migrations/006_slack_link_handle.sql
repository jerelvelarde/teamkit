-- The Slack handle a link code was made for, shown on the link page next to the Slack user id so a
-- person sees which Slack account they are about to link. Slack supplies it; it is display text only.
alter table slack_link_codes add column slack_user_name text;
alter table slack_links add column slack_user_name text;

-- "My linked Slack accounts" reads slack_links by person.
create index slack_links_actor_id_idx on slack_links (actor_id);
-- Each new link code deletes the expired ones.
create index slack_link_codes_expires_at_idx on slack_link_codes (expires_at);
