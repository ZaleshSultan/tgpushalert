import time
from datetime import datetime, timezone

from config import (
    GOOGLE_CALENDAR_SYNC_DAYS,
    GOOGLE_SYNC_INTERVAL_SECONDS,
    GOOGLE_TASK_SYNC_DAYS,
)
from google_api import create_task, get_tasks_for_sync, get_upcoming_events, validate_google_token_file
from supabase_store import is_configured as supabase_is_configured
from supabase_store import (
    get_pending_task_commands,
    mark_task_command_error,
    mark_task_command_processing,
    mark_task_command_succeeded,
    sync_google_sources_to_supabase,
)


def run_sync_once() -> tuple[int, int, int]:
    command_count = process_pending_task_commands()
    calendar_events = get_upcoming_events(days=GOOGLE_CALENDAR_SYNC_DAYS)
    tasks = get_tasks_for_sync(lookahead_days=GOOGLE_TASK_SYNC_DAYS)
    sync_google_sources_to_supabase(calendar_events, tasks)
    return len(calendar_events), len(tasks), command_count


def process_pending_task_commands() -> int:
    processed = 0
    for command in get_pending_task_commands():
        command_id = command["id"]
        try:
            mark_task_command_processing(command_id)
            task = create_task(
                title=command["title"],
                due_date=command["due_date"],
                due_time=command.get("due_time"),
                timezone_name=command["timezone"],
                command_id=command_id,
            )
            mark_task_command_succeeded(command_id, task.get("id", ""))
            processed += 1
        except Exception as exc:
            mark_task_command_error(command_id, str(exc))
            print(f"Task command {command_id} failed: {exc}")
    return processed


def worker_loop() -> None:
    validate_startup()
    print("Google sync worker started. Telegram runtime is Supabase Edge Functions only.")

    while True:
        started_at = datetime.now(timezone.utc)
        try:
            event_count, task_count, command_count = run_sync_once()
            print(
                f"{started_at.isoformat()} synced "
                f"{event_count} calendar events and {task_count} tasks to Supabase; "
                f"processed {command_count} task commands",
            )
        except Exception as exc:
            print(f"{started_at.isoformat()} Google sync failed: {exc}")

        time.sleep(GOOGLE_SYNC_INTERVAL_SECONDS)


def validate_startup() -> None:
    if not supabase_is_configured():
        raise RuntimeError(
            "Google sync worker requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
        )
    validate_google_token_file()


if __name__ == "__main__":
    worker_loop()
