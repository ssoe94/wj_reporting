"""Canonical field issuer identifiers and evidence carried by the v1 wire."""

from datetime import date
from hashlib import sha256
import json
import re

NAMESPACE = re.compile(r'[A-Z0-9]{3}', re.ASCII)
PART = re.compile(r'[A-Z0-9][A-Z0-9_.-]{0,31}', re.ASCII)
BASE34 = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'
MAX_SERIAL = 34 ** 4 - 1
MAX_GRANTS = 512
MAX_CEILINGS = 4096


def label_date_code(day):
    return str(day.year)[-1] + '123456789OND'[day.month - 1] + BASE34[day.day]


def serial_number(value):
    if not isinstance(value, str) or len(value) != 4 or any(char not in BASE34 for char in value):
        return None
    number = 0
    for char in value:
        number = number * 34 + BASE34.index(char)
    return number


def reservation_fields(event):
    """Infer the namespace for earlier native producers from the full wire barcode."""
    if event.get('app') != 'weigh_label' or event.get('type') != 'label.reserved':
        return '', None
    part = event.get('part_no') or ''
    barcode = event.get('barcode') or ''
    serial = event.get('serial')
    detail = event.get('detail') or {}
    day_text = detail.get('print_date')
    if not PART.fullmatch(part) or not isinstance(day_text, str):
        return '', None
    try:
        day = date.fromisoformat(day_text)
    except ValueError:
        return '', None
    if day.isoformat() != day_text:
        return '', None
    namespace = barcode[len(part):len(part) + 3]
    if (NAMESPACE.fullmatch(namespace) and serial_number(serial) is not None
            and barcode == part + namespace + label_date_code(day) + serial
            and detail.get('issuer_namespace', namespace) == namespace):
        return namespace, day
    return '', None


def policy_bytes(policy):
    return json.dumps(policy, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode('utf-8')


def policy_digest(policy):
    return sha256(policy_bytes(policy)).hexdigest()


def grant_summaries(policy):
    return [{name: value for name, value in row.items() if name != 'transfer'} for row in policy['grants']]
