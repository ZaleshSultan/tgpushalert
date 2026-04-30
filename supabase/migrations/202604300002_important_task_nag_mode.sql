alter table public.external_events
  add column if not exists is_important boolean not null default false;

alter table public.external_events
  add column if not exists last_nagged_at timestamptz;

create index if not exists external_events_important_nag_idx
  on public.external_events(status, source_id, is_important, alert_at, last_nagged_at)
  where status = 'active'
    and is_important = true;
