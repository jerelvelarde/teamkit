create table agents (
  name text primary key,
  actor_id text not null unique references actors,
  url text not null,
  headers jsonb not null default '{}',
  rooms text[] not null,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);
