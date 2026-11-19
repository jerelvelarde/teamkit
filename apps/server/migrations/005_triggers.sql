-- triggers.secret is the webhook signing secret. The server must sign with it, so it is stored in plaintext
-- and is returned only once, when the trigger is created.
create table triggers (
  id text primary key,
  name text unique not null,
  room_filter text not null,
  kinds text[] not null,
  labels jsonb,
  action jsonb not null,
  secret text,
  cursor bigint not null default 0,
  enabled boolean not null default true,
  created_by text references actors,
  created_at timestamptz not null default clock_timestamp()
);
