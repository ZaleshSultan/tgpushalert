create table if not exists public.event_user_actions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.external_events(id) on delete cascade,
  chat_id text not null,
  action text not null check (
    action in ('done', 'later', 'no_money', 'not_interested')
  ),
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, chat_id)
);

drop trigger if exists event_user_actions_set_updated_at on public.event_user_actions;
create trigger event_user_actions_set_updated_at
before update on public.event_user_actions
for each row execute function public.set_updated_at();

create index if not exists event_user_actions_event_idx
  on public.event_user_actions(event_id, updated_at desc);

alter table public.event_user_actions enable row level security;
