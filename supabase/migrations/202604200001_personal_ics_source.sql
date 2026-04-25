alter table public.sources
  drop constraint if exists sources_kind_check;

alter table public.sources
  add constraint sources_kind_check
  check (kind in ('google_tasks', 'google_calendar', 'moodle_ics', 'personal_ics'));

insert into public.sources (kind, name, is_enabled)
values ('personal_ics', 'Personal Schedule', true)
on conflict (kind, name) do nothing;
