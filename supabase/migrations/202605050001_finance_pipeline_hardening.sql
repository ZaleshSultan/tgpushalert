alter table public.bot_meta
  add column if not exists processing_attempts integer not null default 0;

update public.bot_meta
set processing_attempts = 0
where processing_attempts is null;

alter table public.bot_meta
  drop constraint if exists bot_meta_processing_status_check;

update public.bot_meta
set processing_status = 'in_progress'
where processing_status = 'processing';

alter table public.bot_meta
  alter column processing_status set default 'pending';

alter table public.bot_meta
  add constraint bot_meta_processing_status_check
  check (processing_status in ('pending', 'in_progress', 'done', 'failed'));

create index if not exists bot_meta_queue_recovery_idx
  on public.bot_meta (processing_status, processing_started_at, processing_attempts, updated_at)
  where key like 'expense_log:%' or key like 'action:generate_report:%';

do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'expenses'
      and indexdef ilike 'create unique index%source_key%'
  ) then
    create unique index expenses_source_key_unique_idx
      on public.expenses (source_key);
  end if;
end;
$$;

alter table public.expenses
  add column if not exists confidence numeric(4,3) not null default 0.0,
  add column if not exists parse_version text not null default 'v1',
  add column if not exists iso_week integer,
  add column if not exists iso_year integer;

alter table public.expenses
  drop constraint if exists expenses_confidence_check;

alter table public.expenses
  add constraint expenses_confidence_check
  check (confidence >= 0.0 and confidence <= 1.0);

update public.expenses
set iso_week = coalesce(iso_week, extract(week from timestamp_local)::integer),
    iso_year = coalesce(iso_year, extract(isoyear from timestamp_local)::integer),
    week = coalesce(week, extract(week from timestamp_local)::integer),
    month = coalesce(month, extract(month from timestamp_local)::integer)
where iso_week is null
   or iso_year is null
   or week is null
   or month is null;

alter table public.expenses
  alter column iso_week set not null,
  alter column iso_year set not null;

create index if not exists expenses_iso_week_idx
  on public.expenses (iso_year desc, iso_week desc, timestamp_local asc);

create or replace function public.claim_bot_meta_entries(
  prefix_filter text,
  worker_name text,
  batch_size integer default 25,
  stale_after_minutes integer default 5,
  max_attempts integer default 3,
  failed_only boolean default false
)
returns table (
  key text,
  value_json jsonb,
  updated_at timestamptz,
  processing_attempts integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select b.key
    from public.bot_meta b
    where b.key like prefix_filter || '%'
      and coalesce(b.processing_attempts, 0) < max_attempts
      and (
        (
          not failed_only
          and (
            coalesce(b.processing_status, 'pending') = 'pending'
            or (
              b.processing_status = 'in_progress'
              and b.processing_started_at < now() - make_interval(mins => stale_after_minutes)
            )
          )
        )
        or (
          failed_only
          and b.processing_status = 'failed'
        )
      )
    order by b.updated_at, b.key
    for update skip locked
    limit batch_size
  ),
  claimed as (
    update public.bot_meta b
    set processing_status = 'in_progress',
        processing_started_at = now(),
        processing_attempts = coalesce(b.processing_attempts, 0) + 1,
        processed_at = null,
        processed_by = worker_name,
        processing_error = null,
        updated_at = now()
    from picked
    where b.key = picked.key
    returning b.key, b.value_json, b.updated_at, b.processing_attempts
  )
  select claimed.key, claimed.value_json, claimed.updated_at, claimed.processing_attempts
  from claimed;
end;
$$;

create or replace function public.estimate_bot_meta_queue(
  prefix_filter text,
  stale_after_minutes integer default 5,
  max_attempts integer default 3,
  failed_only boolean default false
)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.bot_meta b
  where b.key like prefix_filter || '%'
    and coalesce(b.processing_attempts, 0) < max_attempts
    and (
      (
        not failed_only
        and (
          coalesce(b.processing_status, 'pending') = 'pending'
          or (
            b.processing_status = 'in_progress'
            and b.processing_started_at < now() - make_interval(mins => stale_after_minutes)
          )
        )
      )
      or (
        failed_only
        and b.processing_status = 'failed'
      )
    );
$$;

create or replace function public.complete_bot_meta_entry(
  entry_key text,
  final_status text,
  error_text text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if final_status not in ('pending', 'done', 'failed') then
    raise exception 'Unsupported bot_meta final status: %', final_status;
  end if;

  update public.bot_meta
  set processing_status = final_status,
      processed_at = case when final_status = 'pending' then null else now() end,
      processing_started_at = null,
      processing_error = error_text,
      updated_at = now()
  where key = entry_key;

  if not found then
    raise exception 'bot_meta entry not found: %', entry_key;
  end if;
end;
$$;
