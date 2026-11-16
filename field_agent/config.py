"""Install-only connection configuration and a single local runtime owner."""

from contextlib import contextmanager
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from threading import Lock
from uuid import uuid4

from .protocol import STATION_ID, encode
from .transport import normalize_server_url


TOKEN = re.compile(r"[0-9a-f]{32}\.[A-Za-z0-9_-]{43}", re.ASCII)
TOKEN_FILE = re.compile(r"token-[0-9a-f]{32}\.txt", re.ASCII)
CONFIG = "connection.json"
LANGUAGES = ("ko", "zh")
UI_PREFERENCES = "ui-preferences.json"


@dataclass(frozen=True)
class Connection:
    server: str
    station_id: str
    token: str = field(repr=False)


def _limited_read(path, maximum):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("Use a regular local configuration file")
    with path.open("rb") as handle:
        value = handle.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError("Configuration file is too large")
    return value


def _validate(server, station_id, token):
    if not isinstance(station_id, str) or not STATION_ID.fullmatch(station_id):
        raise ValueError("Invalid station ID")
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError("Invalid device token format")
    return Connection(normalize_server_url(server), station_id, token)


def _atomic_file(path, body):
    with NamedTemporaryFile(prefix=".field-", dir=path.parent, delete=False) as handle:
        stage = Path(handle.name)
    try:
        with stage.open("wb") as handle:
            handle.write(body)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(stage, path)
    finally:
        stage.unlink(missing_ok=True)


def _validate_language(language):
    if not isinstance(language, str) or language not in LANGUAGES:
        raise ValueError("Invalid local language preference")
    return language


class LanguagePreferences:
    """PC-scoped display settings saved independently of connection credentials."""

    def __init__(self, root):
        self.path = Path(root) / UI_PREFERENCES
        self.lock = Lock()
        self.language = "ko"
        self.persisted = False
        try:
            stored = json.loads(_limited_read(self.path, 256).decode("utf-8"))
            if not isinstance(stored, dict) or set(stored) != {"language"}:
                return
            self.language = _validate_language(stored["language"])
            self.persisted = True
        except (OSError, ValueError):
            # Local display settings cannot hold up the device and sender loops.
            pass

    def get(self):
        with self.lock:
            return self.language

    def set(self, language):
        _validate_language(language)
        with self.lock:
            if language != self.language or not self.persisted or not self.path.exists():
                _atomic_file(self.path, encode({"language": language}))
                self.language = language
                self.persisted = True


def _stored_config(root):
    path = Path(root) / CONFIG
    body = json.loads(_limited_read(path, 4096).decode("utf-8"))
    if not isinstance(body, dict) or set(body) != {"server", "station_id", "token_file"}:
        raise ValueError("Invalid local connection settings")
    name = body["token_file"]
    if not isinstance(name, str) or not TOKEN_FILE.fullmatch(name):
        raise ValueError("Invalid local token reference")
    return body


def load_connection(root):
    body = _stored_config(root)
    token = _limited_read(Path(root) / body["token_file"], 100).decode("ascii")
    return _validate(body["server"], body["station_id"], token)


@contextmanager
def station_lock(root, *, existing_only=False):
    path = Path(root) / "agent.lock"
    if path.is_symlink():
        raise ValueError("Invalid local lock file")
    if existing_only and not path.exists():
        yield
        return
    if not existing_only:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_RDWR | (0 if existing_only else os.O_CREAT), 0o600)
    with os.fdopen(fd, "r+b", buffering=0) as lock:
        if os.name == "nt":
            import msvcrt

            if not lock.read(1):
                if existing_only:
                    raise ValueError("Station lock is incomplete")
                lock.write(b"0")
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise ValueError("This data directory is already in use") from exc
        else:
            import fcntl

            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise ValueError("This data directory is already in use") from exc
        # Closing the handle releases the lock. Keep the lock file path stable.
        yield


def configure(root, import_path, *, language=None):
    root = Path(root)
    if language is not None:
        _validate_language(language)
    with station_lock(root):
        try:
            source = json.loads(_limited_read(import_path, 8192).decode("utf-8-sig"))
            if not isinstance(source, dict) or set(source) != {"server", "station_id", "token"}:
                raise ValueError("Expected server, station_id and token")
            config = _validate(source["server"], source["station_id"], source["token"])
        except (ValueError, TypeError) as exc:
            raise ValueError("Invalid connection JSON") from exc

        try:
            previous = _stored_config(root)
        except FileNotFoundError:
            previous = None
        if previous and (previous["station_id"], previous["server"]) != (config.station_id, config.server):
            raise ValueError("Use a different data directory for another station or server")
        if previous is None and (root / "ledger.sqlite3").exists():
            raise ValueError("Restore the original connection settings before using this ledger")

        name = "token-" + uuid4().hex + ".txt"
        _atomic_file(root / name, config.token.encode("ascii"))
        new_body = {"server": config.server, "station_id": config.station_id, "token_file": name}
        try:
            _atomic_file(root / CONFIG, encode(new_body))
        except OSError:
            (root / name).unlink(missing_ok=True)
            raise
        # Previous credentials are no longer used; removing this file has no effect on the ledger.
        if previous:
            (root / previous["token_file"]).unlink(missing_ok=True)
        if language is not None:
            _atomic_file(root / UI_PREFERENCES, encode({"language": language}))
        return config
