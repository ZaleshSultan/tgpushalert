import json
import os
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from config import (
    GOOGLE_CALENDAR_SYNC_DAYS,
    GOOGLE_SYNC_INTERVAL_SECONDS,
    GOOGLE_TASK_SYNC_DAYS,
)
from google_api import create_task, get_tasks_for_sync, get_upcoming_events, validate_google_token_file
from supabase_store import is_configured as supabase_is_configured
from supabase_store import (
    delete_bot_meta_keys,
    get_expense_logs,
    get_pending_reports,
    get_pending_task_commands,
    mark_task_command_error,
    mark_task_command_processing,
    mark_task_command_succeeded,
    sync_google_sources_to_supabase,
)


def run_sync_once() -> tuple[int, int, int, int]:
    command_count = process_pending_task_commands()
    report_count = generate_expense_report()
    calendar_events = get_upcoming_events(days=GOOGLE_CALENDAR_SYNC_DAYS)
    tasks = get_tasks_for_sync(lookahead_days=GOOGLE_TASK_SYNC_DAYS)
    sync_google_sources_to_supabase(calendar_events, tasks)
    return len(calendar_events), len(tasks), command_count, report_count


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


def send_telegram_message(chat_id: int, text: str) -> None:
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not bot_token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN is required for report delivery.")

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown",
    }
    data = json.dumps(payload).encode("utf-8")
    request = Request(
        url,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=20):
        return


def generate_expense_report() -> int:
    pending_reports = get_pending_reports()
    if not pending_reports:
        return 0

    expense_logs = get_expense_logs()
    report_text = "За выбранный период нет записанных трат."
    expense_keys_to_delete = [row["key"] for row in expense_logs if row.get("key")]

    api_failed = False

    if expense_logs:
        lines: list[str] = []
        for row in expense_logs:
            value = row.get("value_json") or {}
            timestamp = value.get("timestamp") if isinstance(value, dict) else None
            text = value.get("text") if isinstance(value, dict) else None
            if isinstance(timestamp, str) and isinstance(text, str):
                lines.append(f"[{timestamp}]: {text}")
            elif isinstance(text, str):
                lines.append(f"[unknown-time]: {text}")

        if lines:
            try:
                report_text = request_openrouter_expense_report("\n".join(lines))
            except Exception as exc:
                api_failed = True
                print(f"OpenRouter report generation failed: {exc}")

    report_keys_to_delete: list[str] = []
    fallback_text = (
        "❌ Ошибка API OpenRouter. Данные о тратах сохранены, попробуйте вызвать /report позже."
    )
    for pending in pending_reports:
        key = pending.get("key")
        value = pending.get("value_json") or {}
        chat_id = value.get("chat_id") if isinstance(value, dict) else None
        if isinstance(chat_id, int):
            send_telegram_message(chat_id, fallback_text if api_failed else report_text)
        if isinstance(key, str):
            report_keys_to_delete.append(key)

    if api_failed:
        delete_bot_meta_keys(report_keys_to_delete)
    else:
        delete_bot_meta_keys(expense_keys_to_delete + report_keys_to_delete)
    return len(report_keys_to_delete)


def request_openrouter_expense_report(formatted_logs: str) -> str:
    openrouter_api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not openrouter_api_key:
        raise RuntimeError("OPENROUTER_API_KEY is required for report generation.")

    model = (
        os.getenv(
            "OPENROUTER_CHAT_MODEL",
            "meta-llama/llama-3.1-8b-instruct:free",
        ).strip()
        or "meta-llama/llama-3.1-8b-instruct:free"
    )
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "Ты мой финансовый ассистент. Мой бюджет 1200 тенге в день. "
                    "Вот список моих трат с датой и временем. Сгруппируй их по смысловым категориям, "
                    "посчитай общую сумму, сравни с бюджетом (учитывая количество дней) и напиши связный, "
                    "осмысленный отчет в формате Markdown для моего дневника. Если нужно, придумай категории сам."
                ),
            },
            {
                "role": "user",
                "content": formatted_logs,
            },
        ],
    }
    data = json.dumps(payload).encode("utf-8")
    request = Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=data,
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {openrouter_api_key}",
            "HTTP-Referer": "https://github.com/zalewko-droid/tgpushalert",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
        parsed = json.loads(raw)
        content = (
            parsed.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("OpenRouter returned an empty report.")
        return content.strip()
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter API {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"OpenRouter network error: {error}") from error
    except Exception as error:
        raise RuntimeError(f"OpenRouter unexpected error: {error}") from error


def worker_loop() -> None:
    validate_startup()
    print("Google sync worker started. Telegram runtime is Supabase Edge Functions only.")

    while True:
        started_at = datetime.now(timezone.utc)
        try:
            event_count, task_count, command_count, report_count = run_sync_once()
            print(
                f"{started_at.isoformat()} synced "
                f"{event_count} calendar events and {task_count} tasks to Supabase; "
                f"processed {command_count} task commands and {report_count} expense reports",
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
