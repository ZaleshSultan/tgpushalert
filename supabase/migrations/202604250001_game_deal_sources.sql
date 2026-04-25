alter table public.sources
  drop constraint if exists sources_kind_check;

alter table public.sources
  add constraint sources_kind_check
  check (
    kind in (
      'google_tasks',
      'google_calendar',
      'moodle_ics',
      'personal_ics',
      'personal_tasks',
      'steam_wishlist',
      'epic_games'
    )
  );

insert into public.sources (kind, name, is_enabled)
values
  ('steam_wishlist', 'Steam Wishlist', true),
  ('epic_games', 'Epic Games Store', true)
on conflict (kind, name) do nothing;
