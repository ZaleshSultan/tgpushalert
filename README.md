# Telegram Life OS Alert Bot

Personal Telegram reminder service for Google Tasks, Google Calendar, Moodle LMS deadlines, personal ICS schedules, and game deal alerts.

The project is now a hybrid runtime:

- Supabase Postgres stores sources, normalized events, mute/cooldown state, sync runs, and bot metadata.
- Supabase Edge Functions run ICS sync, game deal sync, alert dispatch, and Telegram webhook commands.
- Supabase Cron invokes sync every 10 minutes and alert dispatch every 5 minutes.
- Python runs only as a Google sync worker. It reads Google Calendar/Tasks and writes normalized rows to Supabase.
- Telegram `/addtask` opens a step-by-step dialog and saves a personal task in `external_events`, optionally with a Telegram image.
- Alert dedup is version-aware: a changed event checksum can trigger the same alert type again without creating cron duplicates.

Moodle is integrated only through the official calendar export ICS URL. No cookies, HTML scraping, or hardcoded credentials are used.

## Architecture

```
Moodle calendar export (ICS)
Personal calendar export (ICS)
Steam public wishlist
Epic Games Store promotions
        |
        v
sync-moodle-calendar Edge Function
sync-steam-wishlist Edge Function
sync-epic-games Edge Function
        |
        v
Supabase Postgres: sources, external_events, notification_state, muted_items, sync_runs
        |
        +--> dispatch-alerts Edge Function --> Telegram messages
        |
        +--> telegram-webhook Edge Function --> /today /status /test /help and inline buttons

Google Calendar/Tasks
        |
        v
Python Google sync worker --> Google Tasks + Supabase external_events
```

Production path: Supabase Edge Functions + Cron + Telegram webhook.

Telegram has a single runtime: `supabase/functions/telegram-webhook`. Python does not call Telegram, does not run aiogram polling, and does not keep mute/dedup state in memory.

## Secrets

Copy `.env.example` to `.env` for local work and fill only your own values.

Required for Supabase Edge Functions:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY` for Cron/webhook invoke commands
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `MOODLE_ICS_URL`
- `PERSONAL_ICS_URL`, optional
- `STEAM_ID64`, required unless `STEAM_VANITY` is set
- `STEAM_VANITY`, optional public vanity profile name, for example `zalewko`
- `STEAM_COUNTRY`, default `KZ`
- `STEAM_LOCALE`, default `russian`
- `STEAM_MIN_DISCOUNT_PERCENT`, default `70`
- `STEAM_MAX_PRICE_KZT`, default `3500`
- `EPIC_COUNTRY`, default `KZ`
- `EPIC_LOCALE`, default `ru`
- `CRON_SECRET`
- `TELEGRAM_WEBHOOK_SECRET`
- `APP_TIMEZONE`, default `Asia/Qyzylorda`
- `ALERT_LOOKAHEAD_HOURS`, default `24`
- `ALERT_COOLDOWN_MINUTES`, default `30`
- `DEFAULT_DATE_ONLY_TASK_REMINDER_HOUR`, default `9`
- `DEFAULT_DATE_ONLY_TASK_REMINDER_MINUTE`, default `0`

Required for the Python Google sync worker:

- `GOOGLE_CREDENTIALS_PATH`, default `credentials.json`
- `GOOGLE_TOKEN_PATH`, default `token.pickle`
- `GOOGLE_TASKLIST_ID`, default `@default`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_SYNC_INTERVAL_SECONDS`, default `300`
- `GOOGLE_CALENDAR_SYNC_DAYS`, default `7`
- `GOOGLE_TASK_SYNC_DAYS`, default `7`

Never commit or archive runtime artifacts:

- `.env`
- `credentials.json`
- `token.pickle`
- `.venv`
- `__pycache__`
- generated local archives such as `.zip`, `.7z`, `.rar`, `.tar`, `.tar.gz`
- service-role keys, Telegram tokens, Moodle ICS URLs, Google OAuth client secrets, or Google OAuth tokens

`.gitignore` excludes these by default, but check archives manually before sharing them.

## Incident Response

If any secret or runtime artifact was accidentally committed, copied into chat, uploaded, or exposed, rotate it before using this bot in production:

- Telegram: revoke/regenerate the bot token in BotFather, then update `TELEGRAM_BOT_TOKEN`.
- Moodle: regenerate the calendar export URL/token, then update `MOODLE_ICS_URL`.
- Supabase: rotate exposed anon/service-role/JWT credentials from the Supabase dashboard, then update Edge Function secrets and local `.env`.
- Google: delete/recreate the OAuth client secret if `credentials.json` leaked; revoke exposed OAuth grants/tokens if `token.pickle` leaked; then re-run local OAuth and replace `GOOGLE_TOKEN_PATH`.

After rotation, remove exposed files from git tracking/history if they were committed, update deployment secrets, and redeploy the functions.

## Python Google Worker

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python main.py
```

`main.py` is a worker-only loop:

- reads Google Calendar and Tasks
- creates pending Google Tasks from `task_commands` if that table is used by another integration
- upserts them into Supabase
- marks previously active Google rows as `missing` when they disappear from a successful sync
- marks completed Google Tasks as `done` when Google returns a completed status
- stores date-only Google Tasks with `has_explicit_time=false`, `due_date`, and `remind_at`
- catches per-loop network/API failures and retries on the next interval
- never sends Telegram messages

Headless production workers do not run `run_local_server()` or open a browser. `token.pickle` must already exist at `GOOGLE_TOKEN_PATH`. Generate it locally with a one-off Google OAuth browser flow, then place it next to the worker. If the token is absent or invalid without a refresh token, the worker exits with a clear error.

The Google token must include Tasks write scope if you use the Python worker to create Google Tasks from `task_commands`. If your existing token was generated when the worker was read-only, regenerate `token.pickle`.

Legacy note: `bot_handlers.py` is kept only as a marker for the retired Python Telegram runtime. It is not imported by `main.py` and aiogram is no longer a dependency.

## Supabase Setup

Install and authenticate the Supabase CLI, then link the project:

```powershell
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

Apply the database migration:

```powershell
supabase db push
```

The migration creates:

- `sources`
- `external_events`
- `notification_state`
- `muted_items`
- `sync_runs`
- `bot_meta`

Later migrations add:

- `external_events.effective_at`, generated from `coalesce(due_at, starts_at)` for stable alert sorting.
- `notification_state.event_checksum` so changed events can alert again safely.
- `external_events.has_explicit_time`, `due_date`, `remind_at`, and `alert_at` for date-only task reminders.
- `task_commands` for optional queued Google Task requests processed by the Python Google worker.

RLS is enabled on all tables. Edge Functions use `SUPABASE_SERVICE_ROLE_KEY` server-side.

## Edge Functions

Set production secrets:

```powershell
supabase secrets set SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
supabase secrets set TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
supabase secrets set TELEGRAM_CHAT_ID=YOUR_CHAT_ID
supabase secrets set MOODLE_ICS_URL="YOUR_MOODLE_ICS_EXPORT_URL"
supabase secrets set PERSONAL_ICS_URL="YOUR_PERSONAL_ICS_EXPORT_URL"
supabase secrets set STEAM_ID64=YOUR_PUBLIC_STEAM_ID64
supabase secrets set STEAM_VANITY=zalewko
supabase secrets set STEAM_COUNTRY=KZ
supabase secrets set STEAM_LOCALE=russian
supabase secrets set STEAM_MIN_DISCOUNT_PERCENT=70
supabase secrets set STEAM_MAX_PRICE_KZT=3500
supabase secrets set EPIC_COUNTRY=KZ
supabase secrets set EPIC_LOCALE=ru
supabase secrets set CRON_SECRET=YOUR_RANDOM_CRON_SECRET
supabase secrets set TELEGRAM_WEBHOOK_SECRET=YOUR_RANDOM_WEBHOOK_SECRET
supabase secrets set APP_TIMEZONE=Asia/Qyzylorda
supabase secrets set ALERT_LOOKAHEAD_HOURS=24
supabase secrets set ALERT_COOLDOWN_MINUTES=30
supabase secrets set DEFAULT_DATE_ONLY_TASK_REMINDER_HOUR=9
supabase secrets set DEFAULT_DATE_ONLY_TASK_REMINDER_MINUTE=0
```

Deploy:

```powershell
supabase functions deploy sync-moodle-calendar
supabase functions deploy sync-steam-wishlist
supabase functions deploy sync-epic-games
supabase functions deploy dispatch-alerts
supabase functions deploy telegram-webhook --no-verify-jwt
```

Local function checks, if Deno is installed:

```powershell
Set-Location supabase\functions
deno task check
Set-Location ..\..
```

Local serve:

```powershell
supabase functions serve --env-file .env
```

## Telegram Webhook

After deploying `telegram-webhook`, register it with Telegram:

```powershell
$url = "https://YOUR_PROJECT_REF.supabase.co/functions/v1/telegram-webhook"
Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/setWebhook" `
  -Body @{ url = $url; secret_token = $env:TELEGRAM_WEBHOOK_SECRET }
```

Then test in Telegram:

- `/test` should reply with a test message.
- `/status` should show active sources, active events, and latest sync.
- `/today` should show today's active deadlines/events from Supabase.
- `/addtask` should start a dialog: details, deadline, optional image.
- `/cancel` should cancel the active task dialog.

Check which Telegram runtime is active:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

`url` should be `https://YOUR_PROJECT_REF.supabase.co/functions/v1/telegram-webhook`. Do not run a Python Telegram polling process for this bot.

## Telegram Commands Menu

Run this one-time setup after `TELEGRAM_BOT_TOKEN` is set in `.env`:

```bash
source .venv/Scripts/activate
python scripts/setup_telegram_menu.py
```

This calls Telegram `setMyCommands` and sets the default private-chat `setChatMenuButton` to `commands`, which shows the menu button next to the message input.

To configure the menu for one specific private chat instead:

```bash
source .venv/Scripts/activate
python scripts/setup_telegram_menu.py --chat-id "$TELEGRAM_CHAT_ID"
```

To update the list later, edit `COMMANDS` in `scripts/setup_telegram_menu.py` and rerun the same command.

## Moodle ICS

In Moodle, export the calendar with a URL like:

```text
https://.../calendar/export_execute.php?...&authtoken=TOKEN_VALUE&preset_what=all&preset_time=custom
```

Store Moodle only as `MOODLE_ICS_URL` in Supabase secrets or local env. You can also set optional `PERSONAL_ICS_URL` for a personal schedule feed. The same sync function fetches configured ICS feeds, parses `UID`, `SUMMARY`, `DESCRIPTION`, `DTSTART`, `DTEND`, `DUE`, `URL`, and `LOCATION`, then upserts into `external_events` by `(source_id, external_id)`.

For Moodle, `DTSTART` is still treated as `due_at`, because Moodle exports many assignment deadlines that way. For `PERSONAL_ICS_URL`, `DTSTART` stays as `starts_at` and `due_at` is set only when the ICS event has an explicit `DUE`, so pairs, trainings, and other calendar events are formatted as schedule items instead of deadlines.

The parser respects `TZID` on `DTSTART`, `DTEND`, and `DUE`, supports `VALUE=DATE`, UTC timestamps ending in `Z`, floating local datetimes, and local datetimes with `TZID`. Floating values use `APP_TIMEZONE`. Unknown `TZID` values fall back to `APP_TIMEZONE`, or to `UTC` if `APP_TIMEZONE` is invalid; the function logs that fallback.

If an event disappears from the ICS feed, it is not deleted. Its `status` becomes `missing`.

## Cron

Edit `supabase/cron.sql` and replace:

- `PROJECT_REF`
- `SUPABASE_ANON_KEY`
- `CRON_SECRET`

Run the SQL in the Supabase SQL editor.

Schedules:

- `sync-moodle-calendar`: every 10 minutes; syncs Moodle plus optional personal ICS feeds
- `sync-steam-wishlist`: every 12 hours; checks public Steam wishlist discounts. It first tries Steam `wishlistdata`, then falls back to the public wishlist HTML page plus `api/appdetails` when Steam returns HTML instead of JSON. If Steam's HTML shell no longer embeds app IDs, it uses the public wishlist service to recover the app list before checking prices. Steam deals are sent only when the game is free, discount is at least `STEAM_MIN_DISCOUNT_PERCENT`, or final price is at most `STEAM_MAX_PRICE_KZT`.
- `sync-epic-games`: every 6 hours; checks active Epic Games free giveaways
- `dispatch-alerts`: every 5 minutes

The Cron jobs invoke Edge Functions with the anon key plus `x-cron-secret`. The functions use service-role credentials from their own secrets.

`dispatch-alerts` uses `ALERT_LOOKAHEAD_HOURS` as the forward selection window and sorts by `external_events.alert_at`. For date-only Google Tasks, `alert_at` comes from `remind_at`, which is the task date at `DEFAULT_DATE_ONLY_TASK_REMINDER_HOUR:DEFAULT_DATE_ONLY_TASK_REMINDER_MINUTE` in `APP_TIMEZONE`.

Date-only Google Tasks are shown as `без времени` in `/today` and alert messages; the system does not display the artificial midnight/05:00 timestamp from Google Tasks.

## Manual Function Tests

```powershell
$base = "https://YOUR_PROJECT_REF.supabase.co/functions/v1"
$headers = @{
  Authorization = "Bearer $env:SUPABASE_ANON_KEY"
  "x-cron-secret" = $env:CRON_SECRET
}

Invoke-RestMethod -Method Post -Uri "$base/sync-moodle-calendar" -Headers $headers
Invoke-RestMethod -Method Post -Uri "$base/sync-steam-wishlist" -Headers $headers
Invoke-RestMethod -Method Post -Uri "$base/sync-epic-games" -Headers $headers
Invoke-RestMethod -Method Post -Uri "$base/dispatch-alerts" -Headers $headers
```

## Troubleshooting

- `Missing MOODLE_ICS_URL`: set the secret in Supabase and invoke `sync-moodle-calendar` again.
- Personal ICS is not syncing: set optional `PERSONAL_ICS_URL`; when it is absent, that source is skipped without failing the function.
- `Missing CRON_SECRET`: set `CRON_SECRET`; scheduled functions now require it.
- `Missing TELEGRAM_WEBHOOK_SECRET`: set the secret and register the webhook with the same `secret_token`.
- Telegram webhook does not answer: check `TELEGRAM_WEBHOOK_SECRET`, webhook URL, and Edge Function logs.
- Cron returns unauthorized: make sure `CRON_SECRET` in `supabase/cron.sql` matches the Supabase secret.
- `/today` is empty: run `sync-moodle-calendar`, confirm rows exist in `external_events`, and check `APP_TIMEZONE`.
- `/addtask` does not continue the dialog: check `bot_meta` rows with keys like `telegram_addtask:<chat_id>` and Edge Function logs.
- Date-only tasks alert at the wrong time: check `DEFAULT_DATE_ONLY_TASK_REMINDER_HOUR`, `DEFAULT_DATE_ONLY_TASK_REMINDER_MINUTE`, and `APP_TIMEZONE`, then let the Python worker sync again.
- Duplicate alerts: inspect `notification_state`; each `(event_id, alert_type)` is one row, and `event_checksum` should match the current `external_events.checksum`.
- Moodle changes not reflected: verify the ICS export URL still works in a browser and has not been regenerated.
- Python worker exits with `Missing Google OAuth token file`: generate `token.pickle` locally and copy it to `GOOGLE_TOKEN_PATH`; the worker is intentionally headless and will not open a browser.
- Python worker exits with missing Supabase credentials: set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; Python writes to Supabase and has no local alert state.

## Reference Docs

- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Supabase Function secrets: https://supabase.com/docs/guides/functions/secrets
- Supabase Cron: https://supabase.com/docs/guides/cron
- pg_net Edge Function invocation: https://supabase.com/docs/guides/database/extensions/pg_net
# tgpushalert
