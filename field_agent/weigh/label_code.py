"""Structural check of WJ label identification codes printed by another program.

A code is PART + site + vendor + 3-character date code + 4-character base-34
serial, the same rule as printer_reference.serials.make_barcode. The PART does
not have to be registered in this station; an unregistered PART must have the
standard 11-character form. Passing this check proves only that the code is
well formed; it is never treated as evidence of a print job in this PC's ledger.
"""
from datetime import date, timedelta
import re

from .serials import BASE34_DIGITS


MONTH_CODES = "123456789OND"
DAY_CODES = "123456789ABCDEFGHJKLMNPQRSTUVWXYZ"[:31]
MAX_LABEL_AGE_DAYS = 366
# Standard LG product PART: 3 letters + 8 letters/digits.
STANDARD_PART = re.compile(r"[A-Z]{3}[A-Z0-9]{8}\Z")


def _resolve_date(year_digit, month, day, today):
    """Latest real date with this year digit that is not after tomorrow."""
    limit = today + timedelta(days=1)
    first = limit.year - ((limit.year - year_digit) % 10)
    for year in (first, first - 10):
        try:
            value = date(year, month, day)
        except ValueError:
            continue
        if value <= limit:
            return value
    return None


def parse_label_code(code, registered_parts=(), *, site_code, vendor_code, today=None):
    """Return None for a code that is not a WJ label, otherwise a dictionary.

    ``registered_parts`` are this station's PART numbers; they are matched first
    so non-standard registered PARTs (e.g. TEST-...) also work. The dictionary
    has ``part_no`` and ``registered`` plus ``print_date``/``serial`` for a valid
    code, or ``error`` (site_vendor/date_code/serial) for a malformed one.
    """
    code = str(code or "").strip().upper()
    today = today or date.today()
    tail = site_code + vendor_code
    tail_length = len(tail) + 3 + 4
    parts = {str(part).strip().upper() for part in registered_parts if str(part).strip()}
    candidates = [part for part in parts if code.startswith(part) and len(code) == len(part) + tail_length]
    registered = bool(candidates)
    if not candidates:
        # An unregistered PART is only a label code when it carries this
        # site/vendor, so unrelated 21-character barcodes stay unrecognized.
        prefix = code[:11]
        if len(code) != 11 + tail_length or not STANDARD_PART.match(prefix) or code[11:11 + len(tail)] != tail:
            return None
        candidates = [prefix]
    if len(candidates) != 1:
        return None
    part_no = candidates[0]
    rest = code[len(part_no):]
    result = {"part_no": part_no, "registered": registered}
    if not rest.startswith(tail):
        return dict(result, error="site_vendor")
    year_char, month_char, day_char = rest[len(tail):len(tail) + 3]
    serial_text = rest[len(tail) + 3:]
    if not year_char.isdigit() or month_char not in MONTH_CODES or day_char not in DAY_CODES:
        return dict(result, error="date_code")
    printed = _resolve_date(int(year_char), MONTH_CODES.index(month_char) + 1,
                            DAY_CODES.index(day_char) + 1, today)
    if printed is None or (today - printed).days > MAX_LABEL_AGE_DAYS:
        return dict(result, error="date_code")
    if any(char not in BASE34_DIGITS for char in serial_text):
        return dict(result, error="serial")
    serial = 0
    for char in serial_text:
        serial = serial * 34 + BASE34_DIGITS.index(char)
    if serial < 1:
        return dict(result, error="serial")
    return dict(result, print_date=printed.isoformat(), serial=serial)
