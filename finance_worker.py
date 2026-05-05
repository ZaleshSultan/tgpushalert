from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import logging
import os
import socket
import time
from typing import Any
from zoneinfo import ZoneInfo

import config
from finance_parser import ExpenseParseError, ParsedExpense, parse_expense_text
from supabase_client import SupabaseError, SupabaseRestClient
from weekly_report import (
    build_weekly_report_payload,
    fetch_weekly_expenses,
    resolve_report_week,
    request_ai_analysis,
    write_obsidian_weekly_report,
)


logger = logging.getLogger(__name__)


class ExpenseEntryError(ValueError):
    pass


def main() -> int:
    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    parser = _build_cli()
    args = parser.parse_args()
    client = SupabaseRestClient(
        base_url=config.SUPABASE_URL,
        service_role_key=config.SUPABASE_SERVICE_ROLE_KEY,
        timeout_seconds=config.SUPABASE_TIMEOUT_SECONDS,
    )

    if args.command == "process-expenses":
        processed, failed = process_expense_logs(
            client,
            batch_size=args.batch_size,
            failed_only=False,
            drain=True,
        )
        logger.info("Expense processing finished: processed=%s failed=%s", processed, failed)
        return 0

    if args.command == "process-report-queue":
        processed, failed = process_report_queue(
            client,
            batch_size=args.batch_size,
            failed_only=False,
            drain=True,
        )
        logger.info("Report queue finished: processed=%s failed=%s", processed, failed)
        return 0

    if args.command == "process-failed":
        expense_processed, expense_failed = process_expense_logs(
            client,
            batch_size=args.batch_size,
            failed_only=True,
            drain=False,
        )
        report_processed, report_failed = process_report_queue(
            client,
            batch_size=args.batch_size,
            failed_only=True,
            drain=False,
        )
        logger.info(
            "Failed queue retry finished: expenses=%s/%s reports=%s/%s",
            expense_processed,
            expense_failed,
            report_processed,
            report_failed,
        )
        return 0

    if args.command == "weekly-report":
        report_result = generate_weekly_report(
            client,
            iso_year=args.iso_year,
            iso_week=args.iso_week,
        )
        logger.info("Weekly report written to %s", report_result["path"])
        return 0

    if args.command == "run-once":
        processed, failed = process_expense_logs(
            client,
            batch_size=args.batch_size,
            failed_only=False,
            drain=True,
        )
        report_processed, report_failed = process_report_queue(
            client,
            batch_size=args.batch_size,
            failed_only=False,
            drain=True,
        )
        logger.info(
            "Run once finished: expenses=%s/%s reports=%s/%s",
            processed,
            failed,
            report_processed,
            report_failed,
        )
        return 0

    if args.command == "run-loop":
        return run_loop(client, batch_size=args.batch_size, poll_seconds=args.poll_seconds)

    parser.error(f"Unsupported command: {args.command}")
    return 2


def process_expense_logs(
    client: SupabaseRestClient,
    *,
    batch_size: int,
    failed_only: bool,
    drain: bool,
) -> tuple[int, int]:
    processed = 0
    failed = 0

    while True:
        rows = claim_bot_meta_entries(
            client,
            prefix_filter="expense_log:",
            batch_size=batch_size,
            failed_only=failed_only,
        )
        if not rows:
            break

        batch_success = 0
        batch_failed = 0
        batch_duplicates = 0

        for row in rows:
            attempts = _processing_attempts_from_item(row)
            try:
                outcome = process_single_expense_entry(client, row)
            except ExpenseEntryError as exc:
                logger.warning("Expense parsing failed for %s: %s", row["key"], exc)
                try:
                    _record_failed_expense(client, row, exc)
                except SupabaseError:
                    logger.exception("Failed to persist expense failure for %s", row["key"])
                _mark_processing_failure(client, row["key"], attempts, str(exc))
                failed += 1
                batch_failed += 1
            except SupabaseError as exc:
                logger.exception("Supabase error while processing expense %s", row["key"])
                _mark_processing_failure(client, row["key"], attempts, str(exc))
                failed += 1
                batch_failed += 1
            except Exception as exc:
                logger.exception("Unexpected error while processing expense %s", row["key"])
                _mark_processing_failure(client, row["key"], attempts, str(exc))
                failed += 1
                batch_failed += 1
            else:
                processed += 1
                if outcome == "duplicate":
                    batch_duplicates += 1
                else:
                    batch_success += 1

        _log_batch_stats(
            client,
            prefix_filter="expense_log:",
            processed=len(rows),
            success=batch_success,
            failed=batch_failed,
            duplicates=batch_duplicates,
            failed_only=failed_only,
        )

        if not drain:
            break

    return processed, failed


def process_report_queue(
    client: SupabaseRestClient,
    *,
    batch_size: int,
    failed_only: bool,
    drain: bool,
) -> tuple[int, int]:
    processed = 0
    failed = 0

    while True:
        rows = claim_bot_meta_entries(
            client,
            prefix_filter="action:generate_report:",
            batch_size=batch_size,
            failed_only=failed_only,
        )
        if not rows:
            break

        batch_success = 0
        batch_failed = 0
        batch_duplicates = 0

        for row in rows:
            attempts = _processing_attempts_from_item(row)
            try:
                payload = row.get("value_json") or {}
                generate_weekly_report(
                    client,
                    iso_year=_optional_int(payload, "iso_year"),
                    iso_week=_optional_int(payload, "iso_week"),
                )
            except Exception as exc:
                logger.exception("Failed to generate weekly report for %s", row["key"])
                _mark_processing_failure(client, row["key"], attempts, str(exc))
                failed += 1
                batch_failed += 1
            else:
                try:
                    complete_bot_meta_entry(client, row["key"], "done")
                except Exception as exc:
                    logger.exception("Failed to mark report request %s as done", row["key"])
                    _mark_processing_failure(client, row["key"], attempts, str(exc))
                    failed += 1
                    batch_failed += 1
                else:
                    processed += 1
                    batch_success += 1

        _log_batch_stats(
            client,
            prefix_filter="action:generate_report:",
            processed=len(rows),
            success=batch_success,
            failed=batch_failed,
            duplicates=batch_duplicates,
            failed_only=failed_only,
        )

        if not drain:
            break

    return processed, failed


def generate_weekly_report(
    client: SupabaseRestClient,
    *,
    iso_year: int | None = None,
    iso_week: int | None = None,
) -> dict[str, Any]:
    generated_at_utc = datetime.now(timezone.utc)
    resolved_iso_year, resolved_iso_week = resolve_report_week(
        timezone_name=config.FINANCE_TIMEZONE,
        now_utc=generated_at_utc,
        iso_year=iso_year,
        iso_week=iso_week,
    )
    expenses = fetch_weekly_expenses(
        client,
        iso_year=resolved_iso_year,
        iso_week=resolved_iso_week,
    )
    report_payload = build_weekly_report_payload(
        expenses,
        timezone_name=config.FINANCE_TIMEZONE,
        iso_year=resolved_iso_year,
        iso_week=resolved_iso_week,
        generated_at_utc=generated_at_utc,
        low_confidence_threshold=config.LOW_CONFIDENCE_THRESHOLD,
    )
    ai_analysis = request_ai_analysis(
        api_base_url=config.AI_API_BASE_URL,
        api_key=config.AI_API_KEY,
        model=config.AI_MODEL,
        report_payload=report_payload,
        timeout_seconds=config.AI_TIMEOUT_SECONDS,
        referer=config.AI_HTTP_REFERER,
        app_name=config.AI_APP_NAME,
    )
    report_path = write_obsidian_weekly_report(
        report_payload,
        ai_analysis,
        vault_root=config.OBSIDIAN_VAULT_PATH,
    )
    return {
        "payload": report_payload,
        "analysis": ai_analysis,
        "path": str(report_path),
    }


def process_single_expense_entry(
    client: SupabaseRestClient,
    row: dict[str, Any],
) -> str:
    key = row["key"]
    payload = row.get("value_json") or {}

    raw_text = _require_string(payload, "text")
    chat_id = _require_int(payload, "chat_id")
    timestamp_utc = _parse_timestamp_utc(_require_string(payload, "timestamp"))
    parsed = _parse_expense_payload(raw_text)

    local_timestamp = timestamp_utc.astimezone(ZoneInfo(config.FINANCE_TIMEZONE))
    expense_row = {
        "source_key": key,
        "amount": parsed.amount,
        "currency_code": parsed.currency_code,
        "category_guess": parsed.category_guess,
        "category_normalized": parsed.category_normalized,
        "tags": parsed.tags,
        "confidence": parsed.confidence,
        "parse_version": parsed.parse_version,
        "raw_text": raw_text,
        "chat_id": chat_id,
        "timestamp_utc": timestamp_utc.isoformat(),
        "timestamp_local": local_timestamp.replace(tzinfo=None).isoformat(sep=" "),
        "date": local_timestamp.date().isoformat(),
        "week": local_timestamp.isocalendar().week,
        "iso_week": local_timestamp.isocalendar().week,
        "iso_year": local_timestamp.isocalendar().year,
        "month": local_timestamp.month,
    }

    insert_result = client.upsert(
        "expenses",
        [expense_row],
        on_conflict="source_key",
        returning="representation",
        ignore_duplicates=True,
    )
    complete_bot_meta_entry(client, key, "done")
    if insert_result:
        return "inserted"
    return "duplicate"


def claim_bot_meta_entries(
    client: SupabaseRestClient,
    *,
    prefix_filter: str,
    batch_size: int,
    failed_only: bool,
) -> list[dict[str, Any]]:
    payload = {
        "limit_size": batch_size,
        "max_attempts": config.FINANCE_MAX_PROCESSING_ATTEMPTS,
        "stale_after_minutes": config.FINANCE_STALE_CLAIM_MINUTES,
        "failed_only": failed_only,
    }
    logger.info(
        "claim_bot_meta_entries args prefix=%s payload=%s",
        prefix_filter,
        json.dumps(payload, ensure_ascii=False, sort_keys=True),
    )
    try:
        rows = client.rpc("claim_bot_meta_entries", payload)
    except SupabaseError as exc:
        logger.error(
            "claim_bot_meta_entries failed prefix=%s status=%s body=%s payload=%s",
            prefix_filter,
            exc.status_code,
            exc.body,
            json.dumps(payload, ensure_ascii=False, sort_keys=True),
        )
        return []

    claimed_rows = list(rows or [])
    matched_rows = []
    for row in claimed_rows:
        key = str(row.get("key") or "")
        if key.startswith(prefix_filter):
            matched_rows.append(row)
            continue

        logger.warning(
            "Re-queueing unexpected claimed row prefix=%s key=%s",
            prefix_filter,
            key,
        )
        try:
            complete_bot_meta_entry(
                client,
                key,
                "pending",
                f"Re-queued from mismatched claim for {prefix_filter}",
            )
        except SupabaseError:
            logger.exception("Failed to re-queue unexpected claimed row %s", key)

    return matched_rows


def complete_bot_meta_entry(
    client: SupabaseRestClient,
    key: str,
    final_status: str,
    error_text: str | None = None,
) -> None:
    client.rpc(
        "complete_bot_meta_entry",
        {
            "entry_key": key,
            "final_status": final_status,
            "error_text": error_text,
        },
    )


def estimate_queue_remaining(
    client: SupabaseRestClient,
    *,
    prefix_filter: str,
    failed_only: bool,
) -> int:
    remaining = client.rpc(
        "estimate_bot_meta_queue",
        {
            "prefix_filter": prefix_filter,
            "stale_after_minutes": config.FINANCE_STALE_CLAIM_MINUTES,
            "max_attempts": config.FINANCE_MAX_PROCESSING_ATTEMPTS,
            "failed_only": failed_only,
        },
    )
    return int(remaining or 0)


def run_loop(
    client: SupabaseRestClient,
    *,
    batch_size: int,
    poll_seconds: int,
) -> int:
    logger.info("Starting finance worker loop with poll_seconds=%s", poll_seconds)
    supabase_error_streak = 0
    while True:
        try:
            expense_processed, expense_failed = process_expense_logs(
                client,
                batch_size=batch_size,
                failed_only=False,
                drain=True,
            )
            report_processed, report_failed = process_report_queue(
                client,
                batch_size=batch_size,
                failed_only=False,
                drain=True,
            )
        except SupabaseError as exc:
            supabase_error_streak += 1
            backoff_seconds = min(60, max(poll_seconds, 5) * supabase_error_streak)
            logger.error(
                "Supabase error in run loop status=%s body=%s backoff=%ss streak=%s",
                exc.status_code,
                exc.body,
                backoff_seconds,
                supabase_error_streak,
            )
            time.sleep(backoff_seconds)
            continue
        except Exception:
            logger.exception("Fatal worker crash in run loop")
            raise

        supabase_error_streak = 0
        logger.info(
            "Loop tick finished: expenses=%s/%s reports=%s/%s",
            expense_processed,
            expense_failed,
            report_processed,
            report_failed,
        )
        time.sleep(poll_seconds)


def _record_failed_expense(
    client: SupabaseRestClient,
    row: dict[str, Any],
    exc: Exception,
) -> None:
    payload = row.get("value_json") or {}
    raw_text = str(payload.get("text") or "")
    timestamp = payload.get("timestamp")
    timestamp_utc = None

    if isinstance(timestamp, str) and timestamp.strip():
        try:
            timestamp_utc = _parse_timestamp_utc(timestamp).isoformat()
        except ExpenseEntryError:
            timestamp_utc = None

    failed_row = {
        "source_key": row["key"],
        "raw_text": raw_text,
        "chat_id": payload.get("chat_id"),
        "timestamp_utc": timestamp_utc,
        "failure_stage": "parse",
        "error_text": str(exc),
        "payload_json": payload,
    }

    client.upsert("expenses_failed", [failed_row], on_conflict="source_key")


def _parse_expense_payload(raw_text: str) -> ParsedExpense:
    try:
        return parse_expense_text(raw_text, default_currency=config.DEFAULT_CURRENCY_CODE)
    except ExpenseParseError as exc:
        raise ExpenseEntryError(str(exc)) from exc


def _parse_timestamp_utc(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"

    try:
        timestamp = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ExpenseEntryError(f"Invalid timestamp: {value!r}") from exc

    if timestamp.tzinfo is None:
        return timestamp.replace(tzinfo=timezone.utc)

    return timestamp.astimezone(timezone.utc)


def _require_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ExpenseEntryError(f"Missing or invalid {key!r} in payload: {json.dumps(payload, ensure_ascii=False)}")
    return value.strip()


def _require_int(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ExpenseEntryError(f"Missing or invalid {key!r} in payload: {json.dumps(payload, ensure_ascii=False)}") from exc


def _optional_int(payload: dict[str, Any], key: str) -> int | None:
    value = payload.get(key)
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid optional integer {key!r}: {value!r}") from exc


def _processing_attempts_from_item(item: dict[str, Any]) -> int:
    payload = item.get("value_json") or {}
    value = payload.get("processing_attempts", 0)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _mark_processing_failure(
    client: SupabaseRestClient,
    key: str,
    attempts: int,
    error_text: str,
) -> None:
    final_status = "failed" if attempts >= config.FINANCE_MAX_PROCESSING_ATTEMPTS else "pending"
    try:
        complete_bot_meta_entry(client, key, final_status, error_text)
    except Exception:
        logger.exception("Failed to mark %s as %s", key, final_status)


def _log_batch_stats(
    client: SupabaseRestClient,
    *,
    prefix_filter: str,
    processed: int,
    success: int,
    failed: int,
    duplicates: int,
    failed_only: bool,
) -> None:
    try:
        queue_remaining_estimate = estimate_queue_remaining(
            client,
            prefix_filter=prefix_filter,
            failed_only=failed_only,
        )
    except Exception:
        logger.exception("Failed to estimate remaining queue for %s", prefix_filter)
        queue_remaining_estimate = -1

    payload = {
        "processed": processed,
        "success": success,
        "failed": failed,
        "duplicates": duplicates,
        "queue_remaining_estimate": queue_remaining_estimate,
    }
    logger.info(json.dumps(payload, ensure_ascii=False))


def _worker_name() -> str:
    return f"finance-worker:{socket.gethostname()}:{os.getpid()}"


def _build_cli() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LifeOS finance worker")
    parser.set_defaults(
        batch_size=config.FINANCE_BOT_META_BATCH_SIZE,
        poll_seconds=config.FINANCE_WORKER_POLL_SECONDS,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    for command_name in (
        "process-expenses",
        "process-report-queue",
        "process-failed",
        "run-once",
    ):
        command_parser = subparsers.add_parser(command_name)
        command_parser.add_argument(
            "--batch-size",
            type=int,
            default=config.FINANCE_BOT_META_BATCH_SIZE,
        )

    weekly_parser = subparsers.add_parser("weekly-report")
    weekly_parser.add_argument("--iso-year", type=int)
    weekly_parser.add_argument("--iso-week", type=int)

    loop_parser = subparsers.add_parser("run-loop")
    loop_parser.add_argument(
        "--batch-size",
        type=int,
        default=config.FINANCE_BOT_META_BATCH_SIZE,
    )
    loop_parser.add_argument(
        "--poll-seconds",
        type=int,
        default=config.FINANCE_WORKER_POLL_SECONDS,
    )
    return parser


if __name__ == "__main__":
    raise SystemExit(main())
