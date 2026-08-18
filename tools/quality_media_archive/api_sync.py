"""Authenticated, local-only API synchronization for the quality archive.

The bearer credential is intentionally an in-memory transport concern.  It is
never accepted by the CLI and is never copied into archive manifests or result
payloads.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol, Sequence

try:
    from .archive_core import (
        MAX_LOCAL_SOURCE_BYTES,
        MAX_REMOTE_IMAGE_BYTES,
        ArchiveError,
        ArchiveLayout,
        ArchivePlan,
        SourceCandidate,
        SourceValidationError,
        StagedBlob,
        _NoRedirectHandler,
        _copy_stream_to_staging,
        apply_plan,
        canonical_json_bytes,
        ensure_lower_hex_sha256,
        fetch_cloudinary_to_staging,
        find_existing_archived_candidates,
        normalize_aware_iso_datetime,
        object_relative_path,
        sha256_bytes,
        validate_cloudinary_quality_url,
        validate_layout,
    )
except ImportError:
    from archive_core import (
        MAX_LOCAL_SOURCE_BYTES,
        MAX_REMOTE_IMAGE_BYTES,
        ArchiveError,
        ArchiveLayout,
        ArchivePlan,
        SourceCandidate,
        SourceValidationError,
        StagedBlob,
        _NoRedirectHandler,
        _copy_stream_to_staging,
        apply_plan,
        canonical_json_bytes,
        ensure_lower_hex_sha256,
        fetch_cloudinary_to_staging,
        find_existing_archived_candidates,
        normalize_aware_iso_datetime,
        object_relative_path,
        sha256_bytes,
        validate_cloudinary_quality_url,
        validate_layout,
    )


API_BASE_URL_ENV = "WJ_QUALITY_ARCHIVE_API_BASE_URL"
API_BEARER_TOKEN_ENV = "WJ_QUALITY_ARCHIVE_BEARER_TOKEN"
REPORTS_PATH = "/api/quality/archive/reports/"
IMPORT_ASSETS_PATH = "/api/quality/archive/assets/"
MAX_JSON_RESPONSE_BYTES = 20 * 1024 * 1024
MAX_API_PAGES = 10_000
MAX_API_ROWS = 1_000_000


class SyncTransport(Protocol):
    def get_json(self, url: str) -> Mapping[str, Any]: ...

    def post_json(self, url: str, payload: Mapping[str, Any]) -> Mapping[str, Any]: ...

    def fetch_to_staging(self, candidate: SourceCandidate, staging: Path) -> StagedBlob: ...


@dataclass(frozen=True)
class MarkSpec:
    source_label: str
    url: str
    expected_sha256: str
    kind: str


@dataclass(frozen=True)
class ApiSnapshot:
    plan: ArchivePlan
    marks: Mapping[str, MarkSpec]
    report_count: int
    pending_asset_count: int


def validate_api_base_url(raw_url: Any) -> str:
    if not isinstance(raw_url, str) or raw_url != raw_url.strip() or not raw_url:
        raise SourceValidationError(f"{API_BASE_URL_ENV} must be a non-empty exact HTTPS URL")
    try:
        parsed = urllib.parse.urlsplit(raw_url)
        port = parsed.port
    except ValueError as exc:
        raise SourceValidationError(f"{API_BASE_URL_ENV} is malformed") from exc
    if parsed.scheme != "https" or not parsed.hostname:
        raise SourceValidationError(f"{API_BASE_URL_ENV} must use HTTPS")
    if parsed.username or parsed.password or port not in (None, 443):
        raise SourceValidationError(f"{API_BASE_URL_ENV} cannot contain credentials or a custom port")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise SourceValidationError(f"{API_BASE_URL_ENV} must be an origin without path/query/fragment")
    hostname = parsed.hostname.lower()
    return urllib.parse.urlunsplit(("https", hostname, "", "", ""))


def read_api_configuration(environ: Mapping[str, str] | None = None) -> tuple[str, str]:
    values = environ if environ is not None else os.environ
    base_url = validate_api_base_url(values.get(API_BASE_URL_ENV, ""))
    token = values.get(API_BEARER_TOKEN_ENV, "")
    if not isinstance(token, str) or token != token.strip() or not token:
        raise SourceValidationError(f"{API_BEARER_TOKEN_ENV} must be set for --apply")
    if any(character.isspace() for character in token):
        raise SourceValidationError(f"{API_BEARER_TOKEN_ENV} must not contain whitespace")
    return base_url, token


def _absolute_api_url(
    base_url: str,
    path_or_url: str,
    *,
    exact_path: str,
    allow_query: bool = False,
) -> str:
    candidate = urllib.parse.urljoin(base_url + "/", path_or_url)
    try:
        parsed = urllib.parse.urlsplit(candidate)
        port = parsed.port
    except ValueError as exc:
        raise SourceValidationError("quality API returned a malformed URL") from exc
    base = urllib.parse.urlsplit(base_url)
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() != (base.hostname or "").lower()
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or parsed.fragment
        or (parsed.query and not allow_query)
    ):
        raise SourceValidationError("quality API URL escaped the configured HTTPS origin")
    if parsed.path != urllib.parse.unquote(parsed.path) or parsed.path != exact_path:
        raise SourceValidationError("quality API URL has an unexpected path")
    return urllib.parse.urlunsplit(("https", parsed.hostname or "", parsed.path, parsed.query, ""))


def _list_url(base_url: str, path: str, query: Mapping[str, str]) -> str:
    encoded = urllib.parse.urlencode(query)
    return _absolute_api_url(
        base_url,
        f"{path}?{encoded}",
        exact_path=path,
        allow_query=True,
    )


def _require_positive_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise SourceValidationError(f"{field_name} must be a positive integer")
    return value


def _require_bounded_size(value: Any, field_name: str, *, maximum: int) -> int:
    size = _require_positive_int(value, field_name)
    if size > maximum:
        raise SourceValidationError(f"{field_name} exceeds the archive byte limit")
    return size


def _require_nonempty_string(value: Any, field_name: str, *, max_length: int = 1024) -> str:
    if (
        not isinstance(value, str)
        or value != value.strip()
        or not value
        or len(value) > max_length
        or "\x00" in value
    ):
        raise SourceValidationError(f"{field_name} must be a bounded exact string")
    return value


def _require_media_type(value: Any, field_name: str, *, image: bool = False) -> str:
    media_type = _require_nonempty_string(value, field_name, max_length=128).lower()
    if ";" in media_type or "/" not in media_type:
        raise SourceValidationError(f"{field_name} must be a canonical MIME type")
    if image and not media_type.startswith("image/"):
        raise SourceValidationError(f"{field_name} must be an image MIME type")
    return media_type


def _safe_extension(value: Any, field_name: str) -> str:
    extension = _require_nonempty_string(value, field_name, max_length=16)
    if extension != extension.lower() or not re.fullmatch(r"[a-z0-9]{1,16}", extension):
        raise SourceValidationError(f"{field_name} must be a lowercase alphanumeric extension")
    return extension


def _paginate(
    transport: SyncTransport,
    base_url: str,
    path: str,
    *,
    query: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    expected_query = {"page_size": "200", **dict(query or {})}
    url: str | None = _list_url(base_url, path, expected_query)
    seen_urls: set[str] = set()
    rows: list[dict[str, Any]] = []
    expected_count: int | None = None
    page_number = 0
    while url is not None:
        url = _absolute_api_url(base_url, url, exact_path=path, allow_query=True)
        try:
            parsed_query = urllib.parse.parse_qs(
                urllib.parse.urlsplit(url).query,
                strict_parsing=True,
            )
        except ValueError as exc:
            raise SourceValidationError("quality API pagination query is malformed") from exc
        if any(key not in {"page", "page_size", *expected_query.keys()} for key in parsed_query):
            raise SourceValidationError("quality API pagination added an unexpected query parameter")
        if parsed_query.get("page_size") != ["200"]:
            raise SourceValidationError("quality API pagination changed the requested page size")
        for key, expected_value in (query or {}).items():
            if parsed_query.get(key) != [expected_value]:
                raise SourceValidationError("quality API pagination changed a required filter")
        if url in seen_urls or page_number >= MAX_API_PAGES:
            raise SourceValidationError("quality API pagination loop or page limit detected")
        seen_urls.add(url)
        page_number += 1
        payload = transport.get_json(url)
        if not isinstance(payload, Mapping):
            raise SourceValidationError("quality API page must be a JSON object")
        count = payload.get("count")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0 or count > MAX_API_ROWS:
            raise SourceValidationError("quality API page has an invalid count")
        if expected_count is None:
            expected_count = count
        elif count != expected_count:
            raise SourceValidationError("quality API count changed while paginating")
        results = payload.get("results")
        if not isinstance(results, list) or any(not isinstance(row, dict) for row in results):
            raise SourceValidationError("quality API page has invalid results")
        rows.extend(results)
        if len(rows) > MAX_API_ROWS or len(rows) > expected_count:
            raise SourceValidationError("quality API returned more rows than its declared count")
        next_url = payload.get("next")
        if next_url is not None and not isinstance(next_url, str):
            raise SourceValidationError("quality API next link must be a URL or null")
        url = next_url
    if expected_count is None or len(rows) != expected_count:
        raise SourceValidationError("quality API pagination ended before all declared rows arrived")
    return rows


def _unique_plan(candidates: Sequence[SourceCandidate], warnings: Sequence[str]) -> ArchivePlan:
    seen: set[str] = set()
    unique: list[SourceCandidate] = []
    for candidate in candidates:
        identity = sha256_bytes(
            canonical_json_bytes(
                {
                    "kind": candidate.kind,
                    "source": candidate.source,
                    "expected_sha256": candidate.expected_sha256,
                }
            )
        )
        if identity not in seen:
            seen.add(identity)
            unique.append(candidate)
    return ArchivePlan(candidates=unique, warnings=list(dict.fromkeys(warnings)))


def collect_api_snapshot(transport: SyncTransport, base_url: str) -> ApiSnapshot:
    """Fetch a complete, internally consistent API snapshot before writing."""

    reports = _paginate(transport, base_url, REPORTS_PATH)
    assets = _paginate(
        transport,
        base_url,
        IMPORT_ASSETS_PATH,
        query={"mirror_state": "pending"},
    )
    candidates: list[SourceCandidate] = []
    marks: dict[str, MarkSpec] = {}
    warnings = [
        "QualityReport 사진은 동일 URL·수정시각의 로컬 manifest와 객체 hash가 일치하면 원격 재다운로드를 생략합니다."
    ]

    for report in reports:
        report_id = _require_positive_int(report.get("id"), "quality report id")
        updated_at = normalize_aware_iso_datetime(
            report.get("updated_at"), f"quality report {report_id} updated_at"
        )
        for field_name in ("image1", "image2", "image3"):
            raw_url = report.get(field_name)
            if raw_url in (None, ""):
                continue
            delivery_url = validate_cloudinary_quality_url(raw_url)
            source = {
                "source_type": "quality_report_api_current_cloudinary_reference",
                "source_system": "wj_reporting",
                "source_entity": "quality.QualityReport",
                "source_entity_id": str(report_id),
                "source_field": field_name,
                "source_updated_at": updated_at,
                "selection_basis": "current_quality_report_api_reference",
                "approval_state": "not_modeled_in_current_schema",
                "delivery_url": delivery_url,
            }
            candidates.append(
                SourceCandidate(
                    kind="cloudinary_quality_photo",
                    label=f"quality_report:{report_id}:{field_name}",
                    source=source,
                    media_type_hint="image/unknown",
                    remote_url=delivery_url,
                    content_validation="image",
                )
            )

    for asset in assets:
        asset_id = _require_positive_int(asset.get("id"), "quality import asset id")
        if asset.get("mirror_state") != "pending":
            raise SourceValidationError("pending asset endpoint returned a non-pending row")
        sha = ensure_lower_hex_sha256(asset.get("sha256"), "asset sha256")
        byte_size = _require_bounded_size(
            asset.get("byte_size"),
            "asset byte_size",
            maximum=MAX_REMOTE_IMAGE_BYTES,
        )
        content_type = _require_media_type(
            asset.get("content_type"), "asset content_type", image=True
        )
        extension = _safe_extension(asset.get("extension"), "asset extension")
        created_at = normalize_aware_iso_datetime(
            asset.get("created_at"), f"quality import asset {asset_id} created_at"
        )
        content_path = f"/api/quality/archive/assets/{asset_id}/content/"
        content_url = _absolute_api_url(
            base_url,
            _require_nonempty_string(asset.get("url"), "asset url"),
            exact_path=content_path,
        )
        label = f"quality_import_asset:{asset_id}"
        source = {
            "source_type": "quality_import_api_asset",
            "source_system": "wj_reporting",
            "source_entity": "quality.QualityImportAsset",
            "source_entity_id": str(asset_id),
            "selection_basis": "mirror_state_pending",
            "source_filename": f"{sha}.{extension}",
            "source_created_at": created_at,
            "server_sha256": sha,
            "server_byte_size": byte_size,
            "server_content_type": content_type,
            "server_width": asset.get("width"),
            "server_height": asset.get("height"),
            "content_url": content_url,
        }
        candidates.append(
            SourceCandidate(
                kind="quality_import_asset",
                label=label,
                source=source,
                media_type_hint=content_type,
                expected_sha256=sha,
                expected_size=byte_size,
                remote_url=content_url,
                content_validation="image",
            )
        )
        mark_url = _absolute_api_url(
            base_url,
            f"/api/quality/archive/assets/{asset_id}/mark-mirrored/",
            exact_path=f"/api/quality/archive/assets/{asset_id}/mark-mirrored/",
        )
        marks[label] = MarkSpec(label, mark_url, sha, "asset")

    return ApiSnapshot(
        plan=_unique_plan(candidates, warnings),
        marks=marks,
        report_count=len(reports),
        pending_asset_count=len(assets),
    )


def _verify_archived_item(layout: ArchiveLayout, item: Mapping[str, Any], mark: MarkSpec) -> str:
    sha = ensure_lower_hex_sha256(item.get("sha256"), "archived sha256")
    if sha != mark.expected_sha256:
        raise SourceValidationError("archive result checksum does not match mark contract")
    expected_relative = object_relative_path(sha).as_posix()
    if item.get("object_relative_path") != expected_relative:
        raise SourceValidationError("archive result path is not content-addressed")
    path = layout.root / expected_relative
    if path.is_symlink() or not path.is_file():
        raise SourceValidationError("archived object is missing or unsafe")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    if digest.hexdigest() != sha or size != item.get("byte_size"):
        raise SourceValidationError("archived object failed pre-mark hash verification")
    return expected_relative


def run_api_sync(
    layout: ArchiveLayout,
    *,
    base_url: str,
    transport: SyncTransport,
) -> dict[str, Any]:
    snapshot = collect_api_snapshot(transport, base_url)
    if not snapshot.plan.candidates:
        return {
            "status": "ok",
            "dry_run": False,
            "network_accessed": True,
            "archive_root": str(layout.root),
            "report_count": snapshot.report_count,
            "pending_asset_count": 0,
            "candidate_count": 0,
            "archived_count": 0,
            "deduplicated_count": 0,
            "already_archived_count": 0,
            "marked_mirrored_count": 0,
            "mark_failure_count": 0,
            "failures": [],
            "warnings": snapshot.plan.warnings,
        }
    existing_items = find_existing_archived_candidates(layout, snapshot.plan.candidates)
    remaining_plan = ArchivePlan(
        candidates=[
            candidate
            for candidate in snapshot.plan.candidates
            if candidate.label not in existing_items
        ],
        warnings=snapshot.plan.warnings,
    )
    if remaining_plan.candidates:
        archive_result = apply_plan(
            remaining_plan,
            layout,
            remote_fetcher=transport.fetch_to_staging,
        )
    else:
        archive_result = {
            "status": "ok",
            "archived_count": 0,
            "deduplicated_count": 0,
            "failures": [],
            "items": [],
        }
    successful_items = dict(existing_items)
    successful_items.update({
        item["source_label"]: item for item in archive_result.get("items", [])
    })
    mark_failures: list[dict[str, str]] = []
    marked = 0
    for label, mark in snapshot.marks.items():
        item = successful_items.get(label)
        if item is None:
            continue
        try:
            relative_path = _verify_archived_item(layout, item, mark)
            response = transport.post_json(
                mark.url,
                {"sha256": mark.expected_sha256, "archive_relative_path": relative_path},
            )
            state = response.get("mirror_state") if isinstance(response, Mapping) else None
            returned_path = response.get("archive_relative_path") if isinstance(response, Mapping) else None
            returned_sha = response.get("sha256") if isinstance(response, Mapping) else None
            if state != "mirrored" or returned_path != relative_path or returned_sha != mark.expected_sha256:
                raise SourceValidationError("mirror acknowledgement did not confirm the archived object")
            marked += 1
        except (ArchiveError, OSError) as exc:
            mark_failures.append(
                {"source_label": label, "error_type": type(exc).__name__, "error": str(exc)}
            )

    archive_failures = list(archive_result.get("failures", []))
    failures = archive_failures + mark_failures
    return {
        "status": "ok" if not failures else "partial_failure",
        "dry_run": False,
        "network_accessed": True,
        "archive_root": str(layout.root),
        "run_id": archive_result.get("run_id"),
        "run_manifest": archive_result.get("run_manifest"),
        "report_count": snapshot.report_count,
        "pending_asset_count": snapshot.pending_asset_count,
        "candidate_count": len(snapshot.plan.candidates),
        "archived_count": archive_result.get("archived_count", 0),
        "deduplicated_count": archive_result.get("deduplicated_count", 0),
        "already_archived_count": len(existing_items),
        "archive_failure_count": len(archive_failures),
        "marked_mirrored_count": marked,
        "mark_failure_count": len(mark_failures),
        "failures": failures,
        "warnings": snapshot.plan.warnings,
    }


def api_sync_dry_run(layout: ArchiveLayout) -> dict[str, Any]:
    validate_layout(layout, for_write=True)
    return {
        "status": "dry_run",
        "dry_run": True,
        "network_accessed": False,
        "filesystem_written": False,
        "archive_root": str(layout.root),
        "configuration_env": [API_BASE_URL_ENV, API_BEARER_TOKEN_ENV],
        "planned_endpoints": [
            REPORTS_PATH,
            f"{IMPORT_ASSETS_PATH}?mirror_state=pending",
        ],
        "behavior": "--apply is required before environment credentials are read or any network request is made",
    }


class AuthenticatedApiTransport:
    """urllib transport that sends the bearer only to the configured origin."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        refresh_access_token: Callable[[], str] | None = None,
    ):
        self._base_url = validate_api_base_url(base_url)
        self._token = ""
        self._set_token(token)
        self._refresh_access_token = refresh_access_token
        self._dns_checked = False
        self._opener = urllib.request.build_opener(_NoRedirectHandler())

    def __repr__(self) -> str:
        return f"AuthenticatedApiTransport(base_url={self._base_url!r}, token=<redacted>)"

    def _set_token(self, token: str) -> None:
        if not isinstance(token, str) or token != token.strip() or not token:
            raise SourceValidationError("quality API bearer credential is invalid")
        if any(character.isspace() for character in token):
            raise SourceValidationError("quality API bearer credential is invalid")
        self._token = token

    def _require_public_dns(self) -> None:
        if self._dns_checked:
            return
        hostname = urllib.parse.urlsplit(self._base_url).hostname or ""
        try:
            addresses = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise SourceValidationError("quality API DNS resolution failed") from exc
        if not addresses:
            raise SourceValidationError("quality API DNS returned no addresses")
        for address in addresses:
            ip = ipaddress.ip_address(address[4][0].split("%", 1)[0])
            if not ip.is_global:
                raise SourceValidationError("quality API resolved to a non-public address")
        self._dns_checked = True

    def _authenticated_request(
        self,
        method: str,
        url: str,
        *,
        body: bytes | None = None,
        accept: str,
    ) -> urllib.request.Request:
        parsed = urllib.parse.urlsplit(url)
        base = urllib.parse.urlsplit(self._base_url)
        if parsed.scheme != "https" or parsed.netloc.lower() != base.netloc.lower():
            raise SourceValidationError("refusing to send bearer outside the configured API origin")
        self._require_public_dns()
        headers = {
            "Accept": accept,
            "Authorization": f"Bearer {self._token}",
            "User-Agent": "wj-quality-local-archive/2",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        return urllib.request.Request(url, data=body, headers=headers, method=method)

    @staticmethod
    def _read_bounded_json(response: Any) -> Mapping[str, Any]:
        declared = response.headers.get("Content-Length")
        if declared:
            try:
                declared_size = int(declared)
            except ValueError as exc:
                raise SourceValidationError("quality API Content-Length is invalid") from exc
            if declared_size < 0 or declared_size > MAX_JSON_RESPONSE_BYTES:
                raise SourceValidationError("quality API JSON response exceeds the byte limit")
        content_type = (response.headers.get_content_type() or "").lower()
        if content_type != "application/json":
            raise SourceValidationError("quality API response is not JSON")
        raw = response.read(MAX_JSON_RESPONSE_BYTES + 1)
        if len(raw) > MAX_JSON_RESPONSE_BYTES:
            raise SourceValidationError("quality API JSON response exceeds the byte limit")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SourceValidationError("quality API returned invalid JSON") from exc
        if not isinstance(payload, Mapping):
            raise SourceValidationError("quality API JSON root must be an object")
        return payload

    def _open(
        self,
        request: urllib.request.Request,
        *,
        expected_url: str,
        timeout: int = 30,
        allow_auth_refresh: bool = True,
    ):
        try:
            response = self._opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            if exc.code == 401 and allow_auth_refresh and self._refresh_access_token is not None:
                exc.close()
                self._set_token(self._refresh_access_token())
                retry_request = self._authenticated_request(
                    request.get_method(),
                    expected_url,
                    body=request.data,
                    accept=request.get_header("Accept") or "*/*",
                )
                return self._open(
                    retry_request,
                    expected_url=expected_url,
                    timeout=timeout,
                    allow_auth_refresh=False,
                )
            raise SourceValidationError(f"quality API request failed with HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise SourceValidationError("quality API request failed") from exc
        if getattr(response, "status", 200) < 200 or getattr(response, "status", 200) >= 300:
            response.close()
            raise SourceValidationError("quality API returned a non-success status")
        if response.geturl() != expected_url:
            response.close()
            raise SourceValidationError("quality API response URL changed unexpectedly")
        return response

    def get_json(self, url: str) -> Mapping[str, Any]:
        request = self._authenticated_request("GET", url, accept="application/json")
        with self._open(request, expected_url=url) as response:
            return self._read_bounded_json(response)

    def post_json(self, url: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        body = canonical_json_bytes(payload)
        request = self._authenticated_request("POST", url, body=body, accept="application/json")
        with self._open(request, expected_url=url) as response:
            return self._read_bounded_json(response)

    def fetch_to_staging(self, candidate: SourceCandidate, staging: Path) -> StagedBlob:
        if not candidate.remote_url:
            raise SourceValidationError("remote API candidate is missing its URL")
        if urllib.parse.urlsplit(candidate.remote_url).hostname == "res.cloudinary.com":
            return fetch_cloudinary_to_staging(candidate, staging)
        request = self._authenticated_request("GET", candidate.remote_url, accept="*/*")
        with self._open(request, expected_url=candidate.remote_url, timeout=60) as response:
            declared = response.headers.get("Content-Length")
            if declared:
                try:
                    declared_size = int(declared)
                except ValueError as exc:
                    raise SourceValidationError("quality content Content-Length is invalid") from exc
                if declared_size <= 0 or (
                    candidate.expected_size is not None and declared_size != candidate.expected_size
                ):
                    raise SourceValidationError("quality content length disagrees with server metadata")
            response_type = (response.headers.get_content_type() or "").lower()
            expected_type = candidate.media_type_hint.lower()
            if response_type != expected_type:
                raise SourceValidationError("quality content MIME type disagrees with server metadata")
            max_bytes = (
                MAX_REMOTE_IMAGE_BYTES
                if candidate.content_validation == "image"
                else MAX_LOCAL_SOURCE_BYTES
            )
            return _copy_stream_to_staging(
                response,
                staging,
                max_bytes=max_bytes,
                media_type=response_type,
                retrieval={
                    "http_etag": response.headers.get("ETag"),
                    "http_last_modified": response.headers.get("Last-Modified"),
                    "http_content_type": response_type,
                },
            )
