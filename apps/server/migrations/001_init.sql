create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table actors (
  id text primary key,
  kind text check (kind in ('agent','person')),
  name text unique not null,
  owner_id text references actors,
  role text check (role in ('admin','member')),
  created_at timestamptz not null default now()
);

create table tokens (
  id text primary key,
  actor_id text not null references actors,
  hash text unique not null,
  scope text not null check (scope in ('agent','admin')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table grants (
  actor_id text references actors,
  room_pattern text not null,
  perms text[] not null,
  primary key (actor_id, room_pattern)
);

create table rooms (
  name text primary key,
  created_at timestamptz not null default now(),
  agent text,
  approvers text[],
  slack_channel text,
  slack_announce text not null default 'blocked' check (slack_announce in ('blocked','all','none')),
  lead_thread_id text
);

create table threads (
  id text primary key,
  room text not null references rooms,
  is_task boolean not null,
  labels jsonb not null default '{}',
  created_by text not null references actors,
  created_at timestamptz not null default now()
);

create table tasks (
  thread_id text primary key references threads,
  state text not null check (state in ('waiting','ready','claimed','blocked','completed','failed')),
  brief text not null,
  target text,
  claim_id text,
  claimed_by text references actors,
  lease_expires_at timestamptz,
  block jsonb,
  pending_resume jsonb,
  result text,
  attempts int not null default 0,
  updated_at timestamptz not null default now()
);

create table task_needs (
  task_id text references tasks,
  needs_id text references tasks,
  primary key (task_id, needs_id)
);

create table messages (
  thread_id text references threads,
  seq int,
  message jsonb not null,
  created_at timestamptz not null default now(),
  primary key (thread_id, seq)
);

create table events (
  cursor bigserial primary key,
  kind text not null,
  room text not null,
  thread_id text,
  actor_id text,
  agui jsonb not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index tasks_state_lease_idx on tasks (state, lease_expires_at);
create index tasks_ready_idx on tasks (state) where state = 'ready';
create index events_room_cursor_idx on events (room, cursor);
create index events_thread_cursor_idx on events (thread_id, cursor);
create index threads_room_created_idx on threads (room, created_at);
create index task_needs_needs_idx on task_needs (needs_id);
