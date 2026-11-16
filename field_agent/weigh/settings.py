"""Station-local product rules and pre-approved printer command templates."""

from dataclasses import dataclass, replace
from hashlib import sha256
import json
from pathlib import Path
import re
from string import Formatter

from .rules import WeightProfile


PART = re.compile(r"[A-Z0-9][A-Z0-9_.-]{0,31}", re.ASCII)
MAX_SERIAL = 34 ** 4 - 1


def hash_json(value):
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _code(value, pattern):
    if not isinstance(value, str) or not re.fullmatch(pattern, value, flags=re.ASCII):
        raise ValueError("Invalid weigh label identifier")
    return value


@dataclass(frozen=True)
class Product:
    name: str
    profile: WeightProfile
    scanner: str
    columns: int
    peel: bool
    layout: dict
    version: str
    templates: dict
    template_id: str = "default"
    values: tuple = ()

    def freeze(self, barcode):
        """Render each permitted column before the serial reservation commits."""
        fields = dict(self.values, barcode=barcode, part_no=self.profile.part_no)
        return [cell.format_map(fields) for cell in self.layout["cells"]]


def _print_template(record, columns, editable=()):
    if not isinstance(record, dict) or set(record) != {"language", "prefix", "cells", "suffix"} or record["language"] not in ("zpl", "tspl"):
        raise ValueError("Invalid label template")
    cells = record["cells"]
    if not isinstance(cells, list) or len(cells) != columns:
        raise ValueError("A label template needs one cell per column")
    for command in [record["prefix"], *cells, record["suffix"]]:
        if not isinstance(command, str) or not 1 <= len(command) <= 4096 or "\0" in command:
            raise ValueError("Invalid label command")
        command.encode("ascii")
    if any("{" in value or "}" in value for value in (record["prefix"], record["suffix"])):
        raise ValueError("Invalid label framing")
    for cell in cells:
        tokens = list(Formatter().parse(cell))
        fields = [name for _, name, _, _ in tokens if name is not None]
        if ("barcode" not in fields or any(name not in {"barcode", "part_no", *editable} for name in fields)
                or any(spec or conversion for _, _, spec, conversion in tokens)
                or "{{" in cell or "}}" in cell):
            raise ValueError("Invalid label placeholder")
        if record["language"] == "zpl":
            text_slots = re.findall(r"\^FD([^\^]*)\^FS", cell, flags=re.IGNORECASE)
        else:
            text_slots = re.findall(r'^\s*TEXT[^\n]*"([^"\n]*)"\s*$', cell, flags=re.MULTILINE | re.IGNORECASE)
        for name in set(fields) & set(editable):
            marker = "{" + name + "}"
            if sum(slot.count(marker) for slot in text_slots) != cell.count(marker):
                raise ValueError("Editable values are allowed only in label text fields")
    commands = record["prefix"] + "".join(cells) + record["suffix"]
    if record["language"] == "zpl":
        upper = commands.upper()
        if (not upper.startswith("^XA") or not upper.endswith("^XZ") or upper.count("^XA") != 1
                or upper.count("^XZ") != 1 or "^PQ" in upper):
            raise ValueError("ZPL templates must frame exactly one physical label row")
    else:
        lines = [line.strip().upper() for line in commands.splitlines() if line.strip()]
        prints = [line for line in lines if re.match(r"PRINT\b", line)]
        if len(prints) != 1 or prints[0] != lines[-1] or not re.fullmatch(r"PRINT\s+1(?:\s*,\s*1)?", prints[0]):
            raise ValueError("TSPL templates must issue exactly one physical row at the end")
    return record


LABEL_FIELD_KEYS = {"model_label", "mez", "rev", "color", "test_note"}
_TEXT_VALUE = re.compile(r'[^"\\^~{}\x00-\x1f\x7f]*', re.ASCII)


def normalize_label_value(value, limit):
    if (not isinstance(value, str) or len(value) > limit or any(ord(char) > 126 for char in value)
            or not _TEXT_VALUE.fullmatch(value)):
        raise ValueError("Invalid approved label text")
    return value


def _field_definition(item):
    if not isinstance(item, dict) or set(item) != {"key", "label_ko", "label_zh", "max_length", "default"}:
        raise ValueError("Invalid editable label field")
    key, limit = item["key"], item["max_length"]
    if (key not in LABEL_FIELD_KEYS or type(limit) is not int or not 1 <= limit <= 96
            or any(not isinstance(item[lang], str) or not 0 < len(item[lang]) <= 64 or not item[lang].isprintable()
                   for lang in ("label_ko", "label_zh"))):
        raise ValueError("Invalid editable label field")
    normalize_label_value(item["default"], limit)
    return item


def _templates(item, columns):
    templates = {"default": {"id": "default", "name": "default", "name_ko": "기본", "name_zh": "默认",
                             "columns": columns, "fields": [], "layout": _print_template(item["template"], columns)}}
    variants = item.get("templates", [])
    if not isinstance(variants, list) or len(variants) > 10:
        raise ValueError("Invalid template list")
    for configured in variants:
        name = _code(configured["id"], r"[A-Za-z][A-Za-z0-9_-]{0,39}")
        labels = (configured["name_ko"], configured["name_zh"])
        amount = configured.get("columns", columns)
        if (name in templates or type(amount) is not int or amount not in (1, 2, 3)
                or any(not isinstance(label, str) or not 0 < len(label) <= 64 or not label.isprintable()
                       for label in labels)):
            raise ValueError("Invalid label template identity")
        raw_fields = configured.get("fields", [])
        if not isinstance(raw_fields, list) or len(raw_fields) > len(LABEL_FIELD_KEYS):
            raise ValueError("Invalid editable label fields")
        fields = [_field_definition(field) for field in raw_fields]
        editable = {field["key"] for field in fields}
        if len(editable) != len(fields):
            raise ValueError("Duplicate editable label field")
        layout = _print_template(configured["template"], amount, editable)
        cells = "".join(layout["cells"])
        if any("{" + key + "}" not in cells for key in editable):
            raise ValueError("Each editable label field must be printed")
        templates[name] = {"id": name, "name": name, "name_ko": labels[0], "name_zh": labels[1], "columns": amount,
                           "fields": fields, "layout": layout}
    return templates


def choose_template(base, template_id, values):
    if not isinstance(template_id, str) or template_id not in base.templates or not isinstance(values, dict):
        raise ValueError("Unknown approved label template")
    variant = base.templates[template_id]
    fields = {field["key"]: field for field in variant["fields"]}
    if values.keys() - fields.keys():
        raise ValueError("Unapproved label field")
    labels = tuple((key, normalize_label_value(values.get(key, field["default"]), field["max_length"]))
                   for key, field in fields.items())
    version = base.version
    if template_id != "default":
        version = hash_json({"product": version, "template": template_id, "values": dict(labels)})
    return replace(base, columns=variant["columns"], layout=variant["layout"], template_id=template_id,
                   values=labels, version=version)


class Settings:
    def __init__(self, raw, *, base=None):
        if not isinstance(raw, dict):
            raise ValueError("Invalid weigh configuration")
        self.mode = raw.get("mode", "test")
        if self.mode not in ("production", "test"):
            raise ValueError("Invalid weigh mode")
        self.code = {"site_code": _code(raw["site_code"], r"[A-Z0-9]{1}"),
                     "vendor_code": _code(raw["vendor_code"], r"[A-Z0-9]{2}")}
        self.devices = raw.get("devices", {})
        if not isinstance(self.devices, dict):
            raise ValueError("Invalid weigh device section")
        self.printer_route = hash_json({"printer": self.devices.get("printer", {}), "mode": self.mode})
        self.products = {}
        for item in raw["products"]:
            part = _code(item["part_no"], PART.pattern)
            name, model = item["name"], item["model"]
            if (part in self.products or not isinstance(model, str) or not 1 <= len(model) <= 80
                    or not model.isprintable() or not isinstance(name, str) or not 1 <= len(name) <= 80
                    or not name.isprintable()):
                raise ValueError("Duplicate or invalid weigh product")
            profile = WeightProfile(model, part, item["unit_weight_g"], item["calibration_g"], item["calibrated_at"])
            columns = item.get("columns", 1)
            scanner = item.get("scanner", "ANY")
            peel = item.get("peel", False)
            if type(columns) is not int or columns not in (1, 2, 3) or scanner not in ("A", "B", "ANY") or type(peel) is not bool:
                raise ValueError("Invalid label queue rules")
            variants = _templates(item, columns)
            version = hash_json({"product": item, "code": self.code, "rule": "unit_5pct_sqrt_quantity_v1"})
            self.products[part] = Product(name, profile, scanner, columns, peel, variants["default"]["layout"],
                                          version, variants)
        self.default = raw.get("selected_part") or next(iter(self.products), None)
        if self.default not in self.products:
            raise ValueError("Pick a configured weigh product")
        legacy = raw.get("legacy_print_db")
        if legacy is not None and (not isinstance(legacy, str) or not legacy.strip() or "\0" in legacy):
            raise ValueError("Invalid legacy print database path")
        self.legacy_print_db = None if legacy is None else (Path(base or ".") / legacy).absolute()


def load(path):
    with Path(path).open("rb") as stream:
        body = stream.read(512 * 1024 + 1)
    try:
        if len(body) > 512 * 1024:
            raise ValueError("Weigh configuration is too large")
        return Settings(json.loads(body.decode("utf-8-sig")), base=Path(path).resolve().parent)
    except (KeyError, TypeError, ValueError, OSError, UnicodeError, ArithmeticError):
        raise ValueError("Invalid local weigh configuration") from None
