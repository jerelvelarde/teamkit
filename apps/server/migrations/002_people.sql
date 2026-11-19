create table sessions (
  id text primary key,
  actor_id text not null references actors,
  hash text unique not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_actor_idx on sessions (actor_id);

create table signin_links (
  hash text primary key,
  actor_id text not null references actors,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- device_codes.code stores the sha256 hex of the device code, never the code itself.
create table device_codes (
  code text primary key,
  user_code text unique not null,
  actor_id text references actors,
  token_id text references tokens,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz
);

create table slack_links (
  slack_user_id text primary key,
  actor_id text not null references actors,
  created_at timestamptz not null default clock_timestamp()
);
