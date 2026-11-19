create table slack_threads (
  thread_id text primary key references threads,
  channel text,
  ts text,
  conversation_key text unique,
  created_at timestamptz not null default clock_timestamp()
);
create unique index slack_threads_channel_ts_idx on slack_threads (channel, ts) where channel is not null and ts is not null;

-- slack_link_codes.hash stores the sha256 hex of the link code, never the code itself.
create table slack_link_codes (
  hash text primary key,
  slack_user_id text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create table service_cursors (
  name text primary key,
  cursor bigint not null,
  updated_at timestamptz not null default now()
);
