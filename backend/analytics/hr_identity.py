"""Shared exact keys for payroll intake and HR comparisons."""
import re
import unicodedata


def identity(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFC', value))


def code_key(value):
    return str(int(value)) if re.fullmatch(r'[0-9]+', value) else value


def normalize_title(value):
    return ''.join(value.split())
