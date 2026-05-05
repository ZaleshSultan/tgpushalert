from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
import json
import logging
import os
from pathlib import Path
import re
import statistics
import tempfile
from typing import Any
from urllib import error, request
from zoneinfo import ZoneInfo

from supabase_client import SupabaseRestClient


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ExpenseRecord:
    source_key: str
    amount: int
    currency_code: str
    category_guess: str
    category_normalized: str
    tags: list[str]
    confidence: float
    raw_text: str
    chat_id: int
    timestamp_utc: datetime
    timestamp_local: datetime
    date: str
    iso_week: int
    iso_year: int
    month: int


def resolve_report_week(
    *,
    timezone_name: str,
    now_utc: datetime | None = None,
    iso_year: int | None = None,
    iso_week: int | None = None,
) -> tuple[int, int]:
    if (iso_year is None) != (iso_week is None):
        raise ValueError("iso_year and iso_week must be provided together")

    if iso_year is not None and iso_week is not None:
        return iso_year, iso_week

    now_utc = now_utc or datetime.now(timezone.utc)
    now_local = now_utc.astimezone(ZoneInfo(timezone_name))
    local_iso = now_local.isocalendar()
    return local_iso.year, local_iso.week


def fetch_weekly_expenses(
    client: SupabaseRestClient,
    *,
    iso_year: int,
    iso_week: int,
) -> list[ExpenseRecord]:
    rows = client.select(
        "expenses",
        params={
            "select": ",".join(
                [
                    "source_key",
                    "amount",
                    "currency_code",
                    "category_guess",
                    "category_normalized",
                    "tags",
                    "confidence",
                    "raw_text",
                    "chat_id",
                    "timestamp_utc",
                    "timestamp_local",
                    "date",
                    "iso_week",
                    "iso_year",
                    "month",
                ],
            ),
            "iso_year": f"eq.{iso_year}",
            "iso_week": f"eq.{iso_week}",
            "order": "timestamp_local.asc,source_key.asc",
        },
    ) or []
    return [_row_to_expense_record(row) for row in rows]


def build_weekly_report_payload(
    expenses: list[ExpenseRecord],
    *,
    timezone_name: str,
    iso_year: int,
    iso_week: int,
    generated_at_utc: datetime,
    low_confidence_threshold: float,
) -> dict[str, Any]:
    start_local, end_local_exclusive = iso_week_bounds(
        timezone_name=timezone_name,
        iso_year=iso_year,
        iso_week=iso_week,
    )
    end_local_inclusive = end_local_exclusive - timedelta(days=1)
    total_spend = sum(expense.amount for expense in expenses)
    total_spend_by_currency = _total_spend_by_currency(expenses)
    low_confidence_expenses = [
        expense for expense in expenses if expense.confidence < low_confidence_threshold
    ]

    category_totals: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"amount": 0, "count": 0},
    )
    for expense in expenses:
        category_key = expense.category_normalized or expense.category_guess or "uncategorized"
        category_totals[category_key]["amount"] += expense.amount
        category_totals[category_key]["count"] += 1

    sorted_categories = sorted(
        (
            {
                "category": category,
                "amount": values["amount"],
                "count": values["count"],
            }
            for category, values in category_totals.items()
        ),
        key=lambda item: (-item["amount"], item["category"]),
    )

    payload = {
        "period": {
            "timezone": timezone_name,
            "start_local": start_local.isoformat(),
            "end_local_exclusive": end_local_exclusive.isoformat(),
            "start_date": start_local.date().isoformat(),
            "end_date": end_local_inclusive.date().isoformat(),
            "iso_week": iso_week,
            "iso_year": iso_year,
            "week": f"{iso_year}-{iso_week:02d}",
        },
        "generated_at": generated_at_utc.isoformat(),
        "summary": {
            "transaction_count": len(expenses),
            "total_spend": total_spend,
            "currency_code": _dominant_currency(expenses),
            "total_spend_by_currency": total_spend_by_currency,
            "average_spend": round(total_spend / len(expenses), 2) if expenses else 0,
        },
        "confidence": {
            "threshold": low_confidence_threshold,
            "average": round(
                sum(expense.confidence for expense in expenses) / len(expenses),
                3,
            ) if expenses else 0.0,
            "low_confidence_count": len(low_confidence_expenses),
            "has_low_confidence": bool(low_confidence_expenses),
        },
        "spend_per_category": sorted_categories,
        "top_categories": sorted_categories[:3],
        "anomalies": _detect_anomalies(expenses, category_totals),
        "expenses": [
            {
                "date": expense.date,
                "timestamp_local": expense.timestamp_local.isoformat(sep=" "),
                "amount": expense.amount,
                "currency_code": expense.currency_code,
                "category_guess": expense.category_guess,
                "category_normalized": expense.category_normalized,
                "tags": expense.tags,
                "confidence": expense.confidence,
                "raw_text": expense.raw_text,
            }
            for expense in sorted(
                expenses,
                key=lambda expense: (expense.timestamp_local, expense.source_key),
            )
        ],
    }
    return payload


def build_weekly_analysis_messages(report_payload: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "role": "system",
            "content": (
                "You are an аналитик personal finance system. "
                "Read the structured weekly spending JSON and return strict JSON with keys: "
                "summary, insights, behavioral_patterns, suggestions, low_confidence. "
                "summary must be a short string. insights, behavioral_patterns, and suggestions "
                "must be arrays of short strings. "
                "low_confidence must be a boolean. "
                "Focus on actionable observations, category shifts, unusual purchases, "
                "and habits visible in the data. "
                "If data is ambiguous or low confidence, return low_confidence=true and avoid hallucinations. "
                "Do not include markdown."
            ),
        },
        {
            "role": "user",
            "content": json.dumps(report_payload, ensure_ascii=False, indent=2),
        },
    ]


def request_ai_analysis(
    *,
    api_base_url: str,
    api_key: str,
    model: str,
    report_payload: dict[str, Any],
    timeout_seconds: int = 60,
    referer: str | None = None,
    app_name: str | None = None,
) -> dict[str, Any]:
    if not api_key or not model:
        raise RuntimeError("AI_API_KEY and AI_MODEL must be configured for weekly reports")

    base_url = api_base_url.rstrip("/")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if referer:
        headers["HTTP-Referer"] = referer
    if app_name:
        headers["X-Title"] = app_name

    body = {
        "model": model,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": build_weekly_analysis_messages(report_payload),
    }

    req = request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"AI request failed with HTTP {exc.code}: {body_text}") from exc
    except error.URLError as exc:
        raise RuntimeError(f"AI request failed: {exc}") from exc

    content = payload["choices"][0]["message"]["content"]
    return _parse_ai_content(content)


def write_obsidian_weekly_report(
    report_payload: dict[str, Any],
    ai_analysis: dict[str, Any],
    *,
    vault_root: str,
) -> Path:
    iso_year = report_payload["period"]["iso_year"]
    iso_week = report_payload["period"]["iso_week"]
    target_path = Path(vault_root).expanduser() / "Finance" / "Weekly" / f"{iso_year}-{iso_week:02d}.md"
    target_path.parent.mkdir(parents=True, exist_ok=True)
    rendered = render_weekly_report_markdown(report_payload, ai_analysis)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=target_path.parent,
        prefix=f".{target_path.name}.",
        suffix=".tmp",
        delete=False,
    ) as temp_file:
        temp_file.write(rendered)
        temp_file.flush()
        os.fsync(temp_file.fileno())
        temp_path = Path(temp_file.name)
    temp_path.replace(target_path)
    logger.info("Wrote weekly finance report to %s", target_path)
    return target_path


def render_weekly_report_markdown(
    report_payload: dict[str, Any],
    ai_analysis: dict[str, Any],
) -> str:
    currency_code = report_payload["summary"]["currency_code"]
    week_key = report_payload["period"]["week"]
    lines = [
        "---",
        "type: finance-weekly",
        f"week: {week_key}",
        f"total: {report_payload['summary']['total_spend']}",
        f"currency: {currency_code}",
        f"generated_at: {report_payload['generated_at']}",
        "---",
        "",
        f"# Weekly Finance Report (Week {report_payload['period']['iso_week']:02d})",
        "",
        "## Summary",
        _stringify_section(ai_analysis.get("summary")),
        "",
        f"Period: {report_payload['period']['start_date']} → {report_payload['period']['end_date']}",
        f"Total spend: {report_payload['summary']['total_spend']} {currency_code}",
        f"Transactions: {report_payload['summary']['transaction_count']}",
        f"Low confidence: {str(bool(ai_analysis.get('low_confidence'))).lower()}",
    ]
    currency_breakdown = report_payload["summary"].get("total_spend_by_currency") or {}
    if len(currency_breakdown) > 1:
        lines.append(f"By currency: {json.dumps(currency_breakdown, ensure_ascii=False)}")
    confidence_summary = report_payload.get("confidence") or {}
    if confidence_summary:
        lines.append(
            "Parser confidence: "
            f"avg={confidence_summary.get('average', 0.0)} "
            f"low_count={confidence_summary.get('low_confidence_count', 0)} "
            f"threshold={confidence_summary.get('threshold', 0.0)}"
        )
    lines.extend(
        [
            "",
            "## Breakdown",
        ],
    )

    for category_row in report_payload["spend_per_category"]:
        lines.append(
            f"* {category_row['category']}: {category_row['amount']} {currency_code} "
            f"({category_row['count']} tx)"
        )

    lines.extend(
        [
            "",
            "## Insights",
            *_stringify_list(ai_analysis.get("insights")),
            "",
            "## Behavioral Patterns",
            *_stringify_list(ai_analysis.get("behavioral_patterns")),
            "",
            "## Suggestions",
            *_stringify_list(ai_analysis.get("suggestions")),
            "",
            "## Raw Data",
            "| Date | Category | Amount | Confidence | Raw Text |",
            "| --- | --- | ---: | ---: | --- |",
        ],
    )

    for expense in report_payload["expenses"]:
        category = expense["category_normalized"] or expense["category_guess"]
        raw_text = str(expense["raw_text"]).replace("|", "\\|")
        lines.append(
            f"| {expense['date']} | {category} | {expense['amount']} {expense['currency_code']} | "
            f"{expense['confidence']:.3f} | {raw_text} |",
        )

    return "\n".join(lines) + "\n"


def _row_to_expense_record(row: dict[str, Any]) -> ExpenseRecord:
    timestamp_utc = _parse_datetime(row["timestamp_utc"])
    timestamp_local = _parse_datetime(row["timestamp_local"])
    return ExpenseRecord(
        source_key=row["source_key"],
        amount=int(row["amount"]),
        currency_code=row.get("currency_code", "KZT"),
        category_guess=row.get("category_guess") or "uncategorized",
        category_normalized=row.get("category_normalized") or "uncategorized",
        tags=list(row.get("tags") or []),
        confidence=float(row.get("confidence") or 0.0),
        raw_text=row.get("raw_text") or "",
        chat_id=int(row["chat_id"]),
        timestamp_utc=timestamp_utc,
        timestamp_local=timestamp_local,
        date=row["date"],
        iso_week=int(row["iso_week"]),
        iso_year=int(row["iso_year"]),
        month=int(row["month"]),
    )


def _detect_anomalies(
    expenses: list[ExpenseRecord],
    category_totals: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    if not expenses:
        return []

    amounts = [expense.amount for expense in expenses]
    average = sum(amounts) / len(amounts)
    median = statistics.median(amounts)
    threshold = max(average * 2, median * 2)

    anomalies = []
    for expense in expenses:
        if expense.amount >= threshold and expense.amount > average:
            anomalies.append(
                {
                    "type": "large_expense",
                    "date": expense.date,
                    "amount": expense.amount,
                    "category": expense.category_normalized,
                    "raw_text": expense.raw_text,
                },
            )

    total_spend = sum(amounts)
    if total_spend > 0:
        for category, values in category_totals.items():
            share = values["amount"] / total_spend
            if share >= 0.4:
                anomalies.append(
                    {
                        "type": "category_concentration",
                        "category": category,
                        "share": round(share, 3),
                        "amount": values["amount"],
                    },
                )

    return sorted(
        anomalies,
        key=lambda item: (
            item.get("type", ""),
            item.get("date", ""),
            item.get("category", ""),
            item.get("amount", 0),
        ),
    )


def _dominant_currency(expenses: list[ExpenseRecord]) -> str:
    if not expenses:
        return "KZT"
    totals = _total_spend_by_currency(expenses)
    return max(totals.items(), key=lambda item: item[1])[0]


def _total_spend_by_currency(expenses: list[ExpenseRecord]) -> dict[str, int]:
    totals: dict[str, int] = defaultdict(int)
    for expense in expenses:
        totals[expense.currency_code] += expense.amount
    return dict(totals)


def _parse_ai_content(content: Any) -> dict[str, Any]:
    if isinstance(content, list):
        content = "".join(
            item.get("text", "")
            for item in content
            if isinstance(item, dict)
        )

    if not isinstance(content, str):
        raise RuntimeError(f"Unexpected AI response content: {content!r}")

    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    parsed = json.loads(cleaned)
    return {
        "summary": parsed.get("summary", ""),
        "insights": parsed.get("insights", []),
        "behavioral_patterns": parsed.get("behavioral_patterns", []),
        "suggestions": parsed.get("suggestions", []),
        "low_confidence": _coerce_bool(parsed.get("low_confidence", False)),
    }


def iso_week_bounds(
    *,
    timezone_name: str,
    iso_year: int,
    iso_week: int,
) -> tuple[datetime, datetime]:
    tz = ZoneInfo(timezone_name)
    monday = date.fromisocalendar(iso_year, iso_week, 1)
    start_local = datetime.combine(monday, time.min, tzinfo=tz)
    end_local_exclusive = start_local + timedelta(days=7)
    return start_local, end_local_exclusive


def _parse_datetime(value: str) -> datetime:
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.fromisoformat(value)


def _stringify_section(value: Any) -> str:
    if isinstance(value, list):
        return " ".join(str(item) for item in value)
    if value is None:
        return ""
    return str(value)


def _stringify_list(value: Any) -> list[str]:
    if value is None:
        return ["* No additional insights."]
    if isinstance(value, str):
        return [f"* {value}"]
    if isinstance(value, list):
        return [f"* {item}" for item in value] or ["* No additional insights."]
    return [f"* {value}"]


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes"}
    if isinstance(value, (int, float)):
        return bool(value)
    return False
