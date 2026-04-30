import json
import os
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from config import (
    APP_TIMEZONE,
    DEFAULT_DATE_ONLY_TASK_REMINDER_HOUR,
    DEFAULT_DATE_ONLY_TASK_REMINDER_MINUTE,
    GOOGLE_TASKLIST_ID,
)


SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""


def is_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def sync_google_sources_to_supabase(calendar_events: list[dict[str, Any]], tasks: list[dict[str, Any]]) -> None:
    if not is_configured():
        return

    calendar_source = ensure_source("google_calendar", "Google Calendar")
    task_source = ensure_source("google_tasks", "Google Tasks")

    calendar_rows = [
        google_calendar_event_to_row(calendar_source["id"], event)
        for event in calendar_events
        if event.get("id")
    ]
    task_rows = [
        google_task_to_row(task_source["id"], task)
        for task in tasks
        if task.get("id")
    ]

    upsert_external_events(calendar_rows + task_rows)
    mark_missing_external_events(
        calendar_source["id"],
        {row["external_id"] for row in calendar_rows},
    )
    mark_missing_external_events(
        task_source["id"],
        {row["external_id"] for row in task_rows},
    )


def ensure_source(kind: str, name: str) -> dict[str, Any]:
    query = urlencode({"select": "*", "kind": f"eq.{kind}", "name": f"eq.{name}", "limit": "1"})
    rows = request_json(f"sources?{query}")
    if rows:
        return rows[0]

    created = request_json(
        "sources",
        method="POST",
        payload=[{"kind": kind, "name": name, "is_enabled": True}],
        prefer="return=representation",
    )
    return created[0]


def upsert_external_events(rows: list[dict[str, Any]]) -> None:
    if not rows:
        return

    query = urlencode({"on_conflict": "source_id,external_id"})
    request_json(
        f"external_events?{query}",
        method="POST",
        payload=rows,
        prefer="resolution=merge-duplicates,return=minimal",
    )


def get_pending_task_commands(limit: int = 10) -> list[dict[str, Any]]:
    query = urlencode({
        "select": "*",
        "status": "eq.pending",
        "order": "created_at.asc",
        "limit": str(limit),
    })
    return request_json(f"task_commands?{query}") or []


def mark_task_command_processing(command_id: str) -> None:
    update_task_command(command_id, {"status": "processing", "error_text": None})


def mark_task_command_succeeded(command_id: str, google_task_id: str) -> None:
    update_task_command(command_id, {
        "status": "succeeded",
        "google_tasklist_id": GOOGLE_TASKLIST_ID,
        "google_task_id": google_task_id,
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "error_text": None,
    })


def mark_task_command_error(command_id: str, error_text: str) -> None:
    update_task_command(command_id, {
        "status": "error",
        "error_text": error_text[:2000],
        "processed_at": datetime.now(timezone.utc).isoformat(),
    })


def update_task_command(command_id: str, payload: dict[str, Any]) -> None:
    request_json(
        f"task_commands?{urlencode({'id': f'eq.{command_id}'})}",
        method="PATCH",
        payload=payload,
        prefer="return=minimal",
    )


def get_expense_logs() -> list[dict[str, Any]]:
    query = urlencode({
        "select": "key,value_json,updated_at",
        "key": "like.expense_log:*",
        "order": "updated_at.asc",
    })
    return request_json(f"bot_meta?{query}") or []


def get_pending_reports() -> list[dict[str, Any]]:
    query = urlencode({
        "select": "key,value_json,updated_at",
        "key": "like.action:generate_report:*",
        "order": "updated_at.asc",
    })
    return request_json(f"bot_meta?{query}") or []


def delete_bot_meta_keys(keys: list[str]) -> None:
    cleaned = [key for key in keys if key]
    if not cleaned:
        return

    key_filter = f"in.({','.join(cleaned)})"
    request_json(
        f"bot_meta?{urlencode({'key': key_filter})}",
        method="DELETE",
        prefer="return=minimal",
    )


def mark_missing_external_events(source_id: str, seen_external_ids: set[str]) -> int:
    query = urlencode({
        "select": "id,external_id",
        "source_id": f"eq.{source_id}",
        "status": "eq.active",
    })
    existing = request_json(f"external_events?{query}") or []
    missing_ids = [
        row["id"]
        for row in existing
        if row.get("external_id") not in seen_external_ids
    ]

    for chunk in chunked(missing_ids, 100):
        id_filter = f"in.({','.join(chunk)})"
        request_json(
            f"external_events?{urlencode({'id': id_filter})}",
            method="PATCH",
            payload={"status": "missing"},
            prefer="return=minimal",
        )

    return len(missing_ids)


def google_calendar_event_to_row(source_id: str, event: dict[str, Any]) -> dict[str, Any]:
    start = event.get("start", {})
    end = event.get("end", {})
    starts_at = parse_google_time(start.get("dateTime") or start.get("date"))
    ends_at = parse_google_time(end.get("dateTime") or end.get("date"))
    return {
        "source_id": source_id,
        "external_id": event["id"],
        "title": event.get("summary") or "Untitled calendar event",
        "description": event.get("description"),
        "location": event.get("location"),
        "starts_at": starts_at,
        "ends_at": ends_at,
        "due_at": starts_at,
        "due_date": None,
        "has_explicit_time": True,
        "remind_at": None,
        "raw_payload_json": event,
        "checksum": event.get("etag"),
        "status": google_calendar_status(event),
    }


def google_task_to_row(source_id: str, task: dict[str, Any]) -> dict[str, Any]:
    due_info = google_task_due_info(task)
    tasklist_id = task.get("tasklist_id", "default")
    return {
        "source_id": source_id,
        "external_id": f"{tasklist_id}:{task['id']}",
        "title": task.get("title") or "Untitled task",
        "description": task.get("notes"),
        "location": None,
        "starts_at": None,
        "ends_at": None,
        "due_at": due_info["due_at"],
        "due_date": due_info["due_date"],
        "has_explicit_time": due_info["has_explicit_time"],
        "remind_at": due_info["remind_at"],
        "raw_payload_json": task,
        "checksum": google_task_checksum(task, due_info),
        "status": google_task_status(task),
    }


def google_calendar_status(event: dict[str, Any]) -> str:
    if event.get("status") == "cancelled":
        return "cancelled"
    return "active"


def google_task_status(task: dict[str, Any]) -> str:
    if task.get("status") == "completed":
        return "done"
    return "active"


def google_task_due_info(task: dict[str, Any]) -> dict[str, Any]:
    due = task.get("due")
    metadata = life_os_task_metadata(task.get("notes"))
    due_date = metadata.get("due_date") or google_due_date(due)
    due_time = metadata.get("due_time")
    timezone_name = metadata.get("timezone") or APP_TIMEZONE
    has_explicit_time = bool(metadata.get("has_explicit_time") and due_time)

    if not has_explicit_time and due and google_due_has_time(due):
        has_explicit_time = True

    if not due_date:
        return {
            "due_at": None,
            "due_date": None,
            "has_explicit_time": False,
            "remind_at": None,
        }

    if has_explicit_time:
        due_at = local_due_to_utc(due_date, due_time, timezone_name) if due_time else parse_google_time(due)
        return {
            "due_at": due_at,
            "due_date": due_date,
            "has_explicit_time": True,
            "remind_at": due_at,
        }

    return {
        "due_at": None,
        "due_date": due_date,
        "has_explicit_time": False,
        "remind_at": local_due_to_utc(
            due_date,
            f"{DEFAULT_DATE_ONLY_TASK_REMINDER_HOUR:02d}:{DEFAULT_DATE_ONLY_TASK_REMINDER_MINUTE:02d}",
            APP_TIMEZONE,
        ),
    }


def life_os_task_metadata(notes: str | None) -> dict[str, Any]:
    if not notes:
        return {}

    start = notes.find("<!-- life-os-task")
    end = notes.find("life-os-task -->", start)
    if start < 0 or end < 0:
        return {}

    raw = notes[start + len("<!-- life-os-task"):end].strip()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def google_due_date(value: str | None) -> str | None:
    if not value:
        return None
    return value[:10]


def google_due_has_time(value: str | None) -> bool:
    if not value or "T" not in value:
        return False
    time_part = value.split("T", 1)[1].replace("Z", "").split("+", 1)[0].split("-", 1)[0]
    return not time_part.startswith("00:00:00")


def local_due_to_utc(due_date: str, due_time: str | None, timezone_name: str) -> str | None:
    if not due_time:
        return None
    local = datetime.fromisoformat(f"{due_date}T{due_time}:00").replace(
        tzinfo=ZoneInfo(timezone_name),
    )
    return local.astimezone(timezone.utc).isoformat()


def google_task_checksum(task: dict[str, Any], due_info: dict[str, Any]) -> str | None:
    base = task.get("etag") or task.get("updated") or task.get("id")
    if not base:
        return None
    return "|".join([
        str(base),
        str(due_info.get("due_date") or ""),
        str(due_info.get("due_at") or ""),
        str(due_info.get("remind_at") or ""),
        str(due_info.get("has_explicit_time")),
    ])


def parse_google_time(value: str | None) -> str | None:
    if not value:
        return None
    if len(value) == 10:
        return f"{value}T00:00:00+00:00"
    if value.endswith("Z"):
        return value[:-1] + "+00:00"
    return value


def chunked(items: list[str], size: int) -> list[list[str]]:
    return [items[index:index + size] for index in range(0, len(items), size)]


def request_json(
    path: str,
    method: str = "GET",
    payload: Any | None = None,
    prefer: str | None = None,
) -> Any:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    }
    if payload is not None:
        headers["content-type"] = "application/json"
    if prefer:
        headers["prefer"] = prefer

    request = Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        data=body,
        headers=headers,
        method=method,
    )

    try:
        with urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase REST {error.code}: {detail}") from error
