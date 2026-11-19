-- join_links.hash stores the sha256 hex of the join link's secret, never the secret itself.
create table join_links (
  id text primary key,
  hash text unique not null,
  created_by text references actors,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  domains text[],
  revoked_at timestamptz,
  uses int not null default 0
);

-- A person's email, lower-cased, so an emailed sign-in link finds exactly one person.
alter table actors add column email text;
create unique index actors_email_idx on actors (email) where email is not null;

-- How a device code signs in: as an admin login, or as the approving person's own agent.
alter table device_codes add column mode text not null default 'admin' check (mode in ('admin', 'agent'));
