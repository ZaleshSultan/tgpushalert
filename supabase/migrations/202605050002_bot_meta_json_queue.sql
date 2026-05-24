DROP FUNCTION IF EXISTS public.claim_bot_meta_entries(integer, integer, integer, boolean);

create or replace function public.claim_bot_meta_entries(
  limit_size integer default 25,
  max_attempts integer default 3,
  stale_after_minutes integer default 5,
  failed_only boolean default false
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
    where coalesce(
      case
        when jsonb_typeof(b.value_json -> 'processing_attempts') = 'number'
          then (b.value_json ->> 'processing_attempts')::integer
        when coalesce(b.value_json ->> 'processing_attempts', '') ~ '^\d+$'
          then (b.value_json ->> 'processing_attempts')::integer
        else 0
      end,
      0
    ) < max_attempts
      and (
        (
          not failed_only
          and (
            coalesce(b.value_json ->> 'status', 'pending') = 'pending'
            or (
              coalesce(b.value_json ->> 'status', 'pending') = 'in_progress'
              and b.updated_at < now() - make_interval(mins => stale_after_minutes)
            )
          )
        )
        or (
          failed_only
          and coalesce(b.value_json ->> 'status', 'pending') = 'failed'
        )
      )
    order by b.updated_at, b.key
    for update skip locked
    limit limit_size
  ),
  claimed as (
    update public.bot_meta b
    set value_json = jsonb_set(
          jsonb_set(
            coalesce(b.value_json, '{}'::jsonb),
            '{status}',
            to_jsonb('in_progress'::text),
            true
          ),
          '{processing_attempts}',
          to_jsonb(
            coalesce(
              case
                when jsonb_typeof(b.value_json -> 'processing_attempts') = 'number'
                  then (b.value_json ->> 'processing_attempts')::integer
                when coalesce(b.value_json ->> 'processing_attempts', '') ~ '^\d+$'
                  then (b.value_json ->> 'processing_attempts')::integer
                else 0
              end,
              0
            ) + 1
          ),
          true
        ),
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
  if final_status not in ('pending', 'done', 'failed') then
    raise exception 'Unsupported bot_meta final status: %', final_status;
  end if;

  update public.bot_meta
  set value_json = jsonb_set(
        jsonb_set(
          coalesce(value_json, '{}'::jsonb),
          '{status}',
          to_jsonb(final_status),
          true
        ),
        '{processing_error}',
        coalesce(to_jsonb(error_text), 'null'::jsonb),
        true
      ),
      updated_at = now()
  where key = entry_key;

  if not found then
    raise exception 'bot_meta entry not found: %', entry_key;
  end if;
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
    and coalesce(
      case
        when jsonb_typeof(b.value_json -> 'processing_attempts') = 'number'
          then (b.value_json ->> 'processing_attempts')::integer
        when coalesce(b.value_json ->> 'processing_attempts', '') ~ '^\d+$'
          then (b.value_json ->> 'processing_attempts')::integer
        else 0
      end,
      0
    ) < max_attempts
    and (
      (
        not failed_only
        and (
          coalesce(b.value_json ->> 'status', 'pending') = 'pending'
          or (
            coalesce(b.value_json ->> 'status', 'pending') = 'in_progress'
            and b.updated_at < now() - make_interval(mins => stale_after_minutes)
          )
        )
      )
      or (
        failed_only
        and coalesce(b.value_json ->> 'status', 'pending') = 'failed'
      )
    );
$$;
