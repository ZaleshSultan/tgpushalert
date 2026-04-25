alter table public.notification_state
  add column if not exists event_checksum text;

update public.notification_state ns
set event_checksum = coalesce(ee.checksum, '')
from public.external_events ee
where ns.event_id = ee.id
  and ns.event_checksum is null;

create index if not exists notification_state_event_alert_checksum_idx
  on public.notification_state(event_id, alert_type, event_checksum);

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'external_events'
      and column_name = 'effective_at'
  ) then
    alter table public.external_events
      add column effective_at timestamptz
      generated always as (coalesce(due_at, starts_at)) stored;
  end if;
end;
$$;

create index if not exists external_events_status_effective_idx
  on public.external_events(status, effective_at)
  where effective_at is not null;
