"""Pure barcode validation and scan-decision logic.

This module deliberately has no GUI, database, or hardware dependencies so the
factory rules can be exercised with fast unit tests.
"""

from dataclasses import dataclass


BASE34_DIGITS = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"
FIELD_PART_SUFFIX_LENGTH = 4


class FieldPartError(ValueError):
    """Operator input for a field-set part number was rejected.

    ``code`` is a stable key the UI translates; ``scanner`` names the A/B field.
    """

    def __init__(self, code, scanner=""):
        super().__init__(code)
        self.code = code
        self.scanner = scanner


def normalize_field_parts(raw):
    """Return ``{group: {"A": part_no, "B": part_no}}`` with blanks removed."""
    normalized = {}
    if not isinstance(raw, dict):
        return normalized
    for group, parts in raw.items():
        group_name = str(group).strip()
        if not group_name or not isinstance(parts, dict):
            continue
        entry = {}
        for scanner in ("A", "B"):
            part_no = str(parts.get(scanner, "") or "").strip().upper()
            if part_no:
                entry[scanner] = part_no
        if entry:
            normalized[group_name] = entry
    return normalized


def build_field_parts(prefix, a_suffix, b_suffix, parity_index=10,
                      suffix_length=FIELD_PART_SUFFIX_LENGTH):
    """Build A/B part numbers from a model prefix and the last-digit inputs.

    The A/B scanner parity rule is preserved: the digit at ``parity_index`` of
    the part number must be odd for A and even for B.  Either suffix may be
    blank, but not both.
    """
    prefix = str(prefix or "").strip().upper()
    if not prefix or not prefix.isalnum():
        raise FieldPartError("prefix_invalid")
    parts = {}
    for scanner, suffix in (("A", a_suffix), ("B", b_suffix)):
        suffix = str(suffix or "").strip().upper()
        if not suffix:
            continue
        if len(suffix) != suffix_length or not suffix.isdigit():
            raise FieldPartError("suffix_invalid", scanner)
        part_no = prefix + suffix
        if parity_index < 0 or parity_index >= len(part_no):
            raise FieldPartError("prefix_invalid")
        digit = int(part_no[parity_index])
        expected = "A" if digit % 2 == 1 else "B"
        if expected != scanner:
            raise FieldPartError("parity_mismatch", scanner)
        parts[scanner] = part_no
    if not parts:
        raise FieldPartError("suffix_required")
    if parts.get("A") and parts.get("A") == parts.get("B"):
        raise FieldPartError("parity_mismatch", "B")
    return parts


@dataclass(frozen=True)
class ScanDecision:
    success: bool
    status: str
    barcode: str
    product_size: str
    product_group: str
    expected_scanner: str = ""


class BarcodeRules:
    def __init__(self, config):
        self.prefixes = tuple(str(value).strip().upper() for value in config.get("prefixes", []))
        self.length = int(config.get("length", 21))
        self.parity_index = int(config.get("parity_index", 10))
        self.allowed_sizes = tuple(str(value).strip() for value in config.get("allowed_sizes", []))
        self.size_groups = {
            str(name).strip(): tuple(str(size).strip() for size in sizes)
            for name, sizes in config.get("size_groups", {}).items()
        }
        self.site_vendor_codes = tuple(
            str(value).strip().upper() for value in config.get("site_vendor_codes", [])
        )
        self.serial_length = int(config.get("serial_length", 4))
        self.any_scanner_parts = {
            str(value).strip().upper()
            for value in config.get("any_scanner_parts", [])
            if str(value).strip()
        }
        self.field_parts = normalize_field_parts(config.get("field_parts", {}))
        rules = [dict(rule) for rule in config.get("part_rules", [])]
        field_rules = self._field_part_rules()
        field_part_nos = {rule["part_no"] for rule in field_rules}
        rules = [
            rule for rule in rules
            if str(rule.get("part_no", "")).strip().upper() not in field_part_nos
        ] + field_rules
        self.part_rules = sorted(
            rules,
            key=lambda rule: len(str(rule.get("part_no", ""))),
            reverse=True,
        )

    def _field_part_rules(self):
        """Part rules for the target parts entered on the production floor."""
        rules = []
        for group, parts in self.field_parts.items():
            sizes = self.size_groups.get(group)
            if not sizes:
                continue
            for scanner, part_no in parts.items():
                rules.append({
                    "part_no": part_no,
                    "size": sizes[0],
                    "group": group,
                    "scanner": scanner,
                })
        return rules

    @staticmethod
    def normalize_barcode(barcode):
        return str(barcode or "").strip().upper()

    def get_part_rule(self, barcode):
        code = self.normalize_barcode(barcode)
        for rule in self.part_rules:
            if code.startswith(str(rule.get("part_no", "")).upper()):
                return rule
        return None

    def get_product_size(self, barcode):
        rule = self.get_part_rule(barcode)
        return str(rule.get("size", "")) if rule else ""

    def get_product_group(self, product_size, barcode=None):
        rule = self.get_part_rule(barcode)
        if rule:
            return str(rule.get("group", ""))
        for group_name, sizes in self.size_groups.items():
            if product_size in sizes:
                return group_name
        return ""

    def has_valid_site_vendor(self, barcode, rule):
        if not self.site_vendor_codes:
            return True
        part_no = str(rule.get("part_no", ""))
        remainder = barcode[len(part_no):]
        return any(remainder.startswith(code) for code in self.site_vendor_codes)

    def has_valid_serial(self, barcode):
        if self.serial_length <= 0:
            return True
        serial = barcode[-self.serial_length:]
        return len(serial) == self.serial_length and all(char in BASE34_DIGITS for char in serial)

    def is_valid_barcode(self, barcode):
        code = self.normalize_barcode(barcode)
        if len(code) != self.length:
            return False
        if self.prefixes and not any(code.startswith(prefix) for prefix in self.prefixes):
            return False
        rule = self.get_part_rule(code)
        if not rule or not self.has_valid_site_vendor(code, rule) or not self.has_valid_serial(code):
            return False
        product_size = self.get_product_size(code)
        if self.allowed_sizes and product_size not in self.allowed_sizes:
            return False
        return bool(self.get_product_group(product_size, code))

    def get_expected_scanner(self, barcode):
        code = self.normalize_barcode(barcode)
        if not self.is_valid_barcode(code):
            return None
        rule = self.get_part_rule(code)
        configured = str(rule.get("scanner", "")).upper() if rule else ""
        part_no = str(rule.get("part_no", "")).upper() if rule else ""
        if configured == "ANY" or part_no in self.any_scanner_parts:
            return "ANY"
        if configured in ("A", "B"):
            return configured
        if self.parity_index < 0 or self.parity_index >= len(code):
            return None
        try:
            number = int(code[self.parity_index])
        except (TypeError, ValueError):
            return None
        return "A" if number % 2 == 1 else "B"

    def is_any_scanner_group(self, product_group):
        group_name = str(product_group or "").strip()
        for rule in self.part_rules:
            if str(rule.get("group", "")).strip() != group_name:
                continue
            part_no = str(rule.get("part_no", "")).strip().upper()
            scanner = str(rule.get("scanner", "")).strip().upper()
            if scanner == "ANY" or part_no in self.any_scanner_parts:
                return True
        return False

    def evaluate(self, scanner, barcode, production_group="", last_ok_scanner=None):
        scanner = str(scanner or "").strip().upper()
        code = self.normalize_barcode(barcode)
        product_size = self.get_product_size(code)
        product_group = self.get_product_group(product_size, code)

        if len(code) > self.length:
            return ScanDecision(False, "over21", code, product_size, product_group)

        expected = self.get_expected_scanner(code)
        if expected is None:
            return ScanDecision(False, "invalid", code, product_size, product_group)

        if production_group and product_group != production_group:
            return ScanDecision(
                False, "wrong_product_group", code, product_size, product_group, expected
            )

        previous = str(last_ok_scanner or "").strip().upper()
        if previous:
            if expected == "ANY" or previous == scanner:
                return ScanDecision(False, "duplicate", code, product_size, product_group, expected)
            return ScanDecision(
                False, "wrong_scanner_{}".format(previous), code, product_size, product_group, expected
            )

        if expected != "ANY" and expected != scanner:
            return ScanDecision(
                False, "wrong_scanner_{}".format(expected), code, product_size, product_group, expected
            )

        return ScanDecision(True, "ok", code, product_size, product_group, expected)
