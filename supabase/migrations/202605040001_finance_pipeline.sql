alter table public.bot_meta
  add column if not exists processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'done', 'failed')),
  add column if not exists processing_started_at timestamptz,
  add column if not exists processed_at timestamptz,
  add column if not exists processed_by text,
  add column if not exists processing_error text;

create index if not exists bot_meta_processing_lookup_idx
  on public.bot_meta (processing_status, updated_at)
  where key like 'expense_log:%' or key like 'action:generate_report:%';

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique references public.bot_meta(key) on delete restrict,
  amount integer not null check (amount > 0),
  currency_code text not null default 'KZT',
  category_guess text not null,
  category_normalized text,
  tags text[] not null default '{}'::text[],
  raw_text text not null,
  chat_id bigint not null,
  timestamp_utc timestamptz not null,
  timestamp_local timestamp not null,
  date date not null,
  week integer not null check (week between 1 and 53),
  month integer not null check (month between 1 and 12),
  created_at timestamptz not null default now()
);

create table if not exists public.expenses_failed (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique references public.bot_meta(key) on delete restrict,
  raw_text text not null,
  chat_id bigint,
  timestamp_utc timestamptz,
  failure_stage text not null default 'parse',
  error_text text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists expenses_date_idx
  on public.expenses (date desc);

create index if not exists expenses_category_date_idx
  on public.expenses (category_normalized, date desc);

create index if not exists expenses_timestamp_utc_idx
  on public.expenses (timestamp_utc desc);

create index if not exists expenses_failed_created_at_idx
  on public.expenses_failed (created_at desc);

alter table public.expenses enable row level security;
alter table public.expenses_failed enable row level security;

create or replace function public.claim_bot_meta_entries(
  prefix_filter text,
  worker_name text,
  batch_size integer default 50,
  stale_after_minutes integer default 15
)
returns table (
  key text,
  value_json jsonb,
  updated_at timestamptz
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
      and (
        coalesce(b.processing_status, 'pending') = 'pending'
        or (
          b.processing_status = 'processing'
          and b.processing_started_at < now() - make_interval(mins => stale_after_minutes)
        )
      )
    order by b.updated_at
    for update skip locked
    limit batch_size
  ),
  claimed as (
    update public.bot_meta b
    set processing_status = 'processing',
        processing_started_at = now(),
        processed_by = worker_name,
        processing_error = null,
        updated_at = now()
    from picked
    where b.key = picked.key
    returning b.key, b.value_json, b.updated_at
  )
  select claimed.key, claimed.value_json, claimed.updated_at
  from claimed;
end;
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
  if final_status not in ('done', 'failed') then
    raise exception 'Unsupported bot_meta final status: %', final_status;
  end if;

  update public.bot_meta
  set processing_status = final_status,
      processed_at = now(),
      processing_error = error_text,
      updated_at = now()
  where key = entry_key;

  if not found then
    raise exception 'bot_meta entry not found: %', entry_key;
  end if;
end;
$$;
