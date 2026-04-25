create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('google_tasks', 'google_calendar', 'moodle_ics')),
  name text not null,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, name)
);

create table if not exists public.external_events (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id) on delete cascade,
  external_id text not null,
  title text not null,
  description text,
  location text,
  starts_at timestamptz,
  ends_at timestamptz,
  due_at timestamptz,
  raw_payload_json jsonb not null default '{}'::jsonb,
  checksum text,
  status text not null default 'active' check (status in ('active', 'missing', 'done', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_id)
);

create table if not exists public.notification_state (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.external_events(id) on delete cascade,
  alert_type text not null,
  notified_at timestamptz,
  cooldown_until timestamptz,
  unique (event_id, alert_type)
);

create table if not exists public.muted_items (
  id uuid primary key default gen_random_uuid(),
  item_kind text not null,
  item_ref text not null,
  muted_until timestamptz not null,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.sources(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'error')),
  items_seen integer not null default 0,
  items_upserted integer not null default 0,
  error_text text
);

create table if not exists public.bot_meta (
  key text primary key,
  value_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists sources_set_updated_at on public.sources;
create trigger sources_set_updated_at
before update on public.sources
for each row execute function public.set_updated_at();

drop trigger if exists external_events_set_updated_at on public.external_events;
create trigger external_events_set_updated_at
before update on public.external_events
for each row execute function public.set_updated_at();

create index if not exists sources_kind_enabled_idx
  on public.sources(kind, is_enabled);

create index if not exists external_events_source_status_due_idx
  on public.external_events(source_id, status, due_at);

create index if not exists external_events_due_idx
  on public.external_events(due_at)
  where due_at is not null;

create index if not exists external_events_starts_idx
  on public.external_events(starts_at)
  where starts_at is not null;

create index if not exists notification_state_event_alert_idx
  on public.notification_state(event_id, alert_type);

create index if not exists muted_items_active_idx
  on public.muted_items(item_kind, item_ref, muted_until);

create index if not exists sync_runs_source_started_idx
  on public.sync_runs(source_id, started_at desc);

alter table public.sources enable row level security;
alter table public.external_events enable row level security;
alter table public.notification_state enable row level security;
alter table public.muted_items enable row level security;
alter table public.sync_runs enable row level security;
alter table public.bot_meta enable row level security;

insert into public.sources (kind, name, is_enabled)
values
  ('moodle_ics', 'Moodle LMS', true),
  ('google_tasks', 'Google Tasks', true),
  ('google_calendar', 'Google Calendar', true)
on conflict (kind, name) do nothing;
