"""Install-time configuration for separate, read-only vision sources."""

import json
from pathlib import Path

from .config import _atomic_file, _limited_read
from .protocol import encode


CONFIG_NAME = "vision-sources.json"
DECLARED_MODES = {"unknown", "production", "test"}
SOURCES = {
    "backcover": ("vision_backcover", "history", {"camera_mode", "status_enabled"}),
    "capture": ("vision_capture", "root", {"auto_mode"}),
    "uv": ("vision_uv", "root", set()),
}


def _read(path):
    path = Path(path)
    raw = json.loads(_limited_read(path, 8192).decode("utf-8-sig"))
    if not isinstance(raw, dict) or set(raw) - SOURCES.keys():
        raise ValueError("Invalid vision source configuration")
    settings = {}
    for name, source in raw.items():
        _, path_key, extras = SOURCES[name]
        if not isinstance(source, dict) or path_key not in source or set(source) - (extras | {path_key}):
            raise ValueError("Invalid vision source entry")
        name_text = source[path_key]
        if (not isinstance(name_text, str) or not 1 <= len(name_text) <= 1024 or
                not name_text.isprintable() or name_text.strip() != name_text):
            raise ValueError("Invalid vision data path")
        values = dict(source)
        values[path_key] = str((path.parent / name_text).resolve())
        for key in ("camera_mode", "auto_mode"):
            if key in values and (not isinstance(values[key], str) or values[key] not in DECLARED_MODES):
                raise ValueError("Invalid declared vision mode")
        if "status_enabled" in values and type(values["status_enabled"]) is not bool:
            raise ValueError("The vision status setting must be boolean")
        settings[name] = values
    return settings


def prepare_sources(path):
    return _read(path)


def save_sources(root, sources):
    _atomic_file(Path(root) / CONFIG_NAME, encode(sources))


def load_sources(root):
    try:
        return _read(Path(root) / CONFIG_NAME)
    except FileNotFoundError:
        return {}


def create_collectors(ledger, config):
    if not config:
        return {}
    from .vision_backcover import BackcoverCollector
    from .vision_folders import CaptureCollector, UVCollector

    factories = {"backcover": BackcoverCollector, "capture": CaptureCollector, "uv": UVCollector}
    collectors = {}
    for name, values in config.items():
        app, path_key, _ = SOURCES[name]
        args = dict(values)
        source = Path(args.pop(path_key))
        if source == ledger.path or source in ledger.path.parents:
            raise ValueError("Vision source must differ from the field ledger")
        collectors[app] = factories[name](ledger, source, **args)
    return collectors
