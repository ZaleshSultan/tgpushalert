import os
import pickle
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from google.auth.transport.requests import Request
from googleapiclient.discovery import build

from config import APP_TIMEZONE, GOOGLE_CREDENTIALS_PATH, GOOGLE_TASKLIST_ID, GOOGLE_TOKEN_PATH


SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
]    "https://www.googleapis.com/auth/tasks",фывфывфывфыфывфыфывф


_services = {}


def validate_google_token_file() -> None:
    if not os.path.exists(GOOGLE_TOKEN_PATH):
        raise RuntimeError(
            f"Missing Google OAuth token file: {GOOGLE_TOKEN_PATH}. "
            "Create it locally with the Google OAuth browser flow, then copy "
            "the generated token.pickle next to the worker. Headless production "
            "workers do not run run_local_server().",
        )


def get_google_service(service_name, version):
    key = (service_name, version)
    if key in _services:
        return _services[key]

    validate_google_token_file()
    with open(GOOGLE_TOKEN_PATH, "rb") as token:
        creds = pickle.load(token)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            with open(GOOGLE_TOKEN_PATH, "wb") as token:
                pickle.dump(creds, token)
        else:
            raise RuntimeError(
                "Google OAuth token is missing, invalid, or has no refresh token. "
                f"Regenerate it locally using {GOOGLE_CREDENTIALS_PATH}, then "
                f"place the refreshed token at {GOOGLE_TOKEN_PATH}.",
            )

    service = build(service_name, version, credentials=creds)
    _services[key] = service
    return service


def get_calendar_service():
    return get_google_service("calendar", "v3")


def get_tasks_service():
    return get_google_service("tasks", "v1")


def create_task(title, due_date, due_time=None, timezone_name=None, command_id=None):
    timezone_name = timezone_name or APP_TIMEZONE
    notes = build_task_notes(due_date, due_time, timezone_name, command_id)
    body = {
        "title": title,
        "notes": notes,
        "due": google_due_value(due_date, due_time, timezone_name),
    }
    return get_tasks_service().tasks().insert(
        tasklist=GOOGLE_TASKLIST_ID,
        body=body,
    ).execute()


def get_today_events():
    return get_upcoming_events(days=1)


def get_upcoming_events(days=7):
    now = datetime.now(timezone.utc)
    time_max = now + timedelta(days=days)
    events = []
    page_token = None

    while True:
        events_result = get_calendar_service().events().list(
            calendarId="primary",
            timeMin=now.isoformat(),
            timeMax=time_max.isoformat(),
            singleEvents=True,
            orderBy="startTime",
            pageToken=page_token,
        ).execute()
        events.extend(events_result.get("items", []))
        page_token = events_result.get("nextPageToken")
        if not page_token:
            return events


def get_pending_tasks(lookahead_days=7):
    return [
        task for task in get_tasks_for_sync(lookahead_days=lookahead_days)
        if task.get("status") != "completed"
    ]


def get_tasks_for_sync(lookahead_days=7):
    tasklists_result = get_tasks_service().tasklists().list().execute()
    tasklists = tasklists_result.get("items", [])

    now = datetime.now(timezone.utc)
    horizon = now + timedelta(days=lookahead_days)
    pending = []

    for tasklist in tasklists:
        tasklist_id = tasklist["id"]
        page_token = None

        while True:
            tasks_result = get_tasks_service().tasks().list(
                tasklist=tasklist_id,
                showCompleted=True,
                showHidden=True,
                pageToken=page_token,
            ).execute()
            tasks = tasks_result.get("items", [])

            for task in tasks:
                due = parse_google_datetime(task.get("due"))
                if due and due <= horizon:
                    task["tasklist_title"] = tasklist.get("title", "Untitled list")
                    task["tasklist_id"] = tasklist_id
                    pending.append(task)

            page_token = tasks_result.get("nextPageToken")
            if not page_token:
                break

    return pending


def parse_google_datetime(value):
    if not value:
        return None
    if len(value) == 10:
        return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def google_due_value(due_date, due_time=None, timezone_name=None):
    if not due_time:
        return f"{due_date}T00:00:00.000Z"

    local = datetime.fromisoformat(f"{due_date}T{due_time}:00").replace(
        tzinfo=ZoneInfo(timezone_name or APP_TIMEZONE),
    )
    return local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def build_task_notes(due_date, due_time=None, timezone_name=None, command_id=None):
    metadata = {
        "source": "telegram_addtask",
        "due_date": due_date,
        "has_explicit_time": bool(due_time),
        "timezone": timezone_name or APP_TIMEZONE,
    }
    if due_time:
        metadata["due_time"] = due_time
    if command_id:
        metadata["command_id"] = command_id

    return "\n".join([
        "<!-- life-os-task",
        json_dumps(metadata),
        "life-os-task -->",
    ])


def json_dumps(value):
    import json

    return json.dumps(value, ensure_ascii=False, sort_keys=True)
