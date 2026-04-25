alter table public.external_events
  add column if not exists has_explicit_time boolean not null default true;

alter table public.external_events
  add column if not exists due_date date;

alter table public.external_events
  add column if not exists remind_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'external_events'
      and column_name = 'alert_at'
  ) then
    alter table public.external_events
      add column alert_at timestamptz
      generated always as (coalesce(remind_at, due_at, starts_at)) stored;
  end if;
end;
$$;

create index if not exists external_events_status_alert_idx
  on public.external_events(status, alert_at)
  where alert_at is not null;

create table if not exists public.task_commands (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  title text not null,
  due_date date not null,
  due_time text,
  timezone text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'succeeded', 'error')),
  google_tasklist_id text,
  google_task_id text,
  error_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);

drop trigger if exists task_commands_set_updated_at on public.task_commands;
create trigger task_commands_set_updated_at
before update on public.task_commands
for each row execute function public.set_updated_at();

create index if not exists task_commands_status_created_idx
  on public.task_commands(status, created_at);

alter table public.task_commands enable row level security;
