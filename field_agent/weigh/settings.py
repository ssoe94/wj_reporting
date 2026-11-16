"""Station-local product rules and pre-approved printer command templates."""

from dataclasses import dataclass
from datetime import date
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

    def freeze(self, barcode):
        """Render each permitted column before the serial reservation commits."""
        return [cell.replace("{barcode}", barcode).replace("{part_no}", self.profile.part_no)
                for cell in self.layout["cells"]]


def _print_template(record, columns):
    if set(record) != {"language", "prefix", "cells", "suffix"} or record["language"] not in ("zpl", "tspl"):
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
        if ("barcode" not in fields or any(name not in {"barcode", "part_no"} for name in fields)
                or any(spec or conversion for _, _, spec, conversion in tokens)
                or "{{" in cell or "}}" in cell):
            raise ValueError("Invalid label placeholder")
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


class Settings:
    def __init__(self, raw):
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
            layout = _print_template(item["template"], columns)
            version = hash_json({"product": item, "code": self.code, "rule": "unit_5pct_sqrt_quantity_v1"})
            self.products[part] = Product(name, profile, scanner, columns, peel, layout, version)
        self.default = raw.get("selected_part") or next(iter(self.products), None)
        if self.default not in self.products:
            raise ValueError("Pick a configured weigh product")
        self.serial_floors = raw.get("serial_floors", {})
        if not isinstance(self.serial_floors, dict):
            raise ValueError("Invalid serial floors")
        for part, limits in self.serial_floors.items():
            if part not in self.products or not isinstance(limits, dict):
                raise ValueError("Invalid serial floor product")
            for day, number in limits.items():
                if day != date.fromisoformat(day).isoformat() or type(number) is not int or not 0 <= number <= MAX_SERIAL:
                    raise ValueError("Invalid serial floor")


def load(path):
    with Path(path).open("rb") as stream:
        body = stream.read(512 * 1024 + 1)
    try:
        if len(body) > 512 * 1024:
            raise ValueError("Weigh configuration is too large")
        return Settings(json.loads(body.decode("utf-8-sig")))
    except (KeyError, TypeError, ValueError, OSError, UnicodeError, ArithmeticError):
        raise ValueError("Invalid local weigh configuration") from None
