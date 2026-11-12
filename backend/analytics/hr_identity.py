"""Shared exact identity keys for payroll validation and persisted roster rows."""
import re
import unicodedata


def identity(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFC', value))


def code_key(value):
    return str(int(value)) if re.fullmatch(r'[0-9]+', value) else value
