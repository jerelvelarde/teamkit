-- A task's Slack parent message stays in slack_threads (004_slack.sql).

-- The one pinned status message per room linked to a Slack channel, edited in place.
-- body_hash is a sha256 of the status last shown, so an unchanged status is never sent again.
create table slack_status_messages (
  room text primary key references rooms,
  channel text not null,
  ts text not null,
  pinned boolean not null default false,
  body_hash text not null,
  edited_at timestamptz not null
);

-- The top-level Slack message for each decision and alert. loud is true once an alert has
-- been posted with @here, so a confirmation never notifies the channel twice.
create table slack_posts (
  kind text not null check (kind in ('decision', 'alert')),
  ref_id text not null,
  channel text not null,
  ts text not null,
  loud boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  primary key (kind, ref_id)
);
