-- Each lead agent gets its own wake-up thread in each room. Lead agents sharing one thread per room
-- read each other's wake-ups as their own history.
create table lead_threads (
  room text not null references rooms,
  agent_id text not null references actors,
  thread_id text not null references threads,
  primary key (room, agent_id)
);

-- A room's shared lead thread stays with the agent that opened it.
insert into lead_threads (room, agent_id, thread_id)
select r.name, t.created_by, r.lead_thread_id
from rooms r
join threads t on t.id = r.lead_thread_id
join actors a on a.id = t.created_by and a.kind = 'agent';

alter table rooms drop column lead_thread_id;
