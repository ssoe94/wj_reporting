"""Content-addressed local archive for quality image evidence.

The module has no database access and does not read application secrets.  Its
only remote operation is a bounded HTTPS GET for an explicitly supplied,
validated Cloudinary quality delivery URL, and that happens only in apply mode.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import socket
import stat
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Callable, Iterator, Mapping, Sequence


SCHEMA_VERSION = "quality-media-archive.v1"
FIXED_MOUNT_ROOT = Path("/Volumes/Ted_SSD")
FIXED_ARCHIVE_ROOT = FIXED_MOUNT_ROOT / "WJ_DATA_CENTER" / "quality_media_archive"
MAX_JSON_BYTES = 100 * 1024 * 1024
MAX_LOCAL_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
MAX_REMOTE_IMAGE_BYTES = 50 * 1024 * 1024
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CLOUDINARY_HOST = "res.cloudinary.com"


class ArchiveError(RuntimeError):
    """Base error whose message is safe to show to a local operator."""


class DriveUnavailable(ArchiveError):
    """The fixed archive drive is unavailable or unsafe for use."""


class SourceValidationError(ArchiveError):
    """A source does not meet the explicit archive contract."""


class ArchiveIntegrityError(ArchiveError):
    """Existing archive state failed deterministic integrity checks."""


@dataclass(frozen=True)
class ArchiveLayout:
    root: Path = FIXED_ARCHIVE_ROOT
    mount_root: Path = FIXED_MOUNT_ROOT
    require_mount: bool = True

    @property
    def objects(self) -> Path:
        return self.root / "objects" / "sha256"

    @property
    def item_manifests(self) -> Path:
        return self.root / "manifests" / "items"

    @property
    def run_manifests(self) -> Path:
        return self.root / "manifests" / "runs"

    @property
    def state(self) -> Path:
        return self.root / "state"

    @property
    def staging(self) -> Path:
        return self.state / "staging"

    @property
    def lock_file(self) -> Path:
        return self.state / "archive.lock"


@dataclass(frozen=True)
class SourceCandidate:
    kind: str
    label: str
    source: Mapping[str, Any]
    media_type_hint: str
    expected_sha256: str | None = None
    expected_size: int | None = None
    remote_url: str | None = None
    content_validation: str = "none"


@dataclass
class ArchivePlan:
    candidates: list[SourceCandidate] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class StagedBlob:
    path: Path
    sha256: str
    byte_size: int
    media_type: str
    retrieval: Mapping[str, Any] = field(default_factory=dict)


RemoteFetcher = Callable[[SourceCandidate, Path], StagedBlob]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def ensure_lower_hex_sha256(value: Any, field_name: str = "sha256") -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise ArchiveIntegrityError(f"{field_name} must be a lowercase SHA-256 value")
    return value


def is_within(path: Path, parent: Path) -> bool:
    try:
        return os.path.commonpath((str(path.absolute()), str(parent.absolute()))) == str(
            parent.absolute()
        )
    except ValueError:
        return False


def _existing_path_components(base: Path, target: Path) -> Iterator[Path]:
    if not is_within(target, base):
        raise DriveUnavailable("archive root must stay inside the configured mount")
    yield base
    current = base
    for part in target.absolute().relative_to(base.absolute()).parts:
        current = current / part
        if current.exists() or current.is_symlink():
            yield current
        else:
            break


def _require_real_directory(path: Path, *, label: str) -> None:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError as exc:
        raise DriveUnavailable(f"{label} is missing: {path}") from exc
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
        raise DriveUnavailable(f"{label} must be a real directory, not a symlink: {path}")


def validate_layout(layout: ArchiveLayout, *, for_write: bool, root_must_exist: bool = False) -> None:
    _require_real_directory(layout.mount_root, label="archive mount")
    if layout.require_mount and not os.path.ismount(layout.mount_root):
        raise DriveUnavailable(f"archive drive is not mounted: {layout.mount_root}")
    if not os.access(layout.mount_root, os.R_OK | os.X_OK):
        raise DriveUnavailable(f"archive drive is not readable: {layout.mount_root}")
    if for_write and not os.access(layout.mount_root, os.W_OK):
        raise DriveUnavailable(f"archive drive is not writable: {layout.mount_root}")
    if not is_within(layout.root, layout.mount_root) or layout.root == layout.mount_root:
        raise DriveUnavailable("archive root must be a child of the configured mount")

    for component in _existing_path_components(layout.mount_root, layout.root):
        _require_real_directory(component, label="archive path component")
    if root_must_exist:
        _require_real_directory(layout.root, label="archive root")
    if layout.root.exists():
        for child in (layout.objects, layout.item_manifests, layout.run_manifests, layout.state):
            for component in _existing_path_components(layout.root, child):
                _require_real_directory(component, label="archive managed directory")


def _mkdir_chain(base: Path, target: Path) -> None:
    if not is_within(target, base):
        raise DriveUnavailable("refusing to create a directory outside the archive mount")
    current = base
    for part in target.absolute().relative_to(base.absolute()).parts:
        current = current / part
        try:
            current.mkdir()
        except FileExistsError:
            pass
        _require_real_directory(current, label="archive managed directory")


def initialize_layout(layout: ArchiveLayout) -> None:
    validate_layout(layout, for_write=True)
    for directory in (
        layout.root,
        layout.objects,
        layout.item_manifests,
        layout.run_manifests,
        layout.state,
        layout.staging,
    ):
        _mkdir_chain(layout.mount_root, directory)
    validate_layout(layout, for_write=True, root_must_exist=True)


def _open_nofollow(path: Path, flags: int, mode: int = 0o600) -> int:
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    return os.open(path, flags | nofollow, mode)


@contextlib.contextmanager
def archive_lock(layout: ArchiveLayout, *, exclusive: bool, create: bool) -> Iterator[None]:
    flags = os.O_RDWR | (os.O_CREAT if create else 0)
    try:
        descriptor = _open_nofollow(layout.lock_file, flags)
    except FileNotFoundError as exc:
        raise DriveUnavailable("archive lock is missing; no applied archive exists") from exc
    try:
        lock_mode = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        try:
            fcntl.flock(descriptor, lock_mode | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise DriveUnavailable("another archive or verification run is active") from exc
        yield
    finally:
        with contextlib.suppress(OSError):
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        with contextlib.suppress(OSError):
            os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    _require_real_directory(path.parent, label="archive write parent")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        _fsync_directory(path.parent)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    atomic_write_bytes(path, canonical_json_bytes(payload) + b"\n")


def read_json_object_with_sha256(
    path: Path,
    *,
    max_bytes: int = MAX_JSON_BYTES,
) -> tuple[dict[str, Any], str]:
    if path.is_symlink():
        raise SourceValidationError(f"JSON source must not be a symlink: {path}")
    try:
        before = path.stat()
    except FileNotFoundError as exc:
        raise SourceValidationError(f"JSON source is missing: {path}") from exc
    if not path.is_file() or before.st_size > max_bytes:
        raise SourceValidationError(f"JSON source is not a bounded regular file: {path}")
    try:
        raw = path.read_bytes()
        payload = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SourceValidationError(f"JSON source is invalid: {path}") from exc
    after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ):
        raise SourceValidationError(f"JSON source changed while being read: {path}")
    if not isinstance(payload, dict):
        raise SourceValidationError(f"JSON root must be an object: {path}")
    return payload, hashlib.sha256(raw).hexdigest()


def read_json_object(path: Path, *, max_bytes: int = MAX_JSON_BYTES) -> dict[str, Any]:
    payload, _ = read_json_object_with_sha256(path, max_bytes=max_bytes)
    return payload


def _hash_binary_stream(stream: BinaryIO, *, max_bytes: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise SourceValidationError(f"source exceeds byte limit ({max_bytes})")
        digest.update(chunk)
    return digest.hexdigest(), total


def hash_local_file(path: Path, *, max_bytes: int = MAX_LOCAL_SOURCE_BYTES) -> tuple[str, int, int]:
    if path.is_symlink():
        raise SourceValidationError(f"local source must not be a symlink: {path}")
    try:
        before = path.stat()
    except FileNotFoundError as exc:
        raise SourceValidationError(f"local source is missing: {path}") from exc
    if not path.is_file() or before.st_size <= 0 or before.st_size > max_bytes:
        raise SourceValidationError(f"local source is not a bounded non-empty file: {path}")
    with path.open("rb") as handle:
        digest, byte_size = _hash_binary_stream(handle, max_bytes=max_bytes)
    after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ):
        raise SourceValidationError(f"local source changed while being read: {path}")
    return digest, byte_size, before.st_mtime_ns


def _safe_resolved_source(path: Path) -> Path:
    if path.is_symlink():
        raise SourceValidationError(f"source symlinks are not allowed: {path}")
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError as exc:
        raise SourceValidationError(f"source is missing: {path}") from exc
    if not resolved.is_file():
        raise SourceValidationError(f"source must be a regular file: {path}")
    return resolved


def validate_cloudinary_quality_url(raw_url: Any) -> str:
    if not isinstance(raw_url, str) or raw_url != raw_url.strip() or not raw_url:
        raise SourceValidationError("Cloudinary URL must be a non-empty exact string")
    try:
        parsed = urllib.parse.urlsplit(raw_url)
        port = parsed.port
    except ValueError as exc:
        raise SourceValidationError("Cloudinary URL is malformed") from exc
    if parsed.scheme != "https" or (parsed.hostname or "").lower() != CLOUDINARY_HOST:
        raise SourceValidationError("quality media URL must use HTTPS on res.cloudinary.com")
    if parsed.username or parsed.password or port not in (None, 443):
        raise SourceValidationError("Cloudinary URL must not contain credentials or a custom port")
    if parsed.query or parsed.fragment:
        raise SourceValidationError("Cloudinary URL query strings and fragments are not archived")
    decoded_path = urllib.parse.unquote(parsed.path)
    parts = [part for part in PurePosixPath(decoded_path).parts if part not in {"/", ""}]
    if any(part in {".", ".."} for part in parts):
        raise SourceValidationError("Cloudinary URL path traversal is not allowed")
    try:
        image_index = parts.index("image")
        upload_index = parts.index("upload", image_index + 1)
    except ValueError as exc:
        raise SourceValidationError("Cloudinary URL must be an image/upload delivery URL") from exc
    delivery_parts = parts[upload_index + 1 :]
    legacy_quality_photo = "quality" in delivery_parts
    managed_import_asset = any(
        delivery_parts[index] == "quality-import"
        and delivery_parts[index + 1] == "assets"
        and re.fullmatch(
            r"[0-9a-f]{64}(?:\.(?:jpe?g|png|webp|gif|bmp|tiff?|avif|heic))?",
            delivery_parts[index + 2],
        )
        for index in range(max(0, len(delivery_parts) - 2))
    )
    if not legacy_quality_photo and not managed_import_asset:
        raise SourceValidationError("Cloudinary URL is outside the quality folder")
    return urllib.parse.urlunsplit(("https", CLOUDINARY_HOST, parsed.path, "", ""))


def _report_rows(payload: Mapping[str, Any], export_path: Path) -> list[dict[str, Any]]:
    if "results" in payload:
        if payload.get("next") or payload.get("previous"):
            raise SourceValidationError(
                f"quality report export is only one pagination slice: {export_path}"
            )
        rows = payload.get("results")
    else:
        rows = payload.get("reports")
    if not isinstance(rows, list):
        raise SourceValidationError(
            f"quality report export must contain a results or reports list: {export_path}"
        )
    if any(not isinstance(row, dict) for row in rows):
        raise SourceValidationError(f"quality report export contains a non-object row: {export_path}")
    count = payload.get("count")
    if "results" in payload and count is not None:
        if not isinstance(count, int) or isinstance(count, bool) or count != len(rows):
            raise SourceValidationError(
                f"quality report export count does not match included rows: {export_path}"
            )
    return rows


def normalize_aware_iso_datetime(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or value != value.strip() or not value:
        raise SourceValidationError(f"{field_name} must be an exact ISO-8601 string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise SourceValidationError(f"{field_name} must be valid ISO-8601") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise SourceValidationError(f"{field_name} must include a timezone")
    return iso_utc(parsed)


def quality_report_candidates(export_paths: Sequence[Path]) -> ArchivePlan:
    plan = ArchivePlan()
    seen_provenance: set[str] = set()
    if not export_paths:
        return plan
    for supplied_path in export_paths:
        export_path = _safe_resolved_source(supplied_path)
        payload, export_sha256 = read_json_object_with_sha256(export_path)
        rows = _report_rows(payload, export_path)
        plan.warnings.append(
            "QualityReport에는 승인 상태 필드가 없어 현재 export에 참조된 URL만 current 근거로 보관합니다."
        )
        for row in rows:
            report_id = row.get("id")
            if isinstance(report_id, bool) or not isinstance(report_id, (int, str)):
                raise SourceValidationError("every quality report row requires a stable id")
            report_id_text = str(report_id).strip()
            if not report_id_text:
                raise SourceValidationError("quality report id must not be empty")
            updated_at = normalize_aware_iso_datetime(
                row.get("updated_at"),
                f"quality report {report_id_text} updated_at",
            )
            for field_name in ("image1", "image2", "image3"):
                raw_url = row.get(field_name)
                if raw_url in (None, ""):
                    continue
                delivery_url = validate_cloudinary_quality_url(raw_url)
                source = {
                    "source_type": "quality_report_current_cloudinary_reference",
                    "source_system": "wj_reporting",
                    "source_entity": "quality.QualityReport",
                    "source_entity_id": report_id_text,
                    "source_field": field_name,
                    "source_updated_at": updated_at,
                    "selection_basis": "current_quality_report_reference",
                    "approval_state": "not_modeled_in_current_schema",
                    "delivery_url": delivery_url,
                    "export_path": str(export_path),
                    "export_sha256": export_sha256,
                }
                provenance_key = sha256_bytes(canonical_json_bytes(source))
                if provenance_key in seen_provenance:
                    continue
                seen_provenance.add(provenance_key)
                plan.candidates.append(
                    SourceCandidate(
                        kind="cloudinary_quality_photo",
                        label=f"quality_report:{report_id_text}:{field_name}",
                        source=source,
                        media_type_hint="image/unknown",
                        remote_url=delivery_url,
                        content_validation="image",
                    )
                )
    plan.warnings = list(dict.fromkeys(plan.warnings))
    return plan


def build_plan(
    *,
    report_exports: Sequence[Path] = (),
) -> ArchivePlan:
    report_plan = quality_report_candidates(report_exports)
    candidates = report_plan.candidates
    warnings = list(report_plan.warnings)
    identities: set[str] = set()
    unique_candidates: list[SourceCandidate] = []
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
        if identity not in identities:
            identities.add(identity)
            unique_candidates.append(candidate)
    return ArchivePlan(candidates=unique_candidates, warnings=warnings)


def dry_run_summary(plan: ArchivePlan, layout: ArchiveLayout) -> dict[str, Any]:
    validate_layout(layout, for_write=True)
    kinds: dict[str, int] = {}
    planned: list[dict[str, Any]] = []
    for candidate in plan.candidates:
        kinds[candidate.kind] = kinds.get(candidate.kind, 0) + 1
        planned.append(
            {
                "kind": candidate.kind,
                "source_label": candidate.label,
                "expected_sha256": candidate.expected_sha256,
                "expected_size": candidate.expected_size,
                "remote_downloaded": False,
            }
        )
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "dry_run",
        "dry_run": True,
        "archive_root": str(layout.root),
        "network_accessed": False,
        "filesystem_written": False,
        "candidate_count": len(plan.candidates),
        "candidate_kinds": kinds,
        "planned": planned,
        "warnings": plan.warnings,
    }


def _copy_stream_to_staging(
    stream: BinaryIO,
    staging: Path,
    *,
    max_bytes: int,
    media_type: str,
    retrieval: Mapping[str, Any] | None = None,
) -> StagedBlob:
    descriptor, temporary_name = tempfile.mkstemp(prefix="archive-", suffix=".part", dir=staging)
    temporary_path = Path(temporary_name)
    digest = hashlib.sha256()
    total = 0
    try:
        with os.fdopen(descriptor, "wb") as output:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise SourceValidationError(f"source exceeds byte limit ({max_bytes})")
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        if total <= 0:
            raise SourceValidationError("source content is empty")
        return StagedBlob(
            path=temporary_path,
            sha256=digest.hexdigest(),
            byte_size=total,
            media_type=media_type,
            retrieval=dict(retrieval or {}),
        )
    except Exception:
        if temporary_path.exists():
            temporary_path.unlink()
        raise


def _validate_image_content(path: Path) -> str:
    with path.open("rb") as handle:
        header = handle.read(32)
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if header.startswith(b"BM"):
        return "image/bmp"
    if header.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff"
    if header[4:8] == b"ftyp" and header[8:12] in {
        b"avif",
        b"avis",
        b"heic",
        b"heix",
        b"hevc",
        b"hevx",
        b"mif1",
        b"msf1",
    }:
        return "image/avif" if header[8:12] in {b"avif", b"avis"} else "image/heic"
    raise SourceValidationError("image content is not a supported format")


def validate_staged_content(candidate: SourceCandidate, staged: StagedBlob) -> StagedBlob:
    """Validate a staged blob against immutable metadata from its source API.

    This check deliberately lives below the transport layer so a custom/fake
    transport cannot bypass the checksum, size, or image signature contract.
    """

    if candidate.expected_sha256 and staged.sha256 != candidate.expected_sha256:
        staged.path.unlink(missing_ok=True)
        raise SourceValidationError("remote source checksum does not match server metadata")
    if candidate.expected_size is not None and staged.byte_size != candidate.expected_size:
        staged.path.unlink(missing_ok=True)
        raise SourceValidationError("remote source size does not match server metadata")
    if candidate.content_validation == "image":
        actual_type = _validate_image_content(staged.path)
        expected_type = candidate.media_type_hint.lower().split(";", 1)[0].strip()
        if expected_type not in {"", "image/unknown", "application/octet-stream"}:
            compatible = expected_type == actual_type or {
                expected_type,
                actual_type,
            } <= {"image/heic", "image/heif"}
            if not compatible:
                staged.path.unlink(missing_ok=True)
                raise SourceValidationError("image signature does not match server Content-Type")
        return StagedBlob(
            path=staged.path,
            sha256=staged.sha256,
            byte_size=staged.byte_size,
            media_type=actual_type,
            retrieval=staged.retrieval,
        )
    if candidate.content_validation != "none":
        staged.path.unlink(missing_ok=True)
        raise SourceValidationError("unsupported staged content validation contract")
    return staged


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def _require_public_cloudinary_dns() -> None:
    try:
        addresses = socket.getaddrinfo(CLOUDINARY_HOST, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise SourceValidationError("Cloudinary DNS resolution failed") from exc
    if not addresses:
        raise SourceValidationError("Cloudinary DNS returned no addresses")
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0].split("%", 1)[0])
        if not ip.is_global:
            raise SourceValidationError("Cloudinary hostname resolved to a non-public address")


def fetch_cloudinary_to_staging(candidate: SourceCandidate, staging: Path) -> StagedBlob:
    if not candidate.remote_url:
        raise SourceValidationError("remote candidate is missing its URL")
    delivery_url = validate_cloudinary_quality_url(candidate.remote_url)
    _require_public_cloudinary_dns()
    request = urllib.request.Request(
        delivery_url,
        headers={
            "Accept": "image/*",
            "User-Agent": "wj-quality-local-archive/1",
        },
        method="GET",
    )
    opener = urllib.request.build_opener(_NoRedirectHandler())
    try:
        with opener.open(request, timeout=30) as response:
            if getattr(response, "status", 200) != 200:
                raise SourceValidationError("Cloudinary returned a non-success status")
            response_url = validate_cloudinary_quality_url(response.geturl())
            if response_url != delivery_url:
                raise SourceValidationError("Cloudinary response URL changed unexpectedly")
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    declared_size = int(content_length)
                except ValueError as exc:
                    raise SourceValidationError("Cloudinary Content-Length is invalid") from exc
                if declared_size <= 0 or declared_size > MAX_REMOTE_IMAGE_BYTES:
                    raise SourceValidationError("Cloudinary image exceeds the byte limit")
            header_type = (response.headers.get_content_type() or "").lower()
            if not header_type.startswith("image/"):
                raise SourceValidationError("Cloudinary response Content-Type is not an image")
            staged = _copy_stream_to_staging(
                response,
                staging,
                max_bytes=MAX_REMOTE_IMAGE_BYTES,
                media_type=header_type,
                retrieval={
                    "http_etag": response.headers.get("ETag"),
                    "http_last_modified": response.headers.get("Last-Modified"),
                    "http_content_type": header_type,
                },
            )
    except urllib.error.HTTPError as exc:
        raise SourceValidationError(f"Cloudinary download failed with HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise SourceValidationError("Cloudinary download failed") from exc
    actual_type = _validate_image_content(staged.path)
    return StagedBlob(
        path=staged.path,
        sha256=staged.sha256,
        byte_size=staged.byte_size,
        media_type=actual_type,
        retrieval=staged.retrieval,
    )


def object_relative_path(sha256: str) -> Path:
    digest = ensure_lower_hex_sha256(sha256)
    return Path("objects") / "sha256" / digest[:2] / digest[2:4] / digest


def _hash_archive_object(path: Path, *, max_bytes: int) -> tuple[str, int]:
    if path.is_symlink() or not path.is_file():
        raise ArchiveIntegrityError(f"archive object is missing or unsafe: {path}")
    with path.open("rb") as handle:
        try:
            return _hash_binary_stream(handle, max_bytes=max_bytes)
        except SourceValidationError as exc:
            raise ArchiveIntegrityError(str(exc)) from exc


def _finalize_object(layout: ArchiveLayout, staged: StagedBlob) -> tuple[Path, str]:
    relative_path = object_relative_path(staged.sha256)
    destination = layout.root / relative_path
    _mkdir_chain(layout.mount_root, destination.parent)
    if destination.exists() or destination.is_symlink():
        existing_sha, existing_size = _hash_archive_object(
            destination,
            max_bytes=max(staged.byte_size, 1),
        )
        if existing_sha != staged.sha256 or existing_size != staged.byte_size:
            raise ArchiveIntegrityError("existing content-addressed object failed integrity verification")
        staged.path.unlink(missing_ok=True)
        return relative_path, "deduplicated"
    os.replace(staged.path, destination)
    _fsync_directory(destination.parent)
    written_sha, written_size = _hash_archive_object(
        destination,
        max_bytes=max(staged.byte_size, 1),
    )
    if written_sha != staged.sha256 or written_size != staged.byte_size:
        raise ArchiveIntegrityError("newly archived object failed post-write verification")
    return relative_path, "archived"


def event_identity(kind: str, sha256: str, source: Mapping[str, Any]) -> str:
    return sha256_bytes(
        canonical_json_bytes(
            {
                "kind": kind,
                "sha256": sha256,
                "source": source,
            }
        )
    )


def event_manifest_sha256(event: Mapping[str, Any]) -> str:
    payload = dict(event)
    payload.pop("manifest_sha256", None)
    return sha256_bytes(canonical_json_bytes(payload))


def _event_manifest_path(layout: ArchiveLayout, event_id: str) -> Path:
    digest = ensure_lower_hex_sha256(event_id, "event_id")
    return layout.item_manifests / digest[:2] / f"{digest}.json"


def _record_event_manifest(layout: ArchiveLayout, event: Mapping[str, Any]) -> str:
    event_id = ensure_lower_hex_sha256(event.get("event_id"), "event_id")
    path = _event_manifest_path(layout, event_id)
    _mkdir_chain(layout.mount_root, path.parent)
    if path.exists() or path.is_symlink():
        if path.is_symlink():
            raise ArchiveIntegrityError("event manifest symlink is not allowed")
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ArchiveIntegrityError("existing event manifest is unreadable") from exc
        if existing.get("manifest_sha256") != event_manifest_sha256(existing):
            raise ArchiveIntegrityError("existing event manifest self-check failed")
        stable_fields = (
            "schema_version",
            "event_id",
            "kind",
            "sha256",
            "byte_size",
            "media_type",
            "object_relative_path",
            "source",
        )
        if any(existing.get(field) != event.get(field) for field in stable_fields):
            raise ArchiveIntegrityError("existing event manifest conflicts with the new event")
        return "existing"
    atomic_write_json(path, event)
    return "created"


def _write_run_manifest(
    layout: ArchiveLayout,
    *,
    run_id: str,
    started_at: str,
    finished_at: str,
    records: Sequence[Mapping[str, Any]],
    warnings: Sequence[str],
    recovered_staging_files: int,
) -> Path:
    manifest_path = layout.run_manifests / f"{run_id}.jsonl"
    lines: list[bytes] = [
        canonical_json_bytes(
            {
                "record_type": "run_header",
                "schema_version": SCHEMA_VERSION,
                "run_id": run_id,
                "started_at": started_at,
                "archive_root": str(layout.root),
                "dry_run": False,
                "recovered_staging_files": recovered_staging_files,
            }
        )
    ]
    lines.extend(canonical_json_bytes(record) for record in records)
    failures = sum(1 for record in records if record.get("status") == "failed")
    records_sha256 = sha256_bytes(b"\n".join(lines) + b"\n")
    lines.append(
        canonical_json_bytes(
            {
                "record_type": "run_footer",
                "schema_version": SCHEMA_VERSION,
                "run_id": run_id,
                "finished_at": finished_at,
                "record_count": len(records),
                "failure_count": failures,
                "records_sha256": records_sha256,
                "warnings": list(warnings),
            }
        )
    )
    atomic_write_bytes(manifest_path, b"\n".join(lines) + b"\n")
    return manifest_path


def recover_interrupted_staging(layout: ArchiveLayout) -> int:
    """Remove only this tool's incomplete same-volume temp files under lock."""

    _require_real_directory(layout.staging, label="archive staging directory")
    recovered = 0
    for path in layout.staging.iterdir():
        if path.is_symlink() or not path.is_file():
            raise ArchiveIntegrityError(f"unexpected unsafe entry in archive staging: {path.name}")
        if not (path.name.startswith("archive-") and path.name.endswith(".part")):
            raise ArchiveIntegrityError(f"unexpected file in archive staging: {path.name}")
        path.unlink()
        recovered += 1
    if recovered:
        _fsync_directory(layout.staging)
    return recovered


def apply_plan(
    plan: ArchivePlan,
    layout: ArchiveLayout,
    *,
    remote_fetcher: RemoteFetcher = fetch_cloudinary_to_staging,
    now: datetime | None = None,
) -> dict[str, Any]:
    initialize_layout(layout)
    started = (now or utc_now()).astimezone(timezone.utc)
    run_id = f"{started.strftime('%Y%m%dT%H%M%S.%fZ')}-{uuid.uuid4().hex[:12]}"
    records: list[dict[str, Any]] = []
    with archive_lock(layout, exclusive=True, create=True):
        recovered_staging_files = recover_interrupted_staging(layout)
        for candidate in plan.candidates:
            staged: StagedBlob | None = None
            try:
                if not candidate.remote_url:
                    raise SourceValidationError("archive candidates must use an approved remote image URL")
                staged = remote_fetcher(candidate, layout.staging)
                staged = validate_staged_content(candidate, staged)
                staged_retrieval = dict(staged.retrieval)
                staged_media_type = staged.media_type
                relative_path, object_status = _finalize_object(layout, staged)
                staged = None
                event_id = event_identity(candidate.kind, relative_path.name, candidate.source)
                archived_at = iso_utc(utc_now())
                event = {
                    "schema_version": SCHEMA_VERSION,
                    "event_id": event_id,
                    "kind": candidate.kind,
                    "sha256": relative_path.name,
                    "byte_size": candidate.expected_size
                    if candidate.expected_size is not None
                    else (layout.root / relative_path).stat().st_size,
                    "media_type": (
                        staged_media_type
                        if staged_media_type
                        else candidate.media_type_hint
                    ),
                    "object_relative_path": relative_path.as_posix(),
                    "source": dict(candidate.source),
                    "retrieval": staged_retrieval,
                    "archived_at": archived_at,
                }
                # ``staged`` is deliberately cleared after finalize; recover the
                # authoritative object size and media type from the immutable object.
                event["byte_size"] = (layout.root / relative_path).stat().st_size
                if candidate.content_validation == "image":
                    event["media_type"] = _validate_image_content(layout.root / relative_path)
                event["manifest_sha256"] = event_manifest_sha256(event)
                manifest_status = _record_event_manifest(layout, event)
                records.append(
                    {
                        "record_type": "archive_item",
                        "schema_version": SCHEMA_VERSION,
                        "run_id": run_id,
                        "source_label": candidate.label,
                        "kind": candidate.kind,
                        "status": object_status,
                        "event_manifest_status": manifest_status,
                        "event_id": event_id,
                        "sha256": relative_path.name,
                        "byte_size": event["byte_size"],
                        "object_relative_path": relative_path.as_posix(),
                    }
                )
            except DriveUnavailable:
                if staged is not None and staged.path.exists():
                    staged.path.unlink()
                raise
            except (ArchiveError, OSError) as exc:
                if staged is not None and staged.path.exists():
                    staged.path.unlink()
                records.append(
                    {
                        "record_type": "archive_item",
                        "schema_version": SCHEMA_VERSION,
                        "run_id": run_id,
                        "source_label": candidate.label,
                        "kind": candidate.kind,
                        "status": "failed",
                        "error_type": type(exc).__name__,
                        "error": str(exc),
                    }
                )

        finished = utc_now()
        run_manifest = _write_run_manifest(
            layout,
            run_id=run_id,
            started_at=iso_utc(started),
            finished_at=iso_utc(finished),
            records=records,
            warnings=plan.warnings,
            recovered_staging_files=recovered_staging_files,
        )

    failures = [record for record in records if record.get("status") == "failed"]
    archived = sum(1 for record in records if record.get("status") == "archived")
    deduplicated = sum(1 for record in records if record.get("status") == "deduplicated")
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok" if not failures else "partial_failure",
        "dry_run": False,
        "archive_root": str(layout.root),
        "run_id": run_id,
        "run_manifest": str(run_manifest.relative_to(layout.root)),
        "candidate_count": len(plan.candidates),
        "archived_count": archived,
        "deduplicated_count": deduplicated,
        "failure_count": len(failures),
        "recovered_staging_files": recovered_staging_files,
        "failures": [
            {
                "source_label": record["source_label"],
                "error_type": record["error_type"],
                "error": record["error"],
            }
            for record in failures
        ],
        "items": [
            {
                "source_label": record["source_label"],
                "kind": record["kind"],
                "status": record["status"],
                "sha256": record["sha256"],
                "byte_size": record["byte_size"],
                "object_relative_path": record["object_relative_path"],
            }
            for record in records
            if record.get("status") in {"archived", "deduplicated"}
        ],
        "warnings": plan.warnings,
    }


def _is_platform_metadata(name: str) -> bool:
    """Return True for metadata sidecars created by macOS on non-APFS volumes."""

    return name == ".DS_Store" or name.startswith("._")


def _walk_regular_files(root: Path, *, suffix: str | None = None) -> list[Path]:
    if root.is_symlink() or not root.is_dir():
        raise ArchiveIntegrityError(f"archive directory is missing or unsafe: {root}")
    files: list[Path] = []
    for directory, directory_names, file_names in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        directory_names[:] = [
            name for name in directory_names if not _is_platform_metadata(name)
        ]
        for name in list(directory_names):
            child = directory_path / name
            if child.is_symlink():
                raise ArchiveIntegrityError(f"archive directory symlink is not allowed: {child}")
        for name in file_names:
            if _is_platform_metadata(name):
                continue
            child = directory_path / name
            if child.is_symlink() or not child.is_file():
                raise ArchiveIntegrityError(f"archive file is unsafe: {child}")
            if suffix is None or child.name.endswith(suffix):
                files.append(child)
    return sorted(files)


def _read_event_manifest(path: Path, layout: ArchiveLayout) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ArchiveIntegrityError(f"event manifest is unreadable: {path}") from exc
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        raise ArchiveIntegrityError(f"event manifest schema is invalid: {path}")
    if payload.get("manifest_sha256") != event_manifest_sha256(payload):
        raise ArchiveIntegrityError(f"event manifest self-check failed: {path}")
    event_id = ensure_lower_hex_sha256(payload.get("event_id"), "event_id")
    sha256 = ensure_lower_hex_sha256(payload.get("sha256"))
    if path.stem != event_id or path.parent.name != event_id[:2]:
        raise ArchiveIntegrityError(f"event manifest path does not match event_id: {path}")
    source = payload.get("source")
    kind = payload.get("kind")
    if not isinstance(source, dict) or not isinstance(kind, str) or not kind:
        raise ArchiveIntegrityError(f"event provenance is incomplete: {path}")
    if event_identity(kind, sha256, source) != event_id:
        raise ArchiveIntegrityError(f"event_id does not match provenance: {path}")
    byte_size = payload.get("byte_size")
    if not isinstance(byte_size, int) or isinstance(byte_size, bool) or byte_size <= 0:
        raise ArchiveIntegrityError(f"event byte_size is invalid: {path}")
    expected_relative = object_relative_path(sha256).as_posix()
    if payload.get("object_relative_path") != expected_relative:
        raise ArchiveIntegrityError(f"event object path is not content-addressed: {path}")
    return payload


def find_existing_archived_candidates(
    layout: ArchiveLayout,
    candidates: Sequence[SourceCandidate],
) -> dict[str, dict[str, Any]]:
    """Resolve exact, locally verified source revisions without a remote download."""

    if not candidates or not layout.root.exists():
        return {}
    validate_layout(layout, for_write=False, root_must_exist=True)
    candidates_by_source: dict[str, SourceCandidate] = {
        sha256_bytes(
            canonical_json_bytes({"kind": candidate.kind, "source": candidate.source})
        ): candidate
        for candidate in candidates
    }
    matches: dict[str, dict[str, Any]] = {}
    seen_sources: dict[str, str] = {}
    with archive_lock(layout, exclusive=False, create=False):
        for manifest_path in _walk_regular_files(layout.item_manifests, suffix=".json"):
            event = _read_event_manifest(manifest_path, layout)
            source_identity = sha256_bytes(
                canonical_json_bytes({"kind": event["kind"], "source": event["source"]})
            )
            candidate = candidates_by_source.get(source_identity)
            if candidate is None:
                continue
            sha = ensure_lower_hex_sha256(event.get("sha256"))
            if candidate.expected_sha256 is not None and candidate.expected_sha256 != sha:
                continue
            previous_sha = seen_sources.get(source_identity)
            if previous_sha is not None and previous_sha != sha:
                raise ArchiveIntegrityError(
                    "the same archive source revision points to conflicting content"
                )
            object_path = layout.root / object_relative_path(sha)
            actual_sha, actual_size = _hash_archive_object(
                object_path,
                max_bytes=MAX_REMOTE_IMAGE_BYTES,
            )
            if actual_sha != sha or actual_size != event.get("byte_size"):
                raise ArchiveIntegrityError(
                    "an existing source revision failed local object verification"
                )
            if candidate.expected_size is not None and candidate.expected_size != actual_size:
                continue
            seen_sources[source_identity] = sha
            matches[candidate.label] = {
                "source_label": candidate.label,
                "kind": candidate.kind,
                "status": "already_archived",
                "sha256": sha,
                "byte_size": actual_size,
                "object_relative_path": object_relative_path(sha).as_posix(),
            }
    return matches


def _verify_run_manifests(layout: ArchiveLayout, event_ids: set[str]) -> list[str]:
    errors: list[str] = []
    for path in _walk_regular_files(layout.run_manifests, suffix=".jsonl"):
        try:
            raw_lines = path.read_bytes().splitlines()
            if any(not line for line in raw_lines):
                raise ValueError("blank run manifest line")
            rows = [json.loads(line) for line in raw_lines]
            if len(rows) < 2 or rows[0].get("record_type") != "run_header":
                raise ValueError("missing run header")
            if rows[-1].get("record_type") != "run_footer":
                raise ValueError("missing run footer")
            run_id = rows[0].get("run_id")
            if path.stem != run_id or rows[-1].get("run_id") != run_id:
                raise ValueError("run_id mismatch")
            expected_records_sha256 = sha256_bytes(b"\n".join(raw_lines[:-1]) + b"\n")
            if rows[-1].get("records_sha256") != expected_records_sha256:
                raise ValueError("run manifest self-check failed")
            if rows[-1].get("record_count") != len(rows) - 2:
                raise ValueError("run record_count mismatch")
            actual_failures = sum(1 for row in rows[1:-1] if row.get("status") == "failed")
            if rows[-1].get("failure_count") != actual_failures:
                raise ValueError("run failure_count mismatch")
            for row in rows[1:-1]:
                if row.get("status") in {"archived", "deduplicated"}:
                    event_id = row.get("event_id")
                    if event_id not in event_ids:
                        raise ValueError("run references a missing event manifest")
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, AttributeError) as exc:
            errors.append(f"run_manifest_invalid:{path.name}:{exc}")
    return errors


def verify_archive(layout: ArchiveLayout) -> dict[str, Any]:
    validate_layout(layout, for_write=False, root_must_exist=True)
    errors: list[str] = []
    checked_objects: dict[str, int] = {}
    event_ids: set[str] = set()
    referenced_paths: set[str] = set()
    with archive_lock(layout, exclusive=False, create=False):
        try:
            event_paths = _walk_regular_files(layout.item_manifests, suffix=".json")
        except ArchiveIntegrityError as exc:
            event_paths = []
            errors.append(str(exc))
        for event_path in event_paths:
            try:
                event = _read_event_manifest(event_path, layout)
                event_id = event["event_id"]
                event_ids.add(event_id)
                relative_path = event["object_relative_path"]
                referenced_paths.add(relative_path)
                if relative_path not in checked_objects:
                    object_path = layout.root / relative_path
                    object_sha, object_size = _hash_archive_object(
                        object_path,
                        max_bytes=max(int(event["byte_size"]), 1),
                    )
                    if object_sha != event["sha256"] or object_size != event["byte_size"]:
                        raise ArchiveIntegrityError(
                            f"object hash or size mismatch: {relative_path}"
                        )
                    checked_objects[relative_path] = object_size
                elif checked_objects[relative_path] != event["byte_size"]:
                    raise ArchiveIntegrityError(
                        f"event manifests disagree on object size: {relative_path}"
                    )
            except ArchiveIntegrityError as exc:
                errors.append(str(exc))

        try:
            object_files = _walk_regular_files(layout.objects)
            for object_file in object_files:
                relative = object_file.relative_to(layout.root).as_posix()
                if relative not in referenced_paths:
                    errors.append(f"orphan_object:{relative}")
        except ArchiveIntegrityError as exc:
            errors.append(str(exc))
        errors.extend(_verify_run_manifests(layout, event_ids))

    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ok" if not errors else "integrity_error",
        "archive_root": str(layout.root),
        "event_manifest_count": len(event_ids),
        "verified_object_count": len(checked_objects),
        "error_count": len(errors),
        "errors": errors,
        "verified_at": iso_utc(utc_now()),
    }


def drive_status(layout: ArchiveLayout) -> dict[str, Any]:
    try:
        validate_layout(layout, for_write=True)
    except DriveUnavailable as exc:
        return {
            "schema_version": SCHEMA_VERSION,
            "status": "drive_unavailable",
            "ready": False,
            "archive_root": str(layout.root),
            "message": str(exc),
        }
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "ready",
        "ready": True,
        "archive_root": str(layout.root),
        "mount_root": str(layout.mount_root),
        "root_exists": layout.root.exists(),
        "message": "Ted_SSD is mounted and writable; archive apply remains explicit.",
    }
