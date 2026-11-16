"""Persist an operator-selected input profile independently of the release."""

import json
from pathlib import Path

from ..barcode_app import load_barcode_config
from ..config import _atomic_file, _limited_read
from ..protocol import encode
from ..weigh.settings import load as load_weigh_settings

NAME = "launch-input.json"
NATIVE = ("barcode_config", "weigh_config")
LEGACY = ("legacy_barcode_db", "legacy_weigh_dbs")


def prepare_inputs(raw, base):
    if not isinstance(raw, dict) or raw.keys() - {*NATIVE, *LEGACY}:
        raise ValueError("Invalid field input settings")
    if sum((any(key in raw for key in NATIVE), *(key in raw for key in LEGACY))) > 1:
        raise ValueError("Select native apps or one legacy input")
    inputs = {}
    for key, value in raw.items():
        many = key == "legacy_weigh_dbs"
        names = value if many else [value]
        if not isinstance(names, list) or len(names) != (2 if many else 1):
            raise ValueError("Invalid field input paths")
        if any(not isinstance(name, str) or not name or not name.isprintable() or len(name) > 1024
               for name in names):
            raise ValueError("Invalid field input path")
        paths = [str((base / name).resolve()) for name in names]
        inputs[key] = paths if many else paths[0]
    if "barcode_config" in inputs:
        load_barcode_config(inputs["barcode_config"])
    if "weigh_config" in inputs:
        load_weigh_settings(inputs["weigh_config"])
    return inputs


def read_inputs(data):
    try:
        content = _limited_read(data / NAME, 8192)
    except FileNotFoundError:
        return {}
    return prepare_inputs(json.loads(content.decode("utf-8")), data)


def save_inputs(data, values):
    _atomic_file(data / NAME, encode(values))


def input_args(values):
    argv = []
    for key, value in values.items():
        argv.append("--" + key.replace("_", "-"))
        argv.extend(value if isinstance(value, list) else [value])
    return argv
