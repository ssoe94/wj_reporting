"""Read-only BLACKLAKE custom-object adapter for the WJ mould dashboard.

The tenant-generated field codes for ``MOLD001__c`` are intentionally not
hard-coded.  Records and child-object metadata are resolved by BLACKLAKE's
stable ``fieldName``/``objectName`` values and every upstream call uses the
existing server-side MES token flow.
"""

from __future__ import annotations

import copy
import json
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from datetime import datetime, timezone as datetime_timezone
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests
from django.core.cache import cache

from inventory.mes import (
    MES_BASE_URL,
    MES_ROUTE_BASE,
    _safe_exception_message,
    get_access_token,
)

from .mould_events import (
    MACHINE_LOCATION_CODES,
    classify_location,
    normalize_location,
    normalize_position_history,
)


MOULD_OBJECT_CODE = "MOLD001__c"

CUSTOM_OBJECT_LIST_ENDPOINT = (
    f"{MES_ROUTE_BASE}/custom-object/open/v1/custom_object/list"
)
CUSTOM_OBJECT_DETAIL_ENDPOINT = (
    f"{MES_ROUTE_BASE}/custom-object/open/v1/custom_object/detail"
)
CUSTOM_OBJECT_CHILD_ENDPOINT = (
    f"{MES_ROUTE_BASE}/custom-object/open/v2/custom_object/page_son_object"
)
CUSTOM_OBJECT_METADATA_ENDPOINT = (
    f"{MES_ROUTE_BASE}/metadata/open/v1/standard_business_object/_metadata"
)
OPERATION_LOG_LIST_ENDPOINT = f"{MES_ROUTE_BASE}/log/open/v1/log/_list"
OPERATION_LOG_DETAIL_ENDPOINT = f"{MES_ROUTE_BASE}/log/open/v1/log/_detail"
RESOURCE_MOULD_LIST_ENDPOINT = (
    f"{MES_ROUTE_BASE}/resource/open/v2/resources/resource_mold/list"
)
RESOURCE_MOULD_DETAIL_ENDPOINT = (
    f"{MES_ROUTE_BASE}/resource/open/v2/resources/resource_mold/detail"
)

RESOURCE_FIELD_NAMES = {
    "resource_id": "id",
    "entity_link_code": "entityLinkCode",
    "current_output_amount": "currentOutputAmount",
    "current_output_batch_amount": "currentOutputBatchAmount",
    "lifespan_status": "lifespanStatus",
    "maintenance_status": "maintenanceStatus",
    "repair_status": "repairStatus",
    "resource_status": "status",
    "on_way_status": "onWayStatus",
    "lock_status": "lockStatus",
    "resource_cover_file_id": "coverFileId",
    "resource_locations": "locations",
    "resource_record_updated_at": "updatedAt",
}

SHANGHAI = ZoneInfo("Asia/Shanghai")
PAGE_SIZE = 200
MAX_PAGES = 25
MAX_LOG_DETAILS = 20
METADATA_CACHE_KEY = "injection:moulds:MOLD001__c:metadata:v1"
METADATA_CACHE_SECONDS = 60 * 60


PARENT_FIELD_NAMES: dict[str, tuple[str, ...]] = {
    "mould_code": ("履历编号", "履歷編號", "이력번호"),
    "asset_code": ("资产号", "資產號", "자산번호"),
    "location": ("当前位置", "當前位置", "현재위치", "현재 위치"),
    "drawing_no": ("模具图号", "模具圖號", "도면번호"),
    "status": ("当前状态", "當前狀態", "현재상태", "현재 상태"),
    "classification": ("分类", "分類", "분류"),
    "model": ("型号", "型號", "모델"),
    "cavity_count": ("模具穴数", "模具穴數", "Cavity", "캐비티"),
    "manufacturer": ("制造处", "製造處", "제조처", "제조사"),
    "acquired_at": ("取得日期", "취득일", "취득일자"),
    "product_photo": ("产品照片", "產品照片", "제품사진", "제품 사진"),
    "serial_no": ("序列号", "序列號", "시리얼번호", "Serial No"),
    "name": ("模具名称", "模具名稱", "금형명", "금형 이름"),
}

CHILD_OBJECT_NAMES: dict[str, tuple[str, ...]] = {
    "movement_history": ("模具移动事项", "模具移動事項", "금형 이동 사항"),
    "production_history": ("生产数量", "生產數量", "생산 수량"),
    "repair_history": (
        "模具改造维修记录",
        "模具改造維修記錄",
        "금형 개조 수리 기록",
    ),
}

MOVEMENT_DATE_NAMES = (
    "移动日期",
    "移動日期",
    "日期",
    "이동일",
    "이동 일자",
)
MOVEMENT_DESTINATION_NAMES = (
    "目的地",
    "移动处",
    "移動處",
    "移动目的地",
    "移動目的地",
    "当前位置",
    "이동처",
    "목적지",
)

MOVEMENT_FIELD_NAMES = {
    "record_code": ("记录编号", "記錄編號", "记录号", "기록번호"),
    "occurred_at": MOVEMENT_DATE_NAMES,
    "from_location": ("原位置", "来源位置", "來源位置", "이전위치", "출발지"),
    "to_location": MOVEMENT_DESTINATION_NAMES,
    "reason": (
        "移动原因",
        "移動原因",
        "移动理由",
        "移動理由",
        "原因",
        "이동사유",
        "사유",
    ),
    "operator_name": (
        "负责人",
        "負責人",
        "所有者",
        "担当",
        "담당",
        "담당자",
        "소유자",
    ),
}
PRODUCTION_FIELD_NAMES = {
    "period": ("期间", "期間", "统计期间", "기간"),
    "year": ("年度", "年份", "年", "연도"),
    "month": ("月份", "月", "월"),
    "quantity": ("生产数量", "生產數量", "产量", "數量", "생산수량"),
    "cumulative_quantity": (
        "总计",
        "總計",
        "合计",
        "合計",
        "总生产数量",
        "總生產數量",
        "累计生产数量",
        "累計生產數量",
        "총계",
        "누적생산수량",
    ),
    "unit": ("单位", "單位", "unit", "단위"),
    "recorded_at": ("记录日期", "記錄日期", "日期", "기록일"),
}
PRODUCTION_MONTH_FIELD_NAMES = {
    month: (f"{month}月", f"{month}月份", f"{month}월")
    for month in range(1, 13)
}
REPAIR_FIELD_NAMES = {
    "record_code": ("记录编号", "記錄編號", "维修编号", "수리기록번호"),
    "requested_at": ("申请日期", "申請日期", "委托日期", "요청일"),
    "cumulative_output_amount": (
        "总生产数量",
        "總生產數量",
        "累计生产数量",
        "累計生產數量",
        "누적생산수량",
    ),
    "vendor": (
        "改造/维修处",
        "改造/維修處",
        "维修厂家",
        "維修廠家",
        "供应商",
        "供應商",
        "수리업체",
    ),
    "type": (
        "改造/维修/保养",
        "改造/維修/保養",
        "维修类型",
        "維修類型",
        "改造维修类型",
        "유형",
    ),
    "content": (
        "改造/维修内容",
        "改造/維修內容",
        "维修内容",
        "維修內容",
        "改造内容",
        "내용",
    ),
    "creator_name": (
        "制作人",
        "製作人",
        "创建人",
        "創建人",
        "登记人",
        "등록자",
        "작성자",
    ),
    "started_at": ("开始日期", "開始日期", "开始时间", "시작일"),
    "finished_at": ("结束日期", "結束日期", "结束时间", "종료일"),
    "attachment_ids": ("附件", "附件ID", "PDF", "첨부파일", "첨부"),
}

_MACHINE_CODE_RE = re.compile(r"^#(?P<number>\d+)-(?P<tonnage>\d+T)$")
class MouldServiceError(RuntimeError):
    """Safe, user-displayable failure from the mould integration boundary."""


def _normalised_name(value: Any) -> str:
    return re.sub(r"[\s_-]+", "", str(value or "")).casefold()


def _unique_warnings(values: Iterable[Any]) -> list[str]:
    return list(
        dict.fromkeys(str(value).strip() for value in values if str(value).strip())
    )


def _as_identifier(value: Any) -> str | None:
    if value in (None, "") or isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip() or None


def _json_safe(value: Any, *, id_value: bool = False) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if id_value and isinstance(value, (int, float)):
        return _as_identifier(value)
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for raw_key, item in value.items():
            key = str(raw_key)
            is_id = key.casefold() == "id" or bool(
                re.search(r"(?:Id|Ids|ID|IDs)$", key)
            )
            result[key] = _json_safe(item, id_value=is_id)
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_json_safe(item, id_value=id_value) for item in value]
    if isinstance(value, (int, float)):
        return value
    return str(value)


def _epoch_milliseconds(value: Any) -> int | None:
    if value in (None, "") or isinstance(value, bool):
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not re.fullmatch(r"-?\d+(?:\.0+)?", stripped):
            try:
                parsed = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
            except ValueError:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=SHANGHAI)
            return int(parsed.timestamp() * 1000)
        value = stripped
    try:
        numeric = int(float(value))
    except (TypeError, ValueError, OverflowError):
        return None
    if 946_684_800 <= numeric < 4_102_444_800:
        numeric *= 1000
    if 946_684_800_000 <= numeric < 4_102_444_800_000:
        return numeric
    return None


def _timestamp_iso(value: Any) -> str | None:
    timestamp = _epoch_milliseconds(value)
    if timestamp is None:
        return None
    return datetime.fromtimestamp(
        timestamp / 1000,
        tz=datetime_timezone.utc,
    ).astimezone(SHANGHAI).isoformat()


def _nested_display_value(value: Any, *, depth: int = 0) -> Any:
    """Return a safe scalar/list from BLACKLAKE's polymorphic fieldValue."""

    if depth > 4 or value is None or isinstance(value, bool):
        return value
    if isinstance(value, (str, int, float)):
        return _json_safe(value)
    if isinstance(value, Mapping):
        for key in (
            "mainProperty",
            "$primaryValue",
            "choiceValue",
            "displayValue",
            "fieldValueSingleChoiceValue",
            "numberValue",
            "decimalValue",
            "textValue",
            "dateValue",
            "formulaValue",
            "result",
            "name",
            "label",
            "message",
            "value",
            "choiceCode",
            "code",
        ):
            if key not in value:
                continue
            displayed = _nested_display_value(value.get(key), depth=depth + 1)
            if displayed not in (None, "", [], {}):
                return displayed
        return None
    if isinstance(value, Sequence) and not isinstance(
        value, (str, bytes, bytearray)
    ):
        displayed = [
            child
            for item in value
            if (child := _nested_display_value(item, depth=depth + 1))
            not in (None, "", [], {})
        ]
        if len(displayed) == 1:
            return displayed[0]
        return displayed or None
    return None


def _field_display_value(field: Mapping[str, Any]) -> Any:
    single_choice = field.get("fieldValueSingleChoiceValue")
    if single_choice not in (None, ""):
        return _nested_display_value(single_choice)

    multiple_choices = field.get("fieldValueMultipleChoiceValues")
    if isinstance(multiple_choices, Sequence) and not isinstance(
        multiple_choices, (str, bytes, bytearray)
    ) and multiple_choices:
        return _nested_display_value(multiple_choices)

    choices = field.get("choiceValues")
    if isinstance(choices, Sequence) and not isinstance(
        choices, (str, bytes, bytearray)
    ) and choices:
        displayed: list[Any] = []
        for choice in choices:
            if isinstance(choice, Mapping):
                value = next(
                    (
                        choice.get(key)
                        for key in (
                            "choiceValue",
                            "name",
                            "label",
                            "message",
                            "value",
                            "choiceCode",
                            "code",
                        )
                        if choice.get(key) not in (None, "")
                    ),
                    None,
                )
            else:
                value = choice
            if value not in (None, ""):
                displayed.append(_json_safe(value))
        if len(displayed) == 1:
            return displayed[0]
        if displayed:
            return displayed

    return _nested_display_value(field.get("fieldValue"))


def build_choice_value_maps(
    metadata_payload: Mapping[str, Any],
) -> dict[str, dict[str, str]]:
    """Index documented metadata choiceCode values by field code and name."""

    data = _response_data(metadata_payload)
    if not isinstance(data, Mapping):
        return {}
    fields = data.get("fields")
    if not isinstance(fields, Sequence) or isinstance(
        fields, (str, bytes, bytearray)
    ):
        return {}

    result: dict[str, dict[str, str]] = {}
    for field in fields:
        if not isinstance(field, Mapping):
            continue
        choices = field.get("choiceValues")
        if not isinstance(choices, Sequence) or isinstance(
            choices, (str, bytes, bytearray)
        ):
            continue
        choice_map: dict[str, str] = {}
        for choice in choices:
            if not isinstance(choice, Mapping):
                continue
            choice_code = _as_identifier(choice.get("choiceCode"))
            choice_value = choice.get("choiceValue")
            if choice_code and choice_value not in (None, ""):
                choice_map[choice_code] = str(choice_value).strip()
        if not choice_map:
            continue
        field_code = _as_identifier(field.get("fieldCode"))
        field_name = _normalised_name(field.get("fieldName"))
        if field_code:
            result[f"code:{field_code}"] = choice_map
        if field_name:
            result[f"name:{field_name}"] = choice_map
    return result


def _resolved_field_display_value(
    field: Mapping[str, Any],
    choice_value_maps: Mapping[str, Mapping[str, str]] | None,
) -> Any:
    displayed = _field_display_value(field)
    if not choice_value_maps:
        return displayed
    field_code = _as_identifier(field.get("fieldCode"))
    field_name = _normalised_name(field.get("fieldName"))
    choices = (
        choice_value_maps.get(f"code:{field_code}") if field_code else None
    ) or (choice_value_maps.get(f"name:{field_name}") if field_name else None)
    if not choices:
        return displayed

    def resolve(value: Any) -> Any:
        if value in (None, ""):
            return value
        identifier = _as_identifier(value)
        return choices.get(identifier, value) if identifier else value

    if isinstance(displayed, Sequence) and not isinstance(
        displayed, (str, bytes, bytearray)
    ):
        return [resolve(value) for value in displayed]
    return resolve(displayed)


def _record_fields(record: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    fields = record.get("fields")
    if not isinstance(fields, Sequence) or isinstance(fields, (str, bytes, bytearray)):
        return []
    return [field for field in fields if isinstance(field, Mapping)]


def _find_field(
    record: Mapping[str, Any], names: Iterable[str]
) -> Mapping[str, Any] | None:
    wanted = {_normalised_name(name) for name in names}
    for field in _record_fields(record):
        if _normalised_name(field.get("fieldName")) in wanted:
            return field
    return None


def _field_provenance(
    field: Mapping[str, Any] | None,
    choice_value_maps: Mapping[str, Mapping[str, str]] | None = None,
) -> dict[str, Any] | None:
    if field is None:
        return None
    return {
        "field_code": _as_identifier(field.get("fieldCode")),
        "field_name": str(field.get("fieldName") or ""),
        "field_type": _json_safe(field.get("fieldType")),
        "value": _resolved_field_display_value(field, choice_value_maps),
    }


def normalize_mould_record(
    record: Mapping[str, Any],
    *,
    choice_value_maps: Mapping[str, Mapping[str, str]] | None = None,
) -> dict[str, Any]:
    """Map one custom-object row to the stable WJ board contract."""

    source_fields: dict[str, dict[str, Any]] = {}
    values: dict[str, Any] = {}
    warnings: list[str] = []
    for key, names in PARENT_FIELD_NAMES.items():
        field = _find_field(record, names)
        provenance = _field_provenance(field, choice_value_maps)
        if provenance is not None:
            source_fields[key] = provenance
            values[key] = provenance["value"]
        else:
            values[key] = None

    instance_id = _as_identifier(
        record.get("instanceId") or record.get("id") or record.get("instance_id")
    )
    mould_code = values["mould_code"] or record.get("mainFieldValue") or record.get(
        "instanceCode"
    )
    location_code = normalize_location(values["location"])
    location_kind = classify_location(location_code)
    machine_match = _MACHINE_CODE_RE.match(location_code or "")
    location = {
        "id": None,
        "code": location_code,
        "label": location_code,
        "kind": location_kind,
        "machine_number": (
            int(machine_match.group("number")) if machine_match else None
        ),
        "parent_code": None,
        "parent_label": None,
        "zone_code": (
            location_code[0] if location_code and location_kind == "storage" else None
        ),
        "zone_label": (
            location_code[0] if location_code and location_kind == "storage" else None
        ),
        "level": None,
        "mould_count": 1 if location_code else 0,
        "conflict": False,
    }
    record_updated_at = _timestamp_iso(record.get("updatedAt"))
    if record.get("updatedAt") not in (None, "") and record_updated_at is None:
        warnings.append("invalid_record_updated_at")
    if not instance_id:
        warnings.append("missing_instance_id")
    if not location_code:
        warnings.append("current_location_missing")

    acquired_at = _timestamp_iso(values["acquired_at"])
    if values["acquired_at"] not in (None, "") and acquired_at is None:
        acquired_at = values["acquired_at"]
        warnings.append("acquired_at_not_epoch")

    return {
        "instance_id": instance_id,
        "object_code": str(record.get("objectCode") or MOULD_OBJECT_CODE),
        "mould_code": _json_safe(mould_code),
        "asset_code": _json_safe(values["asset_code"]),
        "name": _json_safe(values["name"]),
        "drawing_no": _json_safe(values["drawing_no"]),
        "model": _json_safe(values["model"]),
        "status": _json_safe(values["status"]),
        "classification": _json_safe(values["classification"]),
        "cavity_count": _json_safe(values["cavity_count"]),
        "manufacturer": _json_safe(values["manufacturer"]),
        "acquired_at": _json_safe(acquired_at),
        "serial_no": _json_safe(values["serial_no"]),
        "product_photo": _json_safe(values["product_photo"]),
        "cover_file_id": next(iter(_attachment_ids(values["product_photo"])), None),
        "location": location,
        "location_code": location_code,
        "location_kind": location_kind,
        "final_changed_at": record_updated_at,
        "final_changed_at_source": (
            "blacklake.custom_object.updatedAt" if record_updated_at else None
        ),
        "record_updated_at": record_updated_at,
        "position_changed_at": None,
        "position_changed_at_source": None,
        "time_quality": "record_only" if record_updated_at else "unknown",
        "source_fields": source_fields,
        "warnings": _unique_warnings(warnings),
    }


def normalize_child_record(record: Mapping[str, Any]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    field_provenance: dict[str, Any] = {}
    for field in _record_fields(record):
        field_name = str(field.get("fieldName") or field.get("fieldCode") or "").strip()
        if not field_name:
            continue
        value = _field_display_value(field)
        if field_name in fields:
            existing = fields[field_name]
            fields[field_name] = (
                existing + [value]
                if isinstance(existing, list)
                else [existing, value]
            )
        else:
            fields[field_name] = value
        field_provenance[field_name] = {
            "field_code": _as_identifier(field.get("fieldCode")),
            "field_type": _json_safe(field.get("fieldType")),
        }

    return {
        "instance_id": _as_identifier(record.get("instanceId") or record.get("id")),
        "object_code": str(record.get("objectCode") or ""),
        "record_code": _json_safe(
            record.get("mainFieldValue") or record.get("instanceCode")
        ),
        "created_at": _timestamp_iso(record.get("createdAt")),
        "updated_at": _timestamp_iso(record.get("updatedAt")),
        "fields": fields,
        "field_provenance": field_provenance,
    }


def _named_history_value(
    record: Mapping[str, Any], names: Iterable[str], default: Any = None
) -> Any:
    fields = record.get("fields")
    if not isinstance(fields, Mapping):
        return default
    wanted = {_normalised_name(name) for name in names}
    for field_name, value in fields.items():
        if _normalised_name(field_name) in wanted:
            return value
    return default


def _nullable_number(value: Any) -> int | float | None:
    if value in (None, "") or isinstance(value, bool):
        return None
    if isinstance(value, str):
        value = value.replace(",", "").strip()
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return int(number) if number.is_integer() else number


def _attachment_ids(value: Any) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, Mapping):
        value = [value]
    elif not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        value = [value]
    result: list[str] = []
    for item in value:
        if isinstance(item, Mapping):
            identifier = _as_identifier(
                item.get("id") or item.get("fileId") or item.get("value")
            )
        else:
            identifier = _as_identifier(item)
        if identifier:
            result.append(identifier)
    return list(dict.fromkeys(result))


def normalize_history_record(
    history_key: str, record: Mapping[str, Any]
) -> dict[str, Any]:
    """Expose stable screen fields while retaining the fieldName source map."""

    base = normalize_child_record(record)
    if history_key == "movement_history":
        occurred_raw = _named_history_value(
            base, MOVEMENT_FIELD_NAMES["occurred_at"]
        )
        return {
            **base,
            "id": base["instance_id"],
            "record_code": _named_history_value(
                base, MOVEMENT_FIELD_NAMES["record_code"], base["record_code"]
            ),
            "occurred_at": _timestamp_iso(occurred_raw) or base["created_at"],
            "from_location": normalize_location(
                _named_history_value(base, MOVEMENT_FIELD_NAMES["from_location"])
            ),
            "to_location": normalize_location(
                _named_history_value(base, MOVEMENT_FIELD_NAMES["to_location"])
            ),
            "reason": _named_history_value(base, MOVEMENT_FIELD_NAMES["reason"]),
            "operator_name": _named_history_value(
                base, MOVEMENT_FIELD_NAMES["operator_name"]
            ),
            "time_quality": (
                "child_field"
                if occurred_raw not in (None, "")
                else "record_created_at"
            ),
        }

    if history_key == "production_history":
        year = _nullable_number(
            _named_history_value(base, PRODUCTION_FIELD_NAMES["year"])
        )
        month = _nullable_number(
            _named_history_value(base, PRODUCTION_FIELD_NAMES["month"])
        )
        period = _named_history_value(base, PRODUCTION_FIELD_NAMES["period"])
        if not period and year is not None:
            period = f"{int(year):04d}" + (
                f"-{int(month):02d}" if month is not None else ""
            )
        return {
            **base,
            "id": base["instance_id"],
            "period": period,
            "year": int(year) if year is not None else None,
            "month": int(month) if month is not None else None,
            "quantity": _nullable_number(
                _named_history_value(base, PRODUCTION_FIELD_NAMES["quantity"])
            ),
            "cumulative_quantity": _nullable_number(
                _named_history_value(
                    base, PRODUCTION_FIELD_NAMES["cumulative_quantity"]
                )
            ),
            "unit": _named_history_value(base, PRODUCTION_FIELD_NAMES["unit"]),
            "recorded_at": _timestamp_iso(
                _named_history_value(base, PRODUCTION_FIELD_NAMES["recorded_at"])
            )
            or base["created_at"],
        }

    if history_key == "repair_history":
        return {
            **base,
            "id": base["instance_id"],
            "record_code": _named_history_value(
                base, REPAIR_FIELD_NAMES["record_code"], base["record_code"]
            ),
            "requested_at": _timestamp_iso(
                _named_history_value(base, REPAIR_FIELD_NAMES["requested_at"])
            ),
            "started_at": _timestamp_iso(
                _named_history_value(base, REPAIR_FIELD_NAMES["started_at"])
            ),
            "finished_at": _timestamp_iso(
                _named_history_value(base, REPAIR_FIELD_NAMES["finished_at"])
            ),
            "type": _named_history_value(base, REPAIR_FIELD_NAMES["type"]),
            "content": _named_history_value(base, REPAIR_FIELD_NAMES["content"]),
            "vendor": _named_history_value(base, REPAIR_FIELD_NAMES["vendor"]),
            "creator_name": _named_history_value(
                base, REPAIR_FIELD_NAMES["creator_name"]
            ),
            "cumulative_output_amount": _nullable_number(
                _named_history_value(
                    base, REPAIR_FIELD_NAMES["cumulative_output_amount"]
                )
            ),
            "attachment_ids": _attachment_ids(
                _named_history_value(base, REPAIR_FIELD_NAMES["attachment_ids"])
            ),
        }

    return base


def normalize_history_records(
    history_key: str, record: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """Expand one BLACKLAKE child row into dashboard history rows.

    WJ's production child object stores one row per year with ``1月`` through
    ``12月`` columns.  The public dashboard contract is monthly, so expand only
    populated month columns and calculate a deterministic year-to-date total.
    Other child-object rows retain their existing one-row contract.
    """

    normalized = normalize_history_record(history_key, record)
    if history_key != "production_history":
        return [normalized]

    year = normalized.get("year")
    if not isinstance(year, int):
        return [normalized]

    monthly_rows: list[dict[str, Any]] = []
    running_total: int | float = 0
    for month, names in PRODUCTION_MONTH_FIELD_NAMES.items():
        quantity = _nullable_number(_named_history_value(normalized, names))
        if quantity is None:
            continue
        running_total += quantity
        monthly_rows.append(
            {
                **normalized,
                "id": f"{normalized['id']}-{month:02d}",
                "period": f"{year:04d}-{month:02d}",
                "month": month,
                "quantity": quantity,
                "cumulative_quantity": running_total,
                "unit": normalized.get("unit") or "Shot",
            }
        )

    if monthly_rows:
        return monthly_rows

    annual_total = normalized.get("cumulative_quantity")
    if normalized.get("quantity") is None and annual_total is not None:
        normalized["quantity"] = annual_total
    if annual_total is not None and not normalized.get("unit"):
        normalized["unit"] = "Shot"
    return [normalized]


def continuous_production_history(
    records: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Return production rows with one continuous, auditable running total.

    BLACKLAKE stores WJ production in one child row per year, so each source
    row's calculated cumulative value starts again in January.  Preserve that
    source value separately and derive the dashboard cumulative value only by
    adding the monthly quantities in chronological order.
    """

    def sort_key(row: Mapping[str, Any]) -> tuple[int, int, str, str]:
        year = row.get("year")
        month = row.get("month")
        return (
            year if isinstance(year, int) else 9999,
            month if isinstance(month, int) else 13,
            str(row.get("period") or ""),
            str(row.get("id") or ""),
        )

    result: list[dict[str, Any]] = []
    running_total: int | float = 0
    for source in sorted(records, key=sort_key):
        row = dict(source)
        source_cumulative = row.get("source_cumulative_quantity")
        if source_cumulative is None:
            source_cumulative = row.get("cumulative_quantity")
        quantity = row.get("quantity")
        row["source_cumulative_quantity"] = source_cumulative
        if (
            isinstance(quantity, (int, float))
            and not isinstance(quantity, bool)
        ):
            running_total += quantity
            row["cumulative_quantity"] = running_total
            row["cumulative_basis"] = "monthly_quantity_running_sum"
        result.append(row)
    return result


def _infer_movement_sources(
    records: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Fill the previous destination when WJ's child row omits a source field."""

    result = [dict(record) for record in records]
    ordered_indexes = sorted(
        range(len(result)),
        key=lambda index: str(result[index].get("occurred_at") or ""),
    )
    previous_destination: Any = None
    for index in ordered_indexes:
        row = result[index]
        if row.get("from_location") in (None, "") and previous_destination not in (
            None,
            "",
        ):
            row["from_location"] = previous_destination
        if row.get("to_location") not in (None, ""):
            previous_destination = row["to_location"]
    return result


def _response_data(payload: Mapping[str, Any]) -> Any:
    return payload.get("data", payload)


def _page_rows(payload: Mapping[str, Any]) -> tuple[list[dict[str, Any]], int | None]:
    data = _response_data(payload)
    if isinstance(data, Mapping):
        rows = data.get("list") or data.get("records") or data.get("rows") or []
        raw_total = data.get("total")
    elif isinstance(data, Sequence) and not isinstance(data, (str, bytes, bytearray)):
        rows = data
        raw_total = len(rows)
    else:
        rows = []
        raw_total = None
    try:
        total = int(raw_total) if raw_total is not None else None
    except (TypeError, ValueError):
        total = None
    return [dict(row) for row in rows if isinstance(row, Mapping)], total


def _detail_record(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    candidates: list[Any] = [_response_data(payload)]
    for _depth in range(3):
        next_candidates: list[Any] = []
        for data in candidates:
            if not isinstance(data, Mapping):
                continue
            if data.get("instanceId") or data.get("fields"):
                return dict(data)
            for key in ("instance", "record", "object", "detail", "data"):
                candidate = data.get(key)
                if isinstance(candidate, Mapping):
                    next_candidates.append(candidate)
        candidates = next_candidates
    return None


def _post_blacklake(endpoint: str, body: Mapping[str, Any]) -> dict[str, Any]:
    try:
        token = get_access_token()
    except Exception as exc:
        raise MouldServiceError(_safe_exception_message(exc)) from None

    response = None
    for refresh in (False, True):
        url = f"{MES_BASE_URL}{endpoint}?access_token={quote(str(token), safe='')}"
        try:
            response = requests.post(url, json=dict(body), timeout=(10, 45))
            if response.status_code == 401 and not refresh:
                try:
                    token = get_access_token(force_refresh=True)
                except Exception as exc:
                    raise MouldServiceError(_safe_exception_message(exc)) from None
                continue
            response.raise_for_status()
            payload = response.json()
        except (requests.RequestException, ValueError) as exc:
            raise MouldServiceError(_safe_exception_message(exc)) from None

        if not isinstance(payload, Mapping):
            raise MouldServiceError("BLACKLAKE returned an invalid JSON object.")
        code = payload.get("code")
        if code not in (None, 200, "200"):
            safe_message = _safe_exception_message(
                RuntimeError(payload.get("message") or "BLACKLAKE custom-object error")
            )
            raise MouldServiceError(safe_message)
        return copy.deepcopy(dict(payload))

    status_code = response.status_code if response is not None else 502
    raise MouldServiceError(f"BLACKLAKE authentication failed ({status_code}).")


def _fetch_all_pages(
    endpoint: str,
    body: Mapping[str, Any],
    *,
    page_size: int = PAGE_SIZE,
    max_pages: int = MAX_PAGES,
) -> tuple[list[dict[str, Any]], list[str]]:
    rows: list[dict[str, Any]] = []
    warnings: list[str] = []
    seen_ids: set[str] = set()
    seen_pages: set[str] = set()
    expected_total: int | None = None

    for page in range(1, max_pages + 1):
        payload = _post_blacklake(endpoint, {**body, "page": page, "size": page_size})
        page_rows, total = _page_rows(payload)
        # BLACKLAKE deployments sometimes return total=0 while still returning
        # rows, so only a positive total is authoritative.
        if total is not None and total > 0:
            if expected_total is None:
                expected_total = total
            elif total != expected_total:
                warnings.append("upstream_total_changed_during_pagination")
                break
        if not page_rows:
            if expected_total is not None and len(rows) < expected_total:
                warnings.append("upstream_pagination_ended_early")
            break

        signature = json.dumps(page_rows, sort_keys=True, separators=(",", ":"), default=str)
        if signature in seen_pages:
            warnings.append("upstream_repeated_page")
            break
        seen_pages.add(signature)

        for row in page_rows:
            row_id = _as_identifier(row.get("instanceId") or row.get("id"))
            if row_id and row_id in seen_ids:
                warnings.append("upstream_duplicate_instance_removed")
                continue
            if row_id:
                seen_ids.add(row_id)
            rows.append(row)

        if expected_total is not None and len(rows) >= expected_total:
            break
        if len(page_rows) < page_size:
            if expected_total is not None and len(rows) < expected_total:
                warnings.append("upstream_short_page")
            break
    else:
        warnings.append("upstream_pagination_safety_limit_reached")

    return rows, _unique_warnings(warnings)


def search_mould_records(quick_search: str = "") -> tuple[list[dict[str, Any]], list[str]]:
    body: dict[str, Any] = {"objectCode": MOULD_OBJECT_CODE}
    if quick_search:
        body["singleTextCondition"] = quick_search
    return _fetch_all_pages(CUSTOM_OBJECT_LIST_ENDPOINT, body)


def fetch_resource_mould_records(
    entity_link_code: str = "",
) -> tuple[list[dict[str, Any]], list[str]]:
    """Fetch standard mould resources, optionally scoped by entityLinkCode."""

    body: dict[str, Any] = {}
    if entity_link_code:
        body["entityLinkCode"] = entity_link_code
    return _fetch_all_pages(RESOURCE_MOULD_LIST_ENDPOINT, body)


def fetch_resource_mould_detail(resource_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"\d{1,32}", str(resource_id or "")):
        raise ValueError("resource_id must be a numeric BLACKLAKE identifier.")
    payload = _post_blacklake(
        RESOURCE_MOULD_DETAIL_ENDPOINT,
        {"id": int(resource_id)},
    )
    candidates: list[Any] = [_response_data(payload)]
    for _depth in range(3):
        nested_candidates: list[Any] = []
        for data in candidates:
            if not isinstance(data, Mapping):
                continue
            if data.get("id") not in (None, ""):
                return dict(data)
            for key in ("resource", "record", "object", "detail", "data"):
                nested = data.get(key)
                if isinstance(nested, Mapping):
                    nested_candidates.append(nested)
        candidates = nested_candidates
    record = _detail_record(payload)
    if record is None:
        raise MouldServiceError("BLACKLAKE standard mould detail was empty.")
    return record


def _resource_enum(value: Any) -> Any:
    if not isinstance(value, Mapping):
        return _json_safe(value)
    return {
        "code": _json_safe(value.get("code")),
        "label": _json_safe(
            value.get("message") or value.get("name") or value.get("label")
        ),
    }


def normalize_resource_mould(record: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize only additive standard-resource fields used by the WJ UI."""

    return {
        "resource_id": _as_identifier(record.get("id")),
        "entity_link_code": str(record.get("entityLinkCode") or "").strip(),
        "current_output_amount": _nullable_number(record.get("currentOutputAmount")),
        "current_output_batch_amount": _nullable_number(
            record.get("currentOutputBatchAmount")
        ),
        "lifespan_status": _resource_enum(record.get("lifespanStatus")),
        "maintenance_status": _resource_enum(record.get("maintenanceStatus")),
        "repair_status": _resource_enum(record.get("repairStatus")),
        "resource_status": _resource_enum(record.get("status")),
        "on_way_status": _resource_enum(record.get("onWayStatus")),
        "lock_status": _resource_enum(record.get("lockStatus")),
        "resource_cover_file_id": _as_identifier(record.get("coverFileId")),
        # Resource locations are preserved for diagnostics only.  The custom
        # object current-location field is the operator-maintained authority.
        "resource_locations": _json_safe(record.get("locations") or []),
        "resource_record_updated_at": _timestamp_iso(record.get("updatedAt")),
    }


def _entity_link_match_key(value: Any) -> str:
    return str(value or "").strip().casefold()


def enrich_mould_records(
    moulds: Sequence[Mapping[str, Any]],
    resource_records: Sequence[Mapping[str, Any]],
    *,
    source: str = "blacklake.resource_mold.list",
    source_field_overrides: Mapping[str, str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    """Join custom assets to standard resources without guessing another key."""

    resource_index: dict[
        str, list[tuple[dict[str, Any], dict[str, str]]]
    ] = defaultdict(list)
    for raw_resource in resource_records:
        resource = normalize_resource_mould(raw_resource)
        match_key = _entity_link_match_key(resource.get("entity_link_code"))
        if match_key:
            field_sources = {
                normalized_name: (
                    source_field_overrides.get(normalized_name, source)
                    if source_field_overrides
                    else source
                )
                for normalized_name, raw_name in RESOURCE_FIELD_NAMES.items()
                if raw_name in raw_resource
            }
            resource_index[match_key].append((resource, field_sources))

    warnings: list[str] = []
    matched = 0
    unmatched = 0
    duplicate = 0
    missing_key = 0
    results: list[dict[str, Any]] = []
    for raw_mould in moulds:
        mould = copy.deepcopy(dict(raw_mould))
        asset_code = str(mould.get("asset_code") or "").strip()
        match_key = _entity_link_match_key(asset_code)
        candidates = resource_index.get(match_key, []) if match_key else []
        provenance: dict[str, Any] = {
            "source": source,
            "match_rule": "custom.asset_code == resource.entityLinkCode",
            "asset_code": asset_code or None,
            "matched": False,
            "candidate_count": len(candidates),
            "resource_id": None,
            "resource_record_updated_at": None,
            "field_sources": {},
        }

        if not match_key:
            missing_key += 1
            warning = (
                "resource_enrichment_missing_asset_code:"
                f"{mould.get('instance_id') or 'unknown'}"
            )
        elif not candidates:
            unmatched += 1
            warning = f"resource_enrichment_unmatched:{asset_code}"
        elif len(candidates) > 1:
            duplicate += 1
            warning = f"resource_enrichment_duplicate:{asset_code}:{len(candidates)}"
        else:
            resource, field_sources = candidates[0]
            matched += 1
            warning = ""
            provenance.update(
                {
                    "matched": True,
                    "resource_id": resource.get("resource_id"),
                    "resource_record_updated_at": resource.get(
                        "resource_record_updated_at"
                    ),
                    "field_sources": field_sources,
                }
            )
            for key in (
                "resource_id",
                "entity_link_code",
                "current_output_amount",
                "current_output_batch_amount",
                "lifespan_status",
                "maintenance_status",
                "repair_status",
                "resource_status",
                "on_way_status",
                "lock_status",
                "resource_cover_file_id",
                "resource_locations",
                "resource_record_updated_at",
            ):
                mould[key] = resource.get(key)
            # Prefer the operator-managed custom photo when present, but make the
            # standard resource cover available as a deterministic fallback.
            if not mould.get("cover_file_id"):
                mould["cover_file_id"] = resource.get("resource_cover_file_id")

        if warning:
            warnings.append(warning)
            mould["warnings"] = _unique_warnings(
                [*(mould.get("warnings") or []), warning]
            )
        mould["resource_provenance"] = provenance
        results.append(mould)

    stats = {
        "source": source,
        "match_rule": "custom.asset_code == resource.entityLinkCode",
        "custom_count": len(moulds),
        "resource_count": len(resource_records),
        "matched_count": matched,
        "unmatched_count": unmatched,
        "duplicate_count": duplicate,
        "missing_key_count": missing_key,
        "complete": matched == len(moulds),
    }
    return results, stats, _unique_warnings(warnings)


def fetch_mould_metadata(*, use_cache: bool = True) -> dict[str, Any]:
    if use_cache:
        cached = cache.get(METADATA_CACHE_KEY)
        if isinstance(cached, Mapping):
            return copy.deepcopy(dict(cached))
    payload = _post_blacklake(
        CUSTOM_OBJECT_METADATA_ENDPOINT,
        {"objectCode": MOULD_OBJECT_CODE},
    )
    if use_cache:
        cache.set(METADATA_CACHE_KEY, payload, timeout=METADATA_CACHE_SECONDS)
    return payload


def _find_son_objects(value: Any) -> list[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        son_objects = value.get("sonObjects")
        if isinstance(son_objects, Sequence) and not isinstance(
            son_objects, (str, bytes, bytearray)
        ):
            return [item for item in son_objects if isinstance(item, Mapping)]
        for nested in value.values():
            found = _find_son_objects(nested)
            if found:
                return found
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for nested in value:
            found = _find_son_objects(nested)
            if found:
                return found
    return []


def discover_child_objects(metadata_payload: Mapping[str, Any]) -> dict[str, dict[str, str]]:
    discovered: dict[str, dict[str, str]] = {}
    wanted = {
        canonical: {_normalised_name(name) for name in names}
        for canonical, names in CHILD_OBJECT_NAMES.items()
    }
    for item in _find_son_objects(_response_data(metadata_payload)):
        object_info = item.get("object") if isinstance(item.get("object"), Mapping) else item
        object_name = str(object_info.get("objectName") or item.get("objectName") or "").strip()
        object_code = str(object_info.get("objectCode") or item.get("objectCode") or "").strip()
        if not object_name or not object_code:
            continue
        normalized = _normalised_name(object_name)
        for canonical, names in wanted.items():
            if normalized in names:
                discovered[canonical] = {
                    "object_name": object_name,
                    "object_code": object_code,
                }
                break
    return discovered


def _unique_location_occupants(
    occupants: Sequence[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Deduplicate repeated payload rows without merging distinct moulds."""

    unique: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    for index, occupant in enumerate(occupants):
        identity = str(
            occupant.get("instance_id")
            or occupant.get("asset_code")
            or occupant.get("mould_code")
            or f"row:{index}"
        ).strip()
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(occupant)
    return unique


def _machine_rows(moulds: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    by_location: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for mould in moulds:
        location = str(mould.get("location_code") or "")
        if location:
            by_location[location].append(mould)

    machines: list[dict[str, Any]] = []
    for location_code in sorted(
        MACHINE_LOCATION_CODES,
        key=lambda value: int(_MACHINE_CODE_RE.match(value).group("number")),
    ):
        match = _MACHINE_CODE_RE.match(location_code)
        if match is None:
            continue
        number = int(match.group("number"))
        tonnage = match.group("tonnage")
        occupants = _unique_location_occupants(by_location.get(location_code, []))
        machines.append(
            {
                "number": number,
                "device_code": f"{tonnage}-{number}",
                "location_code": location_code,
                "label": f"{number}호기 {tonnage}",
                "tonnage": tonnage,
                "mould_count": len(occupants),
                "conflict": len(occupants) > 1,
                "mould_instance_ids": [row.get("instance_id") for row in occupants],
            }
        )
    return machines


def _location_rows(moulds: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for mould in moulds:
        location = str(mould.get("location_code") or "").strip()
        if location:
            grouped[location].append(mould)

    rows: list[dict[str, Any]] = []
    all_codes = set(grouped) | set(MACHINE_LOCATION_CODES)
    for code in sorted(all_codes):
        occupants = _unique_location_occupants(grouped.get(code, []))
        machine_match = _MACHINE_CODE_RE.match(code)
        location_kind = classify_location(code)
        rows.append(
            {
                "code": code,
                "label": code,
                "kind": location_kind,
                "machine_number": (
                    int(machine_match.group("number")) if machine_match else None
                ),
                "mould_count": len(occupants),
                "conflict": (
                    location_kind in {"machine", "storage"}
                    and len(occupants) > 1
                ),
                "mould_instance_ids": [row.get("instance_id") for row in occupants],
            }
        )
    return rows


_REPAIR_ACTIVE_MARKERS = (
    "维修中",
    "維修中",
    "修理中",
    "待维修",
    "待維修",
    "待修",
    "报修",
    "報修",
    "故障",
    "inrepair",
    "underrepair",
    "repairing",
    "repairinprogress",
    "repairpending",
    "수리중",
    "수리대기",
    "수리필요",
    "고장",
)
_REPAIR_ACTIVE_EXACT = frozenset(("维修", "維修", "修理", "repair", "수리"))
_REPAIR_INACTIVE_MARKERS = (
    "无需维修",
    "無需維修",
    "不需维修",
    "不需維修",
    "维修完成",
    "維修完成",
    "已维修",
    "已維修",
    "修理完成",
    "repaircompleted",
    "repairdone",
    "norepairrequired",
    "수리완료",
    "수리없음",
    "수리불필요",
)
_REPAIR_BROAD_MARKERS = ("维修", "維修", "修理", "repair", "수리")

_MAINTENANCE_ACTIVE_MARKERS = (
    "维保中",
    "維保中",
    "维护中",
    "維護中",
    "保养中",
    "保養中",
    "检修中",
    "檢修中",
    "待维保",
    "待維保",
    "待保养",
    "待保養",
    "待检修",
    "待檢修",
    "undermaintenance",
    "maintaining",
    "maintenanceinprogress",
    "maintenancepending",
    "정비중",
    "정비대기",
    "보전중",
    "보전대기",
    "점검중",
)
_MAINTENANCE_ACTIVE_EXACT = frozenset(
    (
        "维保",
        "維保",
        "维护",
        "維護",
        "保养",
        "保養",
        "检修",
        "檢修",
        "maintenance",
        "정비",
        "보전",
        "점검",
    )
)
_MAINTENANCE_INACTIVE_MARKERS = (
    "无需维保",
    "無需維保",
    "无需保养",
    "無需保養",
    "不需保养",
    "不需保養",
    "维保完成",
    "維保完成",
    "保养完成",
    "保養完成",
    "已保养",
    "已保養",
    "maintenancecompleted",
    "maintenancedone",
    "nomaintenancerequired",
    "정비완료",
    "정비없음",
    "정비불필요",
)
_MAINTENANCE_BROAD_MARKERS = (
    "维保",
    "維保",
    "维护",
    "維護",
    "保养",
    "保養",
    "检修",
    "檢修",
    "maintenance",
    "정비",
    "보전",
    "점검",
)


def _status_values(value: Any) -> list[str]:
    if value in (None, ""):
        return []
    if isinstance(value, Mapping):
        result: list[str] = []
        for key in ("label", "message", "name", "code", "value"):
            item = value.get(key)
            if item not in (None, ""):
                result.extend(_status_values(item))
        return list(dict.fromkeys(result))
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        result = []
        for item in value:
            result.extend(_status_values(item))
        return list(dict.fromkeys(result))
    return [str(value).strip()] if str(value).strip() else []


def _status_signal(
    value: Any,
    *,
    active_markers: Sequence[str],
    active_exact: frozenset[str],
    inactive_markers: Sequence[str],
    broad_markers: Sequence[str],
    warn_code_only: bool = False,
) -> tuple[bool, bool]:
    """Return ``(active, ambiguous)`` for a repair/maintenance status."""

    normalized = [_normalised_name(item) for item in _status_values(value)]
    text_values = [item for item in normalized if item and not item.isdigit()]
    if any(marker in item for item in text_values for marker in inactive_markers):
        return False, False
    if any(marker in item for item in text_values for marker in active_markers):
        return True, False
    if any(item in active_exact for item in text_values):
        return True, False
    if any(marker in item for item in text_values for marker in broad_markers):
        return False, True
    if warn_code_only and normalized and not text_values:
        return False, True
    return False, False


def _on_way_signal(
    value: Any, *, allow_list_numeric_contract: bool
) -> tuple[bool, bool]:
    if isinstance(value, Mapping):
        label_values: list[str] = []
        for key in ("label", "message", "name"):
            label_values.extend(_status_values(value.get(key)))
        code_values = _status_values(value.get("code"))
    else:
        raw_values = _status_values(value)
        label_values = [item for item in raw_values if not item.strip().isdigit()]
        code_values = [item for item in raw_values if item.strip().isdigit()]

    text_values = [_normalised_name(item) for item in label_values if item]
    if any(
        marker in item
        for item in text_values
        for marker in (
            "厂外",
            "廠外",
            "在途",
            "외부",
            "반출",
            "이동중",
            "offsite",
            "outside",
            "external",
            "intransit",
        )
    ):
        return True, False
    if any(
        marker in item
        for item in text_values
        for marker in ("厂内", "廠內", "장내", "내부", "inplant")
    ):
        return False, False

    # The list Swagger documents 1=inside, 2=in transit, 3=outside.  The
    # detail Swagger assigns different numeric meanings, so numeric fallback
    # is intentionally allowed only for a field sourced from the list API.
    codes = {_normalised_name(item) for item in code_values if item}
    if not text_values and allow_list_numeric_contract:
        if codes & {"2", "3"}:
            return True, False
        if "1" in codes:
            return False, False
    return False, bool(text_values or codes)


def _is_offsite(mould: Mapping[str, Any]) -> tuple[bool, bool]:
    status = _normalised_name(mould.get("status"))
    location = _normalised_name(mould.get("location_code"))
    if any(
        marker in status or marker in location
        for marker in (
            "厂外",
            "廠外",
            "在途",
            "外借",
            "외부",
            "외주",
            "반출",
            "offsite",
            "outside",
            "external",
        )
    ):
        return True, False
    resource_provenance = mould.get("resource_provenance")
    field_sources = (
        resource_provenance.get("field_sources")
        if isinstance(resource_provenance, Mapping)
        else None
    )
    on_way_source = (
        field_sources.get("on_way_status")
        if isinstance(field_sources, Mapping)
        else None
    )
    return _on_way_signal(
        mould.get("on_way_status"),
        allow_list_numeric_contract=on_way_source == "blacklake.resource_mold.list",
    )


def _summary_category(mould: Mapping[str, Any]) -> tuple[str, list[str]]:
    """Assign exactly one board-summary category using the documented priority."""

    instance_id = mould.get("instance_id") or "unknown"
    warnings: list[str] = []
    custom_repair, custom_repair_ambiguous = _status_signal(
        mould.get("status"),
        active_markers=_REPAIR_ACTIVE_MARKERS,
        active_exact=_REPAIR_ACTIVE_EXACT,
        inactive_markers=_REPAIR_INACTIVE_MARKERS,
        broad_markers=_REPAIR_BROAD_MARKERS,
    )
    resource_repair, resource_repair_ambiguous = _status_signal(
        mould.get("repair_status"),
        active_markers=_REPAIR_ACTIVE_MARKERS,
        active_exact=_REPAIR_ACTIVE_EXACT,
        inactive_markers=_REPAIR_INACTIVE_MARKERS,
        broad_markers=_REPAIR_BROAD_MARKERS,
        warn_code_only=True,
    )
    if custom_repair or resource_repair:
        return "repair", warnings
    if custom_repair_ambiguous or resource_repair_ambiguous:
        warnings.append(f"summary_ambiguous_repair_status:{instance_id}")

    custom_maintenance, custom_maintenance_ambiguous = _status_signal(
        mould.get("status"),
        active_markers=_MAINTENANCE_ACTIVE_MARKERS,
        active_exact=_MAINTENANCE_ACTIVE_EXACT,
        inactive_markers=_MAINTENANCE_INACTIVE_MARKERS,
        broad_markers=_MAINTENANCE_BROAD_MARKERS,
    )
    resource_maintenance, resource_maintenance_ambiguous = _status_signal(
        mould.get("maintenance_status"),
        active_markers=_MAINTENANCE_ACTIVE_MARKERS,
        active_exact=_MAINTENANCE_ACTIVE_EXACT,
        inactive_markers=_MAINTENANCE_INACTIVE_MARKERS,
        broad_markers=_MAINTENANCE_BROAD_MARKERS,
        warn_code_only=True,
    )
    if custom_maintenance or resource_maintenance:
        return "maintenance", warnings
    if custom_maintenance_ambiguous or resource_maintenance_ambiguous:
        warnings.append(f"summary_ambiguous_maintenance_status:{instance_id}")

    offsite, offsite_ambiguous = _is_offsite(mould)
    if offsite:
        return "offsite", warnings
    if offsite_ambiguous:
        warnings.append(f"summary_ambiguous_on_way_status:{instance_id}")

    if mould.get("location_kind") == "machine":
        return "machine", warnings
    if mould.get("location_kind") == "storage":
        return "storage", warnings
    return "unknown", warnings


def _summarize_moulds(
    moulds: Sequence[dict[str, Any]],
) -> tuple[dict[str, Any], list[str]]:
    counts: Counter[str] = Counter()
    warnings: list[str] = []
    status_counts = Counter(str(row.get("status") or "unknown") for row in moulds)
    for mould in moulds:
        category, category_warnings = _summary_category(mould)
        mould["summary_category"] = category
        if category_warnings:
            mould["warnings"] = _unique_warnings(
                [*(mould.get("warnings") or []), *category_warnings]
            )
            warnings.extend(category_warnings)
        counts[category] += 1

    classified_total = sum(
        counts[key]
        for key in (
            "repair",
            "maintenance",
            "offsite",
            "machine",
            "storage",
            "unknown",
        )
    )
    summary = {
        "total": len(moulds),
        "mounted": counts["machine"],
        "stored": counts["storage"],
        "maintenance": counts["maintenance"],
        "repair": counts["repair"],
        "offsite": counts["offsite"],
        "unknown": counts["unknown"],
        "conflicts": sum(row.get("conflict") for row in _location_rows(moulds)),
        "classified_total": classified_total,
        "reconciled": classified_total == len(moulds),
        "status_counts": dict(sorted(status_counts.items())),
    }
    aggregate_warnings: list[str] = []
    for prefix in (
        "summary_ambiguous_repair_status",
        "summary_ambiguous_maintenance_status",
        "summary_ambiguous_on_way_status",
    ):
        if any(warning.startswith(f"{prefix}:") for warning in warnings):
            aggregate_warnings.append(prefix)
    return summary, aggregate_warnings


def build_mould_board(*, quick_search: str = "") -> dict[str, Any]:
    fetched_at = datetime.now(tz=SHANGHAI).isoformat()
    raw_records, warnings = search_mould_records(quick_search=quick_search)
    metadata_payload: dict[str, Any] = {}
    try:
        metadata_payload = fetch_mould_metadata()
    except MouldServiceError:
        warnings.append("metadata_unavailable")
    choice_value_maps = build_choice_value_maps(metadata_payload)
    moulds = [
        normalize_mould_record(record, choice_value_maps=choice_value_maps)
        for record in raw_records
    ]
    warnings.extend(
        warning for mould in moulds for warning in mould.get("warnings", [])
    )

    resource_capability = False
    resource_stats: dict[str, Any] = {
        "source": "blacklake.resource_mold.list",
        "match_rule": "custom.asset_code == resource.entityLinkCode",
        "custom_count": len(moulds),
        "resource_count": 0,
        "matched_count": 0,
        "unmatched_count": 0,
        "duplicate_count": 0,
        "missing_key_count": 0,
        "complete": False,
        "available": False,
        "fetched_at": fetched_at,
    }
    try:
        resource_records, resource_warnings = fetch_resource_mould_records()
        moulds, resource_stats, _enrichment_warnings = enrich_mould_records(
            moulds,
            resource_records,
        )
        resource_stats.update(
            {
                "available": True,
                "fetched_at": fetched_at,
                "on_way_numeric_contract": (
                    "list only: 1=inside, 2=in_transit, 3=outside; label first"
                ),
            }
        )
        resource_capability = True
        warnings.extend(f"resource:{warning}" for warning in resource_warnings)
        if not resource_stats.get("complete"):
            warnings.append("resource_enrichment_incomplete")
        if resource_stats.get("duplicate_count"):
            warnings.append("resource_enrichment_duplicate_keys")
    except MouldServiceError:
        warnings.append("resource_enrichment_unavailable")

    child_objects = discover_child_objects(metadata_payload)

    source_times = [
        row["record_updated_at"] for row in moulds if row.get("record_updated_at")
    ]
    latest_record_time = max(source_times) if source_times else None
    resource_source_times = [
        row["resource_record_updated_at"]
        for row in moulds
        if row.get("resource_record_updated_at")
    ]
    latest_resource_time = max(resource_source_times) if resource_source_times else None
    latest_source_time = max(
        [value for value in (latest_record_time, latest_resource_time) if value],
        default=None,
    )
    summary, summary_warnings = _summarize_moulds(moulds)
    warnings.extend(summary_warnings)

    capabilities = {
        "basic_detail": True,
        "movement_history": "movement_history" in child_objects,
        "production_history": "production_history" in child_objects,
        "repair_history": "repair_history" in child_objects,
        "position_history": True,
        "file_download": False,
        "resource_enrichment": resource_capability,
        "resource_enrichment_complete": bool(resource_stats.get("complete")),
    }
    if any(not capabilities[key] for key in (
        "movement_history",
        "production_history",
        "repair_history",
    )):
        warnings.append("one_or_more_child_objects_not_discovered")

    return {
        "status": "partial" if warnings else "ok",
        "summary": summary,
        "locations": _location_rows(moulds),
        "machines": _machine_rows(moulds),
        "moulds": moulds,
        "final_changed_at": latest_record_time,
        "final_changed_at_source": (
            "blacklake.custom_object.updatedAt.max" if latest_record_time else None
        ),
        "record_updated_at": latest_record_time,
        "data_freshness": {
            "mode": "live",
            "status": "partial" if warnings else "live",
            "fetched_at": fetched_at,
            "source_latest_at": latest_source_time,
            "source_updated_at": latest_source_time,
            "source": "blacklake.custom_object.list:MOLD001__c+resource_mold.list",
            "custom_object_latest_at": latest_record_time,
            "resource_latest_at": latest_resource_time,
            "timezone": "Asia/Shanghai",
        },
        "capabilities": capabilities,
        "calculation_basis": [
            "Mould rows come from BLACKLAKE custom object MOLD001__c.",
            (
                "Standard resource fields are joined only when custom asset_code "
                "exactly matches resource entityLinkCode (case-insensitive after "
                "trimming)."
            ),
            (
                "Custom-object current location remains authoritative; resource "
                "locations never overwrite it."
            ),
            (
                "Summary categories are mutually exclusive in this priority: "
                "repair, maintenance, offsite, machine, storage, unknown; their "
                "sum equals total."
            ),
            (
                "Repair/maintenance use explicit Korean, Chinese, and English "
                "active-status labels; ambiguous status strings remain in the "
                "next eligible category and emit a warning."
            ),
            (
                "onWayStatus label/message wins over code; numeric fallback uses "
                "only the list contract (1=inside, 2=in transit, 3=outside)."
            ),
            (
                "Machine/storage use the verified WJ custom-location rules after "
                "higher-priority status categories."
            ),
            (
                "final_changed_at is the parent record updatedAt; it is not a "
                "position event time."
            ),
            (
                "resource_record_updated_at is resource freshness only; it is "
                "never a mount/unmount or position-event time."
            ),
        ],
        "warnings": _unique_warnings(warnings),
        "provenance": {
            "parent": {
                "source": "blacklake.custom_object.list",
                "object_code": MOULD_OBJECT_CODE,
                "record_count": len(moulds),
                "fetched_at": fetched_at,
            },
            "resource_enrichment": resource_stats,
        },
    }


def build_mould_location_snapshot() -> dict[str, Any]:
    """Fetch the custom mould list only, for a fast current-position refresh."""

    fetched_at = datetime.now(tz=SHANGHAI).isoformat()
    raw_records, warnings = search_mould_records()
    moulds = [normalize_mould_record(record) for record in raw_records]
    source_times = [
        row["record_updated_at"] for row in moulds if row.get("record_updated_at")
    ]
    latest_record_time = max(source_times) if source_times else None
    summary, summary_warnings = _summarize_moulds(moulds)
    warnings.extend(summary_warnings)
    return {
        "summary": summary,
        "locations": _location_rows(moulds),
        "machines": _machine_rows(moulds),
        "moulds": moulds,
        "final_changed_at": latest_record_time,
        "record_updated_at": latest_record_time,
        "data_freshness": {
            "status": "live",
            "fetched_at": fetched_at,
            "location_refreshed_at": fetched_at,
            "source_latest_at": latest_record_time,
        },
        "warnings": _unique_warnings(warnings),
    }


def _fetch_mould_detail_record(instance_id: str) -> dict[str, Any]:
    payload = _post_blacklake(
        CUSTOM_OBJECT_DETAIL_ENDPOINT,
        {
            "objectCode": MOULD_OBJECT_CODE,
            "instanceId": int(instance_id),
            "includeChildren": True,
            "includeDirectlyRelated": False,
        },
    )
    record = _detail_record(payload)
    if record is None:
        raise MouldServiceError("BLACKLAKE mould detail was empty.")
    return record


def _fetch_child_records(
    *, main_instance_id: str, child_object_code: str
) -> tuple[list[dict[str, Any]], list[str]]:
    return _fetch_all_pages(
        CUSTOM_OBJECT_CHILD_ENDPOINT,
        {
            "mainInstanceId": int(main_instance_id),
            "mainObjectCode": MOULD_OBJECT_CODE,
            "sonObjectCode": child_object_code,
            "includeFormulaField": True,
        },
        page_size=100,
        max_pages=10,
    )


def _log_identifier(record: Mapping[str, Any]) -> str | None:
    return _as_identifier(record.get("logId") or record.get("id"))


def _log_time(record: Mapping[str, Any]) -> int | None:
    for key in ("loggedAt", "operationTime", "logTime", "createdAt", "timestamp"):
        value = _epoch_milliseconds(record.get(key))
        if value is not None:
            return value
    return None


def _fetch_operation_logs(instance_code: str) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    payload = _post_blacklake(
        OPERATION_LOG_LIST_ENDPOINT,
        {
            "objectCode": MOULD_OBJECT_CODE,
            "instanceCode": instance_code,
            "limit": MAX_LOG_DETAILS,
        },
    )
    logs, _total = _page_rows(payload)
    detailed: list[dict[str, Any]] = []
    for log in logs[:MAX_LOG_DETAILS]:
        log_id = _log_identifier(log)
        detail_fields = log.get("detailFields")
        if not detail_fields and log_id:
            try:
                detail_payload = _post_blacklake(
                    OPERATION_LOG_DETAIL_ENDPOINT,
                    {"logId": int(log_id) if log_id.isdigit() else log_id},
                )
                detail_data = _response_data(detail_payload)
                if isinstance(detail_data, Mapping):
                    log = {**log, **dict(detail_data)}
            except MouldServiceError:
                warnings.append(f"operation_log_detail_unavailable:{log_id}")
        canonical = dict(log)
        canonical["logId"] = log_id
        canonical["loggedAt"] = _log_time(log)
        detailed.append(canonical)
    if len(logs) >= MAX_LOG_DETAILS:
        warnings.append("operation_log_limit_reached")
    return detailed, warnings


def _field_value_from_normalized(
    record: Mapping[str, Any], names: Iterable[str]
) -> Any:
    fields = record.get("fields")
    if not isinstance(fields, Mapping):
        return None
    wanted = {_normalised_name(name) for name in names}
    for field_name, value in fields.items():
        if _normalised_name(field_name) in wanted:
            return value
    return None


def _replacement_event_records(
    raw_records: Sequence[Mapping[str, Any]],
    normalized_records: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for raw, normalized in zip(raw_records, normalized_records):
        movement_date = _field_value_from_normalized(normalized, MOVEMENT_DATE_NAMES)
        destination = _field_value_from_normalized(
            normalized, MOVEMENT_DESTINATION_NAMES
        )
        events.append(
            {
                "id": normalized.get("instance_id"),
                "createdAt": _epoch_milliseconds(movement_date)
                or _epoch_milliseconds(raw.get("createdAt")),
                "toLocation": destination,
            }
        )
    return events


def _position_payload(
    *,
    operation_logs: Sequence[Mapping[str, Any]],
    replacement_records: Sequence[Mapping[str, Any]],
    current_location: Any,
    record_updated_at: Any,
) -> dict[str, Any]:
    result = normalize_position_history(
        operation_logs=operation_logs,
        replacement_records=replacement_records,
        current_location=current_location,
        record_updated_at=record_updated_at,
    )
    events = []
    for event in result.get("events", []):
        events.append({**event, "occurred_at": _timestamp_iso(event.get("occurred_at"))})
    return {
        **result,
        "events": events,
        "last_changed_at": _timestamp_iso(result.get("last_changed_at")),
        "record_updated_at": _timestamp_iso(result.get("record_updated_at")),
    }


def _history_provenance(
    *,
    child_info: Mapping[str, str] | None,
    records: Sequence[Mapping[str, Any]],
    fetched_at: str,
) -> dict[str, Any]:
    return {
        "source": "blacklake.custom_object.page_son_object",
        "object_code": child_info.get("object_code") if child_info else None,
        "object_name": child_info.get("object_name") if child_info else None,
        "fetched_at": fetched_at,
        "record_count": len(records),
    }


def build_mould_detail(instance_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"\d{1,32}", str(instance_id or "")):
        raise ValueError("instance_id must be a numeric BLACKLAKE identifier.")

    fetched_at = datetime.now(tz=SHANGHAI).isoformat()
    raw_record = _fetch_mould_detail_record(instance_id)
    warnings: list[str] = []
    metadata_payload: dict[str, Any] = {}
    try:
        metadata_payload = fetch_mould_metadata()
    except MouldServiceError:
        warnings.append("metadata_unavailable")
    mould = normalize_mould_record(
        raw_record,
        choice_value_maps=build_choice_value_maps(metadata_payload),
    )
    warnings.extend(mould.get("warnings", []))

    resource_capability = False
    resource_detail_capability = False
    resource_stats: dict[str, Any] = {
        "source": "blacklake.resource_mold.list",
        "match_rule": "custom.asset_code == resource.entityLinkCode",
        "custom_count": 1,
        "resource_count": 0,
        "matched_count": 0,
        "unmatched_count": 0,
        "duplicate_count": 0,
        "missing_key_count": 0,
        "complete": False,
        "available": False,
        "fetched_at": fetched_at,
    }
    resource_detail_provenance: dict[str, Any] = {
        "source": "blacklake.resource_mold.detail",
        "loaded": False,
        "resource_id": None,
        "resource_record_updated_at": None,
        "fetched_at": fetched_at,
    }
    asset_code = str(mould.get("asset_code") or "").strip()
    if asset_code:
        try:
            resource_records, resource_warnings = fetch_resource_mould_records(
                entity_link_code=asset_code
            )
            resource_capability = True
            warnings.extend(f"resource:{warning}" for warning in resource_warnings)
            enriched, resource_stats, enrichment_warnings = enrich_mould_records(
                [mould],
                resource_records,
            )
            resource_stats.update(
                {
                    "available": True,
                    "fetched_at": fetched_at,
                    "on_way_numeric_contract": (
                        "list only: 1=inside, 2=in_transit, 3=outside; label first"
                    ),
                }
            )
            mould = enriched[0]
            warnings.extend(enrichment_warnings)

            matching_resources = [
                record
                for record in resource_records
                if _entity_link_match_key(record.get("entityLinkCode"))
                == _entity_link_match_key(asset_code)
            ]
            if len(matching_resources) == 1:
                list_resource = matching_resources[0]
                resource_id = _as_identifier(list_resource.get("id"))
                resource_detail_provenance["resource_id"] = resource_id
                if resource_id:
                    try:
                        detail_resource = fetch_resource_mould_detail(resource_id)
                        detail_id = _as_identifier(detail_resource.get("id"))
                        detail_link_code = str(
                            detail_resource.get("entityLinkCode") or ""
                        ).strip()
                        if detail_id != resource_id:
                            warnings.append("resource_detail_id_mismatch")
                        elif detail_link_code and _entity_link_match_key(
                            detail_link_code
                        ) != _entity_link_match_key(asset_code):
                            warnings.append("resource_detail_entity_link_mismatch")
                        else:
                            merged_resource = {
                                **list_resource,
                                **detail_resource,
                                "id": list_resource.get("id"),
                                "entityLinkCode": list_resource.get("entityLinkCode"),
                            }
                            source_field_overrides = {
                                normalized_name: (
                                    "blacklake.resource_mold.detail"
                                    if raw_name in detail_resource
                                    else "blacklake.resource_mold.list"
                                )
                                for normalized_name, raw_name in (
                                    RESOURCE_FIELD_NAMES.items()
                                )
                                if raw_name in merged_resource
                            }
                            detailed, _detail_stats, detail_warnings = (
                                enrich_mould_records(
                                    [mould],
                                    [merged_resource],
                                    source="blacklake.resource_mold.list+detail",
                                    source_field_overrides=source_field_overrides,
                                )
                            )
                            mould = detailed[0]
                            warnings.extend(detail_warnings)
                            resource_detail_capability = True
                            resource_detail_provenance.update(
                                {
                                    "loaded": True,
                                    "resource_record_updated_at": mould.get(
                                        "resource_record_updated_at"
                                    ),
                                }
                            )
                    except MouldServiceError:
                        warnings.append("resource_detail_unavailable")
                else:
                    warnings.append("resource_detail_skipped_without_id")
        except MouldServiceError:
            warnings.append("resource_enrichment_unavailable")
    else:
        warnings.append("resource_enrichment_skipped_without_asset_code")

    on_way_provenance = mould.get("resource_provenance")
    on_way_field_sources = (
        on_way_provenance.get("field_sources")
        if isinstance(on_way_provenance, Mapping)
        else None
    )
    on_way_source = (
        on_way_field_sources.get("on_way_status")
        if isinstance(on_way_field_sources, Mapping)
        else None
    )
    _offsite, on_way_ambiguous = _on_way_signal(
        mould.get("on_way_status"),
        allow_list_numeric_contract=on_way_source == "blacklake.resource_mold.list",
    )
    if on_way_ambiguous:
        warnings.append("resource_on_way_status_ambiguous")
        resource_detail_provenance["on_way_status_interpretation"] = "ambiguous"
        resource_detail_provenance["on_way_status_source"] = on_way_source

    child_objects = discover_child_objects(metadata_payload)

    raw_histories: dict[str, list[dict[str, Any]]] = {
        "movement_history": [],
        "production_history": [],
        "repair_history": [],
    }
    normalized_histories: dict[str, list[dict[str, Any]]] = {
        "movement_history": [],
        "production_history": [],
        "repair_history": [],
    }
    for history_key in normalized_histories:
        child_info = child_objects.get(history_key)
        if not child_info:
            warnings.append(f"{history_key}_object_not_discovered")
            continue
        try:
            rows, child_warnings = _fetch_child_records(
                main_instance_id=instance_id,
                child_object_code=child_info["object_code"],
            )
            raw_histories[history_key] = rows
            normalized_histories[history_key] = [
                normalized
                for row in rows
                for normalized in normalize_history_records(history_key, row)
            ]
            if history_key == "movement_history":
                normalized_histories[history_key] = _infer_movement_sources(
                    normalized_histories[history_key]
                )
            elif history_key == "production_history":
                normalized_histories[history_key] = continuous_production_history(
                    normalized_histories[history_key]
                )
            warnings.extend(f"{history_key}:{warning}" for warning in child_warnings)
        except MouldServiceError:
            warnings.append(f"{history_key}_unavailable")

    operation_logs: list[dict[str, Any]] = []
    operation_logs_loaded = False
    if mould.get("mould_code"):
        try:
            operation_logs, log_warnings = _fetch_operation_logs(
                str(mould["mould_code"])
            )
            operation_logs_loaded = True
            warnings.extend(log_warnings)
        except MouldServiceError:
            warnings.append("operation_logs_unavailable")
    else:
        warnings.append("operation_logs_skipped_without_mould_code")

    replacements = _replacement_event_records(
        raw_histories["movement_history"],
        normalized_histories["movement_history"],
    )
    position = _position_payload(
        operation_logs=operation_logs,
        replacement_records=replacements,
        current_location=mould.get("location_code"),
        record_updated_at=raw_record.get("updatedAt"),
    )
    warnings.extend(position.get("warnings", []))
    mould["position_changed_at"] = position.get("last_changed_at")
    mould["position_changed_at_source"] = position.get("last_changed_source")
    mould["time_quality"] = position.get("quality")

    if mould.get("current_output_amount") is None:
        history_totals = [
            row.get("cumulative_quantity")
            for row in normalized_histories["production_history"]
            if isinstance(row.get("cumulative_quantity"), (int, float))
            and not isinstance(row.get("cumulative_quantity"), bool)
        ]
        if history_totals:
            mould["current_output_amount"] = max(history_totals)
            warnings.append("current_output_amount_from_production_history")

    capabilities = {
        "basic_detail": True,
        "movement_history": bool(child_objects.get("movement_history")),
        "production_history": bool(child_objects.get("production_history")),
        "repair_history": bool(child_objects.get("repair_history")),
        "position_history": operation_logs_loaded or bool(replacements),
        "file_download": False,
        "resource_enrichment": resource_capability,
        "resource_enrichment_complete": bool(resource_stats.get("complete")),
        "resource_detail": resource_detail_capability,
    }
    latest_custom_source = mould.get("record_updated_at")
    latest_resource_source = mould.get("resource_record_updated_at")
    latest_source = max(
        [value for value in (latest_custom_source, latest_resource_source) if value],
        default=None,
    )
    provenance = {
        "parent": {
            "source": "blacklake.custom_object.detail",
            "object_code": MOULD_OBJECT_CODE,
            "instance_id": instance_id,
            "fetched_at": fetched_at,
        },
        "position": {
            "source": position.get("last_changed_source"),
            "time_quality": position.get("quality"),
        },
        "resource_enrichment": resource_stats,
        "resource_detail": resource_detail_provenance,
        "movement_history": _history_provenance(
            child_info=child_objects.get("movement_history"),
            records=normalized_histories["movement_history"],
            fetched_at=fetched_at,
        ),
        "production_history": _history_provenance(
            child_info=child_objects.get("production_history"),
            records=normalized_histories["production_history"],
            fetched_at=fetched_at,
        ),
        "repair_history": _history_provenance(
            child_info=child_objects.get("repair_history"),
            records=normalized_histories["repair_history"],
            fetched_at=fetched_at,
        ),
    }

    return {
        "status": "partial" if warnings else "ok",
        "mould": mould,
        "attachments": [],
        "movement_history": normalized_histories["movement_history"],
        "production_history": normalized_histories["production_history"],
        "repair_history": normalized_histories["repair_history"],
        "position_history": position,
        "final_changed_at": mould.get("final_changed_at"),
        "final_changed_at_source": mould.get("final_changed_at_source"),
        "record_updated_at": mould.get("record_updated_at"),
        "position_changed_at": mould.get("position_changed_at"),
        "position_changed_at_source": mould.get("position_changed_at_source"),
        "time_quality": mould.get("time_quality"),
        "data_freshness": {
            "mode": "live",
            "status": "partial" if warnings else "live",
            "fetched_at": fetched_at,
            "source_latest_at": latest_source,
            "source_updated_at": latest_source,
            "source": "blacklake.custom_object.detail:MOLD001__c+resource_mold",
            "custom_object_latest_at": latest_custom_source,
            "resource_latest_at": latest_resource_source,
            "timezone": "Asia/Shanghai",
        },
        "capabilities": capabilities,
        "calculation_basis": [
            "Parent fields are resolved by BLACKLAKE fieldName for MOLD001__c.",
            (
                "Standard resource fields are joined only when custom asset_code "
                "exactly matches resource entityLinkCode (case-insensitive after "
                "trimming)."
            ),
            (
                "Custom-object current location remains authoritative; resource "
                "locations never overwrite it."
            ),
            (
                "Child histories are resolved from metadata sonObjects and paged "
                "by objectCode."
            ),
            (
                "position_changed_at is emitted only from a verified operation/"
                "replacement event."
            ),
            (
                "onWayStatus label/message wins over code; numeric-only detail "
                "status remains ambiguous because the list/detail contracts "
                "conflict."
            ),
            (
                "resource_record_updated_at is resource freshness only; it is "
                "never a mount/unmount or position-event time."
            ),
        ],
        "warnings": _unique_warnings(warnings),
        "provenance": provenance,
    }


def unavailable_board_payload(message: str) -> dict[str, Any]:
    fetched_at = datetime.now(tz=SHANGHAI).isoformat()
    return {
        "status": "unavailable",
        "summary": {
            "total": 0,
            "mounted": 0,
            "stored": 0,
            "maintenance": 0,
            "repair": 0,
            "offsite": 0,
            "unknown": 0,
            "conflicts": 0,
            "classified_total": 0,
            "reconciled": True,
            "status_counts": {},
        },
        "locations": [],
        "machines": _machine_rows([]),
        "moulds": [],
        "final_changed_at": None,
        "final_changed_at_source": None,
        "record_updated_at": None,
        "data_freshness": {
            "mode": "unavailable",
            "status": "unavailable",
            "fetched_at": fetched_at,
            "source_latest_at": None,
            "source_updated_at": None,
            "source": "blacklake.custom_object.list:MOLD001__c",
            "timezone": "Asia/Shanghai",
        },
        "capabilities": {
            "basic_detail": False,
            "movement_history": False,
            "production_history": False,
            "repair_history": False,
            "position_history": False,
            "file_download": False,
            "resource_enrichment": False,
            "resource_enrichment_complete": False,
        },
        "calculation_basis": [],
        "warnings": [_safe_exception_message(RuntimeError(message))[:240]],
    }


def unavailable_detail_payload(instance_id: str, message: str) -> dict[str, Any]:
    fetched_at = datetime.now(tz=SHANGHAI).isoformat()
    return {
        "status": "unavailable",
        "mould": {"instance_id": instance_id},
        "movement_history": [],
        "production_history": [],
        "repair_history": [],
        "position_history": {
            "events": [],
            "last_changed_at": None,
            "last_changed_source": None,
            "quality": "unknown",
            "warnings": ["position_history_unavailable"],
        },
        "final_changed_at": None,
        "final_changed_at_source": None,
        "record_updated_at": None,
        "position_changed_at": None,
        "position_changed_at_source": None,
        "time_quality": "unknown",
        "data_freshness": {
            "mode": "unavailable",
            "status": "unavailable",
            "fetched_at": fetched_at,
            "source_latest_at": None,
            "source_updated_at": None,
            "source": "blacklake.custom_object.detail:MOLD001__c",
            "timezone": "Asia/Shanghai",
        },
        "capabilities": {
            "basic_detail": False,
            "movement_history": False,
            "production_history": False,
            "repair_history": False,
            "position_history": False,
            "file_download": False,
            "resource_enrichment": False,
            "resource_enrichment_complete": False,
            "resource_detail": False,
        },
        "calculation_basis": [],
        "warnings": [_safe_exception_message(RuntimeError(message))[:240]],
        "provenance": {},
    }


__all__ = [
    "MouldServiceError",
    "build_mould_board",
    "build_mould_location_snapshot",
    "build_mould_detail",
    "continuous_production_history",
    "discover_child_objects",
    "enrich_mould_records",
    "normalize_child_record",
    "normalize_history_record",
    "normalize_history_records",
    "normalize_mould_record",
    "normalize_resource_mould",
    "unavailable_board_payload",
    "unavailable_detail_payload",
]
