alter table public.external_events
  add column if not exists last_nagged_at timestamptz;

create index if not exists external_events_task_nag_idx
  on public.external_events(status, source_id, due_date, last_nagged_at)
  where status = 'active'
    and has_explicit_time = false
    and due_date is not null;
