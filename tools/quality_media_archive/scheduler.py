#!/usr/bin/env python3
"""Daily, Keychain-backed quality media archive runner for macOS launchd."""

from __future__ import annotations

import argparse
import ctypes
import fcntl
import getpass
import json
import os
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence


TOOL_DIR = Path(__file__).resolve().parent
if str(TOOL_DIR) not in sys.path:
    sys.path.insert(0, str(TOOL_DIR))

from api_sync import (  # noqa: E402
    AuthenticatedApiTransport,
    validate_api_base_url,
    run_api_sync,
)
from archive_core import ArchiveError, ArchiveLayout, SourceValidationError  # noqa: E402


DEFAULT_API_BASE_URL = "https://wj-reporting.onrender.com"
API_BASE_URL_ENV = "WJ_QUALITY_ARCHIVE_API_BASE_URL"
KEYCHAIN_SERVICE_ENV = "WJ_QUALITY_ARCHIVE_KEYCHAIN_SERVICE"
KEYCHAIN_ACCOUNT_ENV = "WJ_QUALITY_ARCHIVE_KEYCHAIN_ACCOUNT"
DEFAULT_KEYCHAIN_SERVICE = "com.wj.quality-media-archive.refresh-token"
MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
HTTP_TIMEOUT_SECONDS = 30
ERR_SEC_ITEM_NOT_FOUND = -25300
SCHEDULER_STATE_DIR = Path.home() / "Library/Application Support/WJ/quality-media-archive/state"


_SECURITY = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
_CORE_FOUNDATION = ctypes.CDLL(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
)
_SECURITY.SecKeychainFindGenericPassword.restype = ctypes.c_int32
_SECURITY.SecKeychainFindGenericPassword.argtypes = [
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_char_p,
    ctypes.c_uint32,
    ctypes.c_char_p,
    ctypes.POINTER(ctypes.c_uint32),
    ctypes.POINTER(ctypes.c_void_p),
    ctypes.POINTER(ctypes.c_void_p),
]
_SECURITY.SecKeychainAddGenericPassword.restype = ctypes.c_int32
_SECURITY.SecKeychainAddGenericPassword.argtypes = [
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_char_p,
    ctypes.c_uint32,
    ctypes.c_char_p,
    ctypes.c_uint32,
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_void_p),
]
_SECURITY.SecKeychainItemModifyAttributesAndData.restype = ctypes.c_int32
_SECURITY.SecKeychainItemModifyAttributesAndData.argtypes = [
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_void_p,
]
_SECURITY.SecKeychainItemFreeContent.restype = ctypes.c_int32
_SECURITY.SecKeychainItemFreeContent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
_CORE_FOUNDATION.CFRelease.argtypes = [ctypes.c_void_p]


class SchedulerError(RuntimeError):
    """An operator-safe scheduler error that never contains credential values."""


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise SchedulerError("authentication endpoint attempted an unexpected redirect")


def keychain_identity(environ: Mapping[str, str] | None = None) -> tuple[str, str]:
    values = environ if environ is not None else os.environ
    service = values.get(KEYCHAIN_SERVICE_ENV, DEFAULT_KEYCHAIN_SERVICE).strip()
    account = values.get(KEYCHAIN_ACCOUNT_ENV, getpass.getuser()).strip()
    if not service or not account or any(character.isspace() for character in service):
        raise SchedulerError("quality archive Keychain service/account configuration is invalid")
    return service, account


def api_base_url(environ: Mapping[str, str] | None = None) -> str:
    values = environ if environ is not None else os.environ
    return validate_api_base_url(values.get(API_BASE_URL_ENV, DEFAULT_API_BASE_URL))


def _keychain_find_refresh_token(*, service: str, account: str) -> tuple[int, str, int]:
    service_bytes = service.encode("utf-8")
    account_bytes = account.encode("utf-8")
    password_length = ctypes.c_uint32()
    password_data = ctypes.c_void_p()
    item_ref = ctypes.c_void_p()
    status = int(
        _SECURITY.SecKeychainFindGenericPassword(
            None,
            len(service_bytes),
            service_bytes,
            len(account_bytes),
            account_bytes,
            ctypes.byref(password_length),
            ctypes.byref(password_data),
            ctypes.byref(item_ref),
        )
    )
    if status != 0:
        if password_data.value:
            _SECURITY.SecKeychainItemFreeContent(None, password_data)
        if item_ref.value:
            _CORE_FOUNDATION.CFRelease(item_ref)
        return status, "", 0
    try:
        raw = ctypes.string_at(password_data, password_length.value)
        token = raw.decode("utf-8")
    except (UnicodeDecodeError, ValueError) as exc:
        if item_ref.value:
            _CORE_FOUNDATION.CFRelease(item_ref)
        raise SchedulerError("the Keychain refresh credential is invalid") from exc
    finally:
        if password_data.value:
            _SECURITY.SecKeychainItemFreeContent(None, password_data)
    return status, token, int(item_ref.value or 0)


def keychain_has_refresh_token(*, service: str, account: str) -> bool:
    status, _token, item_ref = _keychain_find_refresh_token(service=service, account=account)
    if item_ref:
        _CORE_FOUNDATION.CFRelease(ctypes.c_void_p(item_ref))
    return status == 0


def keychain_read_refresh_token(*, service: str, account: str) -> str:
    status, token, item_ref = _keychain_find_refresh_token(service=service, account=account)
    if item_ref:
        _CORE_FOUNDATION.CFRelease(ctypes.c_void_p(item_ref))
    token = token.strip() if status == 0 else ""
    if not token or any(character.isspace() for character in token):
        raise SchedulerError(
            "quality archive refresh credential is missing; run scheduler.py configure"
        )
    return token


def keychain_store_refresh_token(token: str, *, service: str, account: str) -> None:
    if not token or any(character.isspace() for character in token):
        raise SchedulerError("authentication server returned an invalid refresh credential")
    service_bytes = service.encode("utf-8")
    account_bytes = account.encode("utf-8")
    token_bytes = token.encode("utf-8")
    status, _current, item_ref = _keychain_find_refresh_token(
        service=service,
        account=account,
    )
    token_buffer = ctypes.create_string_buffer(token_bytes)
    if status == 0 and item_ref:
        try:
            write_status = int(
                _SECURITY.SecKeychainItemModifyAttributesAndData(
                    ctypes.c_void_p(item_ref),
                    None,
                    len(token_bytes),
                    ctypes.cast(token_buffer, ctypes.c_void_p),
                )
            )
        finally:
            _CORE_FOUNDATION.CFRelease(ctypes.c_void_p(item_ref))
    elif status == ERR_SEC_ITEM_NOT_FOUND:
        write_status = int(
            _SECURITY.SecKeychainAddGenericPassword(
                None,
                len(service_bytes),
                service_bytes,
                len(account_bytes),
                account_bytes,
                len(token_bytes),
                ctypes.cast(token_buffer, ctypes.c_void_p),
                None,
            )
        )
    else:
        write_status = status
    if write_status != 0:
        raise SchedulerError("the rotated refresh credential could not be stored in macOS Keychain")


@contextmanager
def scheduler_lock() -> Iterator[None]:
    """Prevent manual and launchd runs from rotating the same refresh token concurrently."""
    SCHEDULER_STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory_stat = SCHEDULER_STATE_DIR.stat()
    if (
        not stat.S_ISDIR(directory_stat.st_mode)
        or directory_stat.st_uid != os.getuid()
        or directory_stat.st_mode & 0o077
    ):
        raise SchedulerError("quality archive scheduler state directory is not private")
    lock_path = SCHEDULER_STATE_DIR / "scheduler.lock"
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(lock_path, flags, 0o600)
    try:
        lock_stat = os.fstat(descriptor)
        if (
            not stat.S_ISREG(lock_stat.st_mode)
            or lock_stat.st_uid != os.getuid()
            or lock_stat.st_mode & 0o077
        ):
            raise SchedulerError("quality archive scheduler lock is not private")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise SchedulerError("another quality archive sync is already running") from exc
        try:
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def _token_endpoint(base_url: str, suffix: str) -> str:
    base = urllib.parse.urlsplit(base_url)
    path = f"/api/token/{suffix}"
    return urllib.parse.urlunsplit(("https", base.hostname or "", path, "", ""))


def request_token_pair(
    base_url: str,
    *,
    payload: Mapping[str, str],
    endpoint_suffix: str,
    opener: Any | None = None,
) -> dict[str, str]:
    body = json.dumps(dict(payload), separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        _token_endpoint(base_url, endpoint_suffix),
        data=body,
        method="POST",
        headers={"Accept": "application/json", "Content-Type": "application/json"},
    )
    client = opener or urllib.request.build_opener(_NoRedirectHandler())
    try:
        with client.open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                raise SchedulerError("authentication server returned an unexpected status")
            raw = response.read(MAX_TOKEN_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        if exc.code in {400, 401, 403}:
            raise SchedulerError("quality archive sign-in or refresh credential was rejected") from exc
        raise SchedulerError("quality archive authentication service is temporarily unavailable") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SchedulerError("quality archive authentication service could not be reached") from exc
    if len(raw) > MAX_TOKEN_RESPONSE_BYTES:
        raise SchedulerError("authentication response exceeded the safe size limit")
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SchedulerError("authentication server returned an invalid response") from exc
    if not isinstance(decoded, dict):
        raise SchedulerError("authentication server returned an invalid response")
    access = decoded.get("access")
    refresh = decoded.get("refresh")
    if not isinstance(access, str) or not access or any(c.isspace() for c in access):
        raise SchedulerError("authentication response did not include a valid access credential")
    if not isinstance(refresh, str) or not refresh or any(c.isspace() for c in refresh):
        raise SchedulerError("authentication response did not include the required rotated refresh credential")
    return {"access": access, "refresh": refresh}


def configure(*, username: str | None = None) -> dict[str, Any]:
    base_url = api_base_url()
    service, account = keychain_identity()
    login_name = (username or input("WJ Reporting username: ")).strip()
    if not login_name:
        raise SchedulerError("username is required")
    password = getpass.getpass("WJ Reporting password (not stored): ")
    if not password:
        raise SchedulerError("password is required")
    try:
        pair = request_token_pair(
            base_url,
            payload={"username": login_name, "password": password},
            endpoint_suffix="",
        )
    finally:
        password = ""
    keychain_store_refresh_token(pair["refresh"], service=service, account=account)
    return {
        "status": "configured",
        "api_origin": base_url,
        "keychain_service": service,
        "keychain_account": account,
        "password_stored": False,
        "refresh_credential_stored": True,
    }


def _rotate_access_token(*, base_url: str, service: str, account: str) -> str:
    refresh = keychain_read_refresh_token(service=service, account=account)
    pair = request_token_pair(
        base_url,
        payload={"refresh": refresh},
        endpoint_suffix="refresh/",
    )
    # SimpleJWT rotates and blacklists refresh tokens. Persist the replacement
    # before returning the short-lived access token to archive network work.
    keychain_store_refresh_token(pair["refresh"], service=service, account=account)
    return pair["access"]


def sync_once() -> dict[str, Any]:
    base_url = api_base_url()
    service, account = keychain_identity()
    with scheduler_lock():
        access = _rotate_access_token(
            base_url=base_url,
            service=service,
            account=account,
        )
        result = run_api_sync(
            ArchiveLayout(),
            base_url=base_url,
            transport=AuthenticatedApiTransport(
                base_url,
                access,
                refresh_access_token=lambda: _rotate_access_token(
                    base_url=base_url,
                    service=service,
                    account=account,
                ),
            ),
        )
    return {
        **result,
        "schedule": "daily",
        "credential_rotation": "completed",
    }


def status() -> dict[str, Any]:
    service, account = keychain_identity()
    layout = ArchiveLayout()
    mount_ready = layout.mount_root.is_dir() and os.access(layout.mount_root, os.R_OK | os.W_OK)
    return {
        "status": "ready" if mount_ready and keychain_has_refresh_token(service=service, account=account) else "setup_required",
        "api_origin": api_base_url(),
        "archive_root": str(layout.root),
        "mount_ready": mount_ready,
        "keychain_service": service,
        "keychain_account": account,
        "refresh_credential_present": keychain_has_refresh_token(service=service, account=account),
        "schedule": "daily at 23:30 local time",
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage the daily Ted_SSD quality archive sync")
    subparsers = parser.add_subparsers(dest="command", required=True)
    configure_parser = subparsers.add_parser("configure", help="sign in once and store only a rotating refresh credential in Keychain")
    configure_parser.add_argument("--username", help="WJ Reporting username; password is always prompted securely")
    subparsers.add_parser("sync", help="rotate the Keychain refresh credential and run one archive sync")
    subparsers.add_parser("status", help="show non-secret scheduler readiness")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "configure":
            result = configure(username=args.username)
        elif args.command == "sync":
            result = sync_once()
        else:
            result = status()
    except (SchedulerError, ArchiveError, SourceValidationError, OSError) as exc:
        result = {"status": "error", "error_type": type(exc).__name__, "message": str(exc)}
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if result.get("status") in {"ok", "ready", "configured"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
