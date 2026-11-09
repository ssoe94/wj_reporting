"""Destination names observed in MES, independent of mould manufacturers.

Only Guangli and Taizhike are repair locations by the owner's classification.
Other companies remain external locations, including other mould manufacturers.
"""

import re
import unicodedata


def _label(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split())


def _key(value):
    return _label(value).replace(" ", "").upper()


_SPECS = (
    ("TIANLU", "天路", "external", ("南京天路新材料科技有限公司", "天路", "天路仓库", "天路倉庫", "TIANLU", "TIAN LU")),
    ("VENDOR:GUANGLI", "广立", "repair", ("丹阳广立模塑有限公司", "广立", "廣立", "GUANGLI", "GUANG LI")),
    ("VENDOR:ZIJIN", "紫金", "external", ("句容紫金辰龙塑料电子有限公司", "紫金", "紫金辰龙", "ZIJIN", "ZI JIN")),
    ("VENDOR:TAIZHIKE", "泰之科", "repair", ("苏州泰之科模具有限公司", "泰之科", "TAIZHIKE", "TAI ZHI KE")),
    ("VENDOR:YUEHEBAO", "跃和保", "external", ("南京跃和保电子有限公司", "跃和保", "躍和保")),
    ("VENDOR:PINJIE", "品捷", "external", ("滁州品捷模塑有限公司", "品捷")),
    ("VENDOR:SUOBOTE", "索博特", "external", ("苏州索博特模具有限公司", "索博特")),
    ("VENDOR:LG", "LG", "external", ("LG电子", "LG電子", "LG")),
    ("VENDOR:HUASHAN", "华山", "external", ("南京华山喷涂有限公司", "华山", "華山")),
    ("VENDOR:SUHONG", "速鸿", "external", ("南京速鸿电子科技有限公司", "速鸿", "速鴻")),
    ("VENDOR:YINGCHANG", "映昌", "external", ("映昌",)),
    ("VENDOR:HAILE", "海勒", "external", ("南京海勒汽车电子科技有限公司", "海勒")),
)
_BY_KEY = {key: {"key": key, "name": name, "category": category} for key, name, category, _ in _SPECS}
_ALIASES = {_key(alias): key for key, _, _, aliases in _SPECS for alias in aliases}
_WJ = re.compile(r"万佳|萬佳|(?<![A-Z])WJ(?![A-Z])", re.IGNORECASE)
_COMPANY = re.compile(r"公司|工厂|工廠|\b(?:CORPORATION|COMPANY|CO\.?[, ]+LTD\.?)\b", re.IGNORECASE)
REQUIRED_VENDOR_KEYS = ("TIANLU", "VENDOR:GUANGLI", "VENDOR:ZIJIN", "VENDOR:TAIZHIKE")


def vendor_for_location(value):
    """Recognize an entire location label; never inspect manufacturer fields."""
    label = _label(value)
    if not label or _WJ.search(label):
        return None
    key = _ALIASES.get(_key(label))
    if key:
        return dict(_BY_KEY[key])
    # A new, explicitly named company gets its own block. Preserve the full
    # name instead of guessing a short alias or a repair role from its trade.
    if _COMPANY.search(label):
        return {"key": f"VENDOR:{_key(label)}", "name": label, "category": "external"}
    return None


def vendor_for_key(key):
    if key in _BY_KEY:
        return dict(_BY_KEY[key])
    if isinstance(key, str) and key.startswith("VENDOR:") and key[7:]:
        return {"key": key, "name": key[7:], "category": "external"}
    return None


def group_metadata(key):
    vendor = vendor_for_key(key)
    if vendor:
        return {"name": vendor["name"], "category": vendor["category"]}
    return {"name": key, "category": {"SVC": "svc", "OTHER": "other", "UNCONFIRMED": "unconfirmed"}[key]}


def group_order(key):
    category = group_metadata(key)["category"]
    category_order = {"svc": 0, "repair": 1, "external": 2, "other": 3, "unconfirmed": 4}
    known_order = {item[0]: index for index, item in enumerate(_SPECS)}
    return (category_order[category], known_order.get(key, len(_SPECS)), key)
