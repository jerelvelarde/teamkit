-- Named approvers live in tasks.block (jsonb) and need no column.

-- A hold: a handed-off task, or an answered ask, kept for one actor until reserved_until.
alter table tasks
  add column reserved_for text references actors,
  add column reserved_until timestamptz,
  add column reservation_kind text check (reservation_kind in ('handoff', 'answer')),
  add constraint tasks_hold_whole check (
    (reserved_for is null) = (reserved_until is null) and (reserved_for is null) = (reservation_kind is null));
create index tasks_reserved_until_idx on tasks (reserved_until) where reserved_until is not null;
create index tasks_reserved_for_idx on tasks (reserved_for) where reserved_for is not null;

alter table rooms add column reservation_minutes int not null default 30
  check (reservation_minutes between 1 and 1440);

create table decisions (
  id text primary key,
  room text not null references rooms,
  thread_id text not null references threads,
  text text not null,
  decided_by text not null references actors,
  posted_by text not null references actors,
  created_at timestamptz not null default clock_timestamp()
);
create index decisions_room_created_idx on decisions (room, created_at desc);

create table decision_acks (
  decision_id text not null references decisions,
  actor_id text not null references actors,
  at timestamptz not null default clock_timestamp(),
  primary key (decision_id, actor_id)
);

create table rollcalls (
  id text primary key,
  room text not null references rooms,
  thread_id text not null references threads,
  asked_by text not null references actors,
  created_at timestamptz not null default clock_timestamp()
);
create index rollcalls_room_created_idx on rollcalls (room, created_at desc);

create table rollcall_answers (
  rollcall_id text not null references rollcalls,
  actor_id text not null references actors,
  status text not null,
  at timestamptz not null default clock_timestamp(),
  primary key (rollcall_id, actor_id)
);

-- One row per token, so each install reports its own presence. Polled, never an event.
create table presence (
  token_id text primary key references tokens,
  actor_id text not null references actors,
  watching text[] not null,
  status text,
  last_seen_at timestamptz not null default clock_timestamp()
);
create index presence_last_seen_idx on presence (last_seen_at);

-- Names and short identifiers only: TeamKit stores no secret values.
create table changes (
  id text primary key,
  room text not null references rooms,
  thread_id text references threads,
  what text not null,
  where_text text not null,
  at timestamptz not null,
  person_id text not null references actors,
  agent_id text references actors,
  undo text not null,
  undo_when text,
  status text not null default 'active' check (status in ('active', 'done', 'restored')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index changes_room_at_idx on changes (room, at desc);

create table alerts (
  id text primary key,
  room text not null references rooms,
  thread_id text not null references threads,
  text text not null,
  level text not null default 'suspected' check (level in ('suspected', 'confirmed')),
  raised_by text not null references actors,
  confirmed_by text references actors,
  source text references actors,
  confirmed_at timestamptz,
  -- An alert is open until a person (or an agent for its owner) resolves it.
  resolved_by text references actors,
  resolved_source text references actors,
  resolved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint alerts_resolve_whole check (
    (resolved_by is null) = (resolved_at is null) and (resolved_by is null) = (resolved_source is null))
);
create index alerts_room_created_idx on alerts (room, created_at desc);
create index alerts_open_idx on alerts (room, created_at desc) where resolved_at is null;
