"""Bounded field protocol HTTP transport. No proxy discovery or redirects."""

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.client import HTTPException
import ipaddress
import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .protocol import MAX_BODY

TRANSIENT_HTTP = {408, 425, 429}
_PUBLIC_ERRORS = {
    "batch_conflict", "contract_unsupported", "event_conflict", "invalid_payload",
    "invalid_token", "payload_too_large", "station_denied", "unsupported_media_type",
}


class DeliveryError(Exception):
    """A bounded, display-safe reason and its retry policy."""

    def __init__(self, code, retryable=False, retry_after=0.0):
        self.code = code
        self.retryable = retryable
        self.retry_after = retry_after
        super().__init__(code)


def normalize_server_url(value):
    """Canonical origin. Cleartext is permitted for explicit loopback fixtures."""
    invalid = "Use an uncredentialed HTTPS server origin or a loopback HTTP origin."
    if not isinstance(value, str) or not value or any(ord(char) <= 32 or ord(char) == 127 for char in value):
        raise ValueError(invalid)
    try:
        parts = urlsplit(value)
        port = parts.port
        host = parts.hostname
    except ValueError:
        raise ValueError(invalid) from None
    if (parts.scheme not in ("http", "https") or not host or port == 0
            or parts.username is not None or parts.password is not None
            or "?" in value or "#" in value or parts.path not in ("", "/", "/api", "/api/")
            or "%" in host or "\\" in host):
        raise ValueError(invalid)

    if host == "localhost":
        # Resolve plain localhost literally so a hosts entry cannot redirect test traffic.
        if parts.scheme == "http":
            host = "127.0.0.1"
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if parts.scheme == "http":
            raise ValueError(invalid) from None
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            raise ValueError(invalid) from None
        if not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,252})", host):
            raise ValueError(invalid) from None
    else:
        if parts.scheme == "http" and not address.is_loopback:
            raise ValueError(invalid)
        host = "[{}]".format(address) if address.version == 6 else str(address)

    authority = host if port is None else "{}:{}".format(host, port)
    return "{}://{}".format(parts.scheme, authority)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def retry_after_seconds(value, now):
    if not value:
        return 0.0
    value = value.strip()
    if re.fullmatch(r"[0-9]+", value):
        return float(value)
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0.0, (parsed - now).total_seconds())
    except (ValueError, TypeError, OverflowError):
        return 0.0


def _unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate keys")
    return result


def _no_constants(value):
    raise ValueError("invalid JSON constant")


def _json_response(response):
    if response.headers.get_content_type() != "application/json":
        raise DeliveryError("invalid_ack")
    body = response.read(MAX_BODY + 1)
    if len(body) > MAX_BODY:
        raise DeliveryError("response_too_large")
    try:
        value = json.loads(body.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_no_constants)
    except (ValueError, RecursionError):
        raise DeliveryError("invalid_ack") from None
    if not isinstance(value, dict):
        raise DeliveryError("invalid_ack")
    return value


class Transport:
    def __init__(self, base_url, token, *, timeout=8, now=None):
        self.base_url = normalize_server_url(base_url)
        if not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{32}\.[A-Za-z0-9_-]{43}", token, re.ASCII):
            raise ValueError("Invalid field device credential format.")
        self._authorization = "WJField " + token
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())
        self._timeout = timeout
        self._now = now or (lambda: datetime.now(timezone.utc))

    def post(self, route, body):
        if route not in ("ingest", "heartbeat"):
            raise ValueError("Unknown field device route.")
        if not isinstance(body, bytes) or not 0 < len(body) <= MAX_BODY:
            raise DeliveryError("local_payload_size")
        request = Request(
            "{}/api/field/v1/{}/".format(self.base_url, route),
            data=body,
            headers={
                "Authorization": self._authorization,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                if response.status != 200:
                    raise DeliveryError("unexpected_http_status")
                return _json_response(response)
        except HTTPError as error:
            with error:
                status = error.code
                if 300 <= status < 400:
                    raise DeliveryError("redirect_refused") from None
                transient = status in TRANSIENT_HTTP or 500 <= status < 600
                delay = retry_after_seconds(error.headers.get("Retry-After"), self._now()) if transient else 0.0
                code = "http_{}".format(status)
                if 400 <= status < 500 and not transient:
                    try:
                        remote = _json_response(error).get("code")
                    except (DeliveryError, OSError, HTTPException):
                        remote = None
                    if isinstance(remote, str) and remote in _PUBLIC_ERRORS:
                        code = remote
                raise DeliveryError(code, transient, delay) from None
        except (URLError, OSError, HTTPException):
            raise DeliveryError("network_error", retryable=True) from None
