"""Unchanged pure definitions extracted from the 2026-09-04 printer source."""
from datetime import datetime


BASE34_DIGITS = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def get_date_code(date=None):
    date = date or datetime.now()
    year = str(date.year)[-1]
    month_map = {10: "O", 11: "N", 12: "D"}
    month = str(date.month) if date.month <= 9 else month_map[date.month]
    day_digits = "123456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    day = day_digits[date.day - 1]
    return "{0}{1}{2}".format(year, month, day)


def int_to_base34(number):
    number = int(number)
    result = ""
    for _ in range(4):
        result = BASE34_DIGITS[number % 34] + result
        number //= 34
    return result.zfill(4)


def make_barcode(part_no, serial_number, config, date=None):
    site_code = str(config["site_code"]).upper()
    vendor_code = str(config["vendor_code"]).upper()
    return "{0}{1}{2}{3}{4}".format(
        part_no.upper(),
        site_code,
        vendor_code,
        get_date_code(date),
        int_to_base34(serial_number),
    ).upper()
