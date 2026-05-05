from __future__ import annotations

import json
import logging
import time
from typing import Any
from urllib import error, parse, request


logger = logging.getLogger(__name__)


class SupabaseError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None, body: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class SupabaseRestClient:
    def __init__(
        self,
        base_url: str,
        service_role_key: str,
        timeout_seconds: int = 30,
        request_max_retries: int = 2,
        request_retry_backoff_seconds: float = 1.0,
    ):
        if not base_url or not service_role_key:
            raise ValueError("Supabase base URL and service role key are required")

        self.base_url = base_url.rstrip("/")
        self.rest_base = f"{self.base_url}/rest/v1"
        self.timeout_seconds = timeout_seconds
        self.request_max_retries = request_max_retries
        self.request_retry_backoff_seconds = request_retry_backoff_seconds
        self.base_headers = {
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Accept": "application/json",
        }

    def select(self, table: str, params: dict[str, Any] | None = None) -> Any:
        return self._request("GET", table, params=params)

    def rpc(self, function_name: str, payload: dict[str, Any] | None = None) -> Any:
        safe_payload = payload or {}
        logger.info(
            "Supabase RPC call function=%s payload=%s",
            function_name,
            json.dumps(safe_payload, ensure_ascii=False, sort_keys=True),
        )
        return self._request("POST", f"rpc/{function_name}", json_body=safe_payload)

    def upsert(
        self,
        table: str,
        rows: list[dict[str, Any]],
        *,
        on_conflict: str,
        returning: str = "minimal",
        ignore_duplicates: bool = False,
    ) -> Any:
        resolution = "ignore-duplicates" if ignore_duplicates else "merge-duplicates"
        prefer_values = [f"resolution={resolution}", f"return={returning}"]
        headers = {
            "Prefer": ",".join(prefer_values),
        }
        params = {"on_conflict": on_conflict}
        return self._request("POST", table, params=params, json_body=rows, headers=headers)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        query_string = ""
        if params:
            query_string = parse.urlencode(params, doseq=True)

        url = f"{self.rest_base}/{path}"
        if query_string:
            url = f"{url}?{query_string}"

        body = None
        request_headers = dict(self.base_headers)
        if json_body is not None:
            body = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        if headers:
            request_headers.update(headers)

        req = request.Request(url, data=body, headers=request_headers, method=method)

        attempt = 0
        while True:
            try:
                with request.urlopen(req, timeout=self.timeout_seconds) as response:
                    raw_body = response.read()
                    if not raw_body:
                        return None
                    decoded_body = raw_body.decode("utf-8")
                    if not decoded_body.strip():
                        return None
                    return json.loads(decoded_body)
            except error.HTTPError as exc:
                body_text = exc.read().decode("utf-8", errors="replace")
                if self._should_retry_http_error(exc.code) and attempt < self.request_max_retries:
                    sleep_seconds = self.request_retry_backoff_seconds * (2 ** attempt)
                    logger.warning(
                        "Retrying Supabase HTTP error method=%s url=%s status=%s attempt=%s/%s sleep=%.1fs body=%s",
                        method,
                        url,
                        exc.code,
                        attempt + 1,
                        self.request_max_retries,
                        sleep_seconds,
                        body_text,
                    )
                    time.sleep(sleep_seconds)
                    attempt += 1
                    continue
                raise SupabaseError(
                    f"Supabase request failed with HTTP {exc.code} for {method} {url}",
                    status_code=exc.code,
                    body=body_text,
                ) from exc
            except error.URLError as exc:
                if attempt < self.request_max_retries:
                    sleep_seconds = self.request_retry_backoff_seconds * (2 ** attempt)
                    logger.warning(
                        "Retrying Supabase URL error method=%s url=%s attempt=%s/%s sleep=%.1fs error=%s",
                        method,
                        url,
                        attempt + 1,
                        self.request_max_retries,
                        sleep_seconds,
                        exc,
                    )
                    time.sleep(sleep_seconds)
                    attempt += 1
                    continue
                raise SupabaseError(f"Supabase request failed for {method} {url}: {exc}") from exc

    @staticmethod
    def _should_retry_http_error(status_code: int) -> bool:
        return status_code in {408, 409, 425, 429, 500, 502, 503, 504}
