-- Supabase Cron setup for the cloud runtime.
-- Replace PROJECT_REF, SUPABASE_ANON_KEY, and CRON_SECRET before running.
-- The anon key is acceptable here because Edge Functions use their own
-- service-role secret internally. CRON_SECRET adds a private caller check.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobname)
from cron.job
where jobname in (
  'life-os-sync-moodle-calendar',
  'life-os-sync-steam-wishlist',
  'life-os-sync-epic-games',
  'life-os-dispatch-alerts'
);

select cron.schedule(
  'life-os-sync-moodle-calendar',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/sync-moodle-calendar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer SUPABASE_ANON_KEY',
      'x-cron-secret', 'CRON_SECRET'
    ),
    body := jsonb_build_object('trigger', 'supabase-cron')
  );
  $$
);

select cron.schedule(
  'life-os-sync-steam-wishlist',
  '0 */12 * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/sync-steam-wishlist',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer SUPABASE_ANON_KEY',
      'x-cron-secret', 'CRON_SECRET'
    ),
    body := jsonb_build_object('trigger', 'supabase-cron')
  );
  $$
);

select cron.schedule(
  'life-os-sync-epic-games',
  '0 */6 * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/sync-epic-games',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer SUPABASE_ANON_KEY',
      'x-cron-secret', 'CRON_SECRET'
    ),
    body := jsonb_build_object('trigger', 'supabase-cron')
  );
  $$
);

select cron.schedule(
  'life-os-dispatch-alerts',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://PROJECT_REF.supabase.co/functions/v1/dispatch-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer SUPABASE_ANON_KEY',
      'x-cron-secret', 'CRON_SECRET'
    ),
    body := jsonb_build_object('trigger', 'supabase-cron')
  );
  $$
);
