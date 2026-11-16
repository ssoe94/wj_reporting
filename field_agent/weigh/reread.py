"""Source scan judgement order, applied inside the shared ledger transaction."""

import re

from .label_code import parse_label_code


CODE = re.compile(r"[A-Z0-9][A-Z0-9_.-]{0,63}", re.ASCII)
DEVICES = ("A", "B", "W", "KEYBOARD")
SOURCES = ("scanner", "serial", "keyboard", "manual", "demo")
SCAN_RESULTS = {
    "ok": ("ok", "reread_match"),
    "invalid": ("ng", "scan_invalid"),
    "unknown_barcode": ("ng", "label_unknown"),
    "invalid_label_code": ("ng", "label_invalid_code"),
    "wrong_part": ("ng", "reread_wrong_part"),
    "wrong_scanner_A": ("ng", "scan_wrong_device"),
    "wrong_scanner_B": ("ng", "scan_wrong_device"),
    "duplicate": ("ng", "scan_duplicate"),
    "unprinted": ("ng", "label_not_submitted"),
    "uncertain": ("error", "print_uncertain"),
    "review_required": ("info", "label_review_required"),
    "manual_entry": ("info", "manual_input"),
    "test_scan": ("info", "test_input"),
    "ledger_error": ("error", "local_record_error"),
}


def expected_lane(product):
    if product.profile.size in ("75", "85", "OLED 55 - C7/97"):
        return "ANY"
    return product.scanner


def reporting_product(model):
    """Keep the source reporting groups, including size 85 in the large family."""
    size = "55" if model == "OLED 55 - C7/97" else model
    if size == "85":
        return "85", "70/75/86"
    for group in ("50/55", "60/65", "70/75/86"):
        if size in group.split("/"):
            return size, group
    return "", ""


def scan_slot(device, expected):
    return device if device in ("A", "B") else ("B" if expected == "B" else "A")


def scan_status(*, wrong_part, first, expected, slot, source, print_status=None, confirmed=None, quantity=1):
    if wrong_part:
        return "wrong_part"
    if first is not None:
        return "duplicate"
    if expected != "ANY" and slot != expected:
        return "wrong_scanner_" + expected
    if print_status in ("waiting", "cancelled") or confirmed == 0:
        return "unprinted"
    if print_status in ("dispatching", "uncertain") and confirmed is None:
        return "uncertain"
    if confirmed is not None and confirmed < quantity:
        return "review_required"
    return {"manual": "manual_entry", "demo": "test_scan"}.get(source, "ok")


def classify(code, *, job, first, product, all_products, codes, slot, source, calendar_date):
    result = {"status": "invalid", "label_origin": "unknown", "part_no": "", "job_id": None}
    if not CODE.fullmatch(code):
        return result
    expected = expected_lane(product)
    if job is not None:
        result.update(part_no=job["part_no"], label_origin="local", job_id=job["job_id"],
                      label_index=job["label_index"], print_status=job["row_state"] or job["state"],
                      print_date=job["print_date"], model=job["model"],
                      status=scan_status(wrong_part=product.profile.part_no != job["part_no"]
                                         or product.profile.size != job["model"], first=first, expected=expected,
                                         slot=slot, source=source, print_status=job["state"],
                                         confirmed=job["confirmed_quantity"], quantity=job["row_quantity"] or 1))
    else:
        parsed = parse_label_code(code, all_products, today=calendar_date, **codes)
        if parsed is None:
            result["status"] = "unknown_barcode"
            return result
        origin_product = all_products.get(parsed["part_no"])
        result.update(label_origin="external", part_no=parsed["part_no"], print_date=parsed.get("print_date", ""),
                      print_status="external", model=origin_product.profile.size if origin_product else "")
        if parsed.get("error"):
            result.update(status="invalid_label_code", parse_error=parsed["error"])
        else:
            result["status"] = scan_status(wrong_part=product.profile.part_no != parsed["part_no"], first=first,
                                           expected=expected, slot=slot, source=source)
    result["product_size"], result["product_group"] = reporting_product(result.get("model", ""))
    if result["status"] == "duplicate":
        result["duplicate_of"] = first
    return result
