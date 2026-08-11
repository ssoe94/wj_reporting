from __future__ import annotations

import argparse
import os
import re
import sys
import time
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

try:
    from .job_handlers import (
        production_daily_analysis,
        production_machine_analysis,
        production_question_analysis,
        quality_daily_attention_summary,
    )
    from .llm_client import LocalLlmClient
    from .render_client import RenderClient, WORKER_VERSION
except ImportError:
    from job_handlers import (
        production_daily_analysis,
        production_machine_analysis,
        production_question_analysis,
        quality_daily_attention_summary,
    )
    from llm_client import LocalLlmClient
    from render_client import RenderClient, WORKER_VERSION


HANDLERS = {
    "production_daily_analysis": production_daily_analysis,
    "production_machine_analysis": production_machine_analysis,
    "quality_image_analysis": quality_daily_attention_summary,
}

QWEN_MODEL_ID = "qwen35"
GEMMA_MODEL_ID = "gemma4_26b_a4b"
SUPPORTED_MODEL_IDS = {QWEN_MODEL_ID, GEMMA_MODEL_ID}
GEMMA_READY_WORKER_VERSION = "production-ai-worker-v2-gemma1"

REPAIR_SYSTEM_PROMPT = """You repair a manufacturing AI explanation that failed numeric grounding.
Use only the supplied verified qualitative evidence, qualitative draft, and allowed exact identifiers.
Do not add facts, calculations, causes, priorities, counts, or majority claims.
Remove every measurement value and quantity, including counts, rates, percentages, dates, times,
durations, thresholds, plan/actual values, output values, and numeric model sizes.
Digits may appear only inside a string copied exactly from allowed_exact_identifiers.
Replace numeric references with qualitative phrases such as current trend, target equipment,
the relevant specification, or the verified data range.
Reason internally, but never reveal private chain-of-thought. Return only an auditable final explanation.
For Korean, summary must use this exact order: 결론, 판단 근거, 확인할 항목.
For Chinese, use 结论, 判断依据, 需确认. Put each heading on its own section.
Separate sections with blank lines and do not collapse them into one paragraph.
Use up to three concrete verified statuses or exact identifiers in 판단 근거/判断依据.
Avoid vague phrases such as 일부 or 대부분 when exact verified identifiers are available.
Treat is_running=true as running and never recommend restart or resume for that equipment.
Treat is_running=false as not running at the snapshot, not as a proven fault.
For injection_active_machine_count, active means the MES counter increased inside the verified window; it does not
prove the equipment is currently running. Do not claim current operation without verified is_running=true evidence.
Translate status codes and booleans into natural Korean or Chinese instead of exposing raw values.
Obey verified_qualitative_evidence.analysis_constraints. If target history is unavailable, say the target trend
cannot be determined and describe only the current snapshot. Do not call the target delayed, low, insufficient,
improving, or worsening from one snapshot. Ask for target-level time snapshots when history is missing.
When focus_identifiers is non-empty, do not cite unrelated machines, lines, Parts, or models.
Do not ask to reconfirm a current production or running status already present in verified evidence.
The summary must not contain these raw tokens: on_track, behind, ahead, no_plan, in_progress,
pending, completed, is_running, true, false. Do not use vague quantifiers such as 일부 or 대부분;
name the exact supplied identifiers instead.
Return valid JSON only with string keys title and summary. Do not use markdown."""


class LlmGroundingError(ValueError):
    """Raised when otherwise structured LLM prose fails deterministic grounding."""

    def __init__(self, message: str, candidate: dict[str, Any] | None = None):
        super().__init__(message)
        self.candidate = dict(candidate or {})


@dataclass(frozen=True)
class GroundingRecord:
    identifiers: tuple[str, ...]
    values: frozenset[Decimal]


@dataclass
class RunOnceReport:
    messages: list[str] = field(default_factory=list)
    had_failure: bool = False

    def add(self, message: str, *, failure: bool = False) -> None:
        cleaned = str(message or "").strip()
        if cleaned:
            self.messages.append(cleaned[:500])
        self.had_failure = self.had_failure or failure

    def summary(self) -> str:
        return "; ".join(self.messages)[:500]


@dataclass(frozen=True)
class LocalModelTarget:
    model_id: str
    client: LocalLlmClient | None
    model_name: str


def requested_model_id(job: dict[str, Any], default_model_id: str = QWEN_MODEL_ID) -> str:
    scope = job.get("scope") if isinstance(job.get("scope"), dict) else {}
    input_payload = (
        job.get("input_payload")
        if isinstance(job.get("input_payload"), dict)
        else {}
    )
    raw_model_id = scope.get("model_id") or input_payload.get("model_id") or default_model_id
    model_id = str(raw_model_id or "").strip()
    if model_id not in SUPPORTED_MODEL_IDS:
        raise ValueError(f"Unsupported local AI model_id: {model_id or '<empty>'}")
    return model_id


def heartbeat_worker_version(model_readiness: dict[str, bool]) -> str:
    return (
        GEMMA_READY_WORKER_VERSION
        if model_readiness.get(GEMMA_MODEL_ID, False)
        else WORKER_VERSION
    )


def health_check_passed(result: dict[str, Any]) -> bool:
    return str(result.get("status") or "").strip().lower() == "ok"


def handler_for_job(job: dict):
    input_payload = job.get("input_payload") or {}
    if input_payload.get("source") == "production_ai_question":
        return production_question_analysis
    return HANDLERS.get(job.get("job_type"))


def truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


NUMBER_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])[+\-\N{MINUS SIGN}]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
)
# A decimal dot belongs to the number; any other dot may end a clause.
CLAUSE_SPLIT = re.compile(r"(?:[\n!?。！？;；]+|(?<!\d)\.|\.(?!\d)|,(?=\s)|，)")
DATE_OR_TIME = re.compile(
    r"(?:\b\d{4}-\d{1,2}-\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+\-]\d{2}:?\d{2})?)?\b"
    r"|\b\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일\b"
    r"|\b\d{4}[./]\d{1,2}[./]\d{1,2}\b"
    r"|\b\d{1,2}:\d{2}(?::\d{2})?\b)"
)
KOREAN_NATIVE_ONES = r"(?:한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉)"
KOREAN_NATIVE_TENS = r"(?:열|스물|스무|서른|마흔|쉰|예순|일흔|여든|아흔)"
KOREAN_SPELLED_NUMBER = (
    rf"(?:영|공|{KOREAN_NATIVE_TENS}{KOREAN_NATIVE_ONES}?|{KOREAN_NATIVE_ONES}"
    r"|한두|두세|서너|너댓|대여섯|예닐곱|일고여덟|여덟아홉|몇|여러"
    r"|수(?:십|백|천|만|억|조)|[일이삼사오육칠팔구십백천만억조]+)"
)
KOREAN_APPROXIMATION = r"(?:여|남짓|가량|정도|쯤|안팎|내외|이상|이하|미만|초과)?"
KOREAN_QUANTITY_UNIT = r"(?:개|회|대|건|퍼센트|프로|시간|분|초|라인|설비|호기|%)"
CHINESE_SPELLED_NUMBER = (
    r"(?:[零〇一二两兩三四五六七八九十百千万萬亿億兆]+"
    r"|[几幾数數](?:十|百|千|万|萬|亿|億|兆)?)"
)
CHINESE_APPROXIMATION = r"(?:余|餘|多|来|來|上下|左右|以上|以下|以内|以內|不足|超过|超過)?"
CHINESE_QUANTITY_UNIT = r"(?:个|個|件|次|台|条|條|小時|小时|分鐘|分钟|秒|百分比|号机|號機|%)"
SPELLED_QUANTITY = re.compile(
    rf"(?:(?:(?<![가-힣])|(?<=[은는이가을를와과도만]))"
    rf"(?:{KOREAN_SPELLED_NUMBER}{KOREAN_APPROXIMATION}\s*{KOREAN_QUANTITY_UNIT}"
    rf"|(?:백분의|천분의)\s*{KOREAN_SPELLED_NUMBER}"
    r"|절반|반절)"
    rf"|{CHINESE_SPELLED_NUMBER}{CHINESE_APPROXIMATION}\s*{CHINESE_QUANTITY_UNIT}"
    rf"|(?:百分之|千分之)\s*{CHINESE_SPELLED_NUMBER}"
    r"|一半|半数|半數)"
)
ATTACHED_SPELLED_QUANTITY = re.compile(
    # Standalone ``한`` is excluded here because it is also the Korean
    # modifier suffix in ordinary prose (for example ``요청한 시간``). Other
    # spelled numbers can safely be detected even when Qwen omits whitespace
    # or glues a quantity adverb in front of them (``모두두대``).
    rf"(?:영|공|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉|"
    rf"{KOREAN_NATIVE_TENS}{KOREAN_NATIVE_ONES}?|한두|두세|서너|너댓|대여섯|"
    rf"예닐곱|일고여덟|여덟아홉|몇|여러|수(?:십|백|천|만|억|조)|"
    rf"[일이삼사오육칠팔구십백천만억조]+)"
    rf"{KOREAN_APPROXIMATION}\s*{KOREAN_QUANTITY_UNIT}"
)
NUMERIC_DURATION = re.compile(
    rf"{NUMBER_TOKEN.pattern}\s*(?:시간|분|초|小時|小时|分鐘|分钟|秒)"
)
NUMERIC_SPECIFICATION = re.compile(
    rf"{NUMBER_TOKEN.pattern}\s*(?:인치|inch|英寸)",
    re.IGNORECASE,
)
NUMERIC_MACHINE = re.compile(
    rf"{NUMBER_TOKEN.pattern}\s*(?:호기|号机|號機)"
)
NUMERIC_MEASUREMENT = re.compile(
    rf"{NUMBER_TOKEN.pattern}\s*(?:개|회|건|대|퍼센트|프로|%|個|个|件|次|台|百分比)"
)
RAW_STATUS_TOKEN = re.compile(
    r"(?<![A-Za-z0-9_])(?:on_track|behind|ahead|no_plan|in_progress|pending|completed|"
    r"mes_reported|manual_partial|manual_open|manual_matched|needs_review|manual_mismatch|"
    r"is_running|true|false)(?![A-Za-z0-9_])",
    re.IGNORECASE,
)
VAGUE_QUANTIFIER = re.compile(r"(?:일부|대부분|몇몇|部分设备|部分設備|大部分)")
UNSUPPORTED_CAUSAL_ASSERTION = re.compile(
    r"(?:때문에|(?:으)?로\s*인해|영향으로|유발|초래|야기|탓|"
    r"由于|由於|因为|因為|导致|導致|引发|引發|造成|原因(?:是|在于)|"
    r"(?:가|이)\s*[^.\n]{0,28}(?:늦어|불안정해|고장나|문제가\s*생겨)|"
    r"(?:지연|고장|불량|불안정|문제|실수|오류)\s*(?:으)?로\s+|원인(?:은|이|입니다|이다)|"
    r"(?:원료|자재|인력|공급사|금형(?:\s*온도)?|설비|작업자|압력|문제).{0,28}"
    r"(?:결과|여파|영향(?:을|으로)?\s*(?:받아|받아서)?|기인).{0,24}"
    r"(?:늦|지연|저하|하락|불량|중단|부족)|"
    r"(?:원료|자재|인력|공급사|금형(?:\s*온도)?|설비|작업자|압력|온도|실수|오류)"
    r".{0,36}(?:늦(?:었|습니다|어)|지연(?:됐|되었|시켰)|떨어뜨렸|늦췄|낮췄|저하시켰)|"
    r"(?:원료|자재|인력|공급사|금형\s*온도|설비).{0,18}(?:부족|고장|불안정|문제).{0,8}"
    r"(?:입니다|이다|상태|로\s*보|이\s*확인)|"
    r"(?:原料|材料|人员|人員|供应商|供應商|模具温度|模具溫度|设备|設備).{0,18}"
    r"(?:不足|故障|不稳定|不穩定|问题|問題))"
)
UNSUPPORTED_OPERATIONAL_DIRECTIVE = re.compile(
    r"(?:교체|재시작|중단|폐기|증산|감산|추가\s*발주|인력\s*투입|연락|문의).{0,18}"
    r"(?:해야|하십시오|권장|필요)|(?:更换|更換|重启|重啟|停产|停產|报废|報廢|增产|增產|减产|減產).{0,18}"
    r"(?:应该|應該|建议|建議|需要)"
)
RISK_ASSERTION = re.compile(
    r"(?:불안정|고장|불량|부족|과열|막힘|결함|이상|저하|하락|"
    r"故障|不良|不足|过热|過熱|堵塞|缺陷|异常|異常|下降|降低|不稳定|不穩定)"
)
CHECK_OR_INFORMATION_LIMITATION = re.compile(
    r"(?:확인|점검|검토|조사|여부|가능성|데이터|자료|정보|이력|스냅샷|근거|"
    r"确认|確認|检查|檢查|审查|審查|调查|調查|是否|可能性|数据|數據|资料|資料|信息|資訊|记录|記錄|依据|依據)"
)
DIRECTIVE_MARKER = re.compile(
    r"(?:해야(?:\s*합니다)?|하십시오|하세요|세요|권장합니다|필요합니다|"
    r"应该|應該|请|請|建议|建議|需要)"
)
SAFE_ANALYSIS_ACTION = re.compile(
    r"(?:확인|검토|수집|조회|비교|점검|파악|기록|모니터링|추적|확보|요청|조사|분석|측정|"
    r"确认|確認|审查|審查|收集|查询|查詢|比较|比較|检查|檢查|掌握|记录|記錄|监控|監控|追踪|追蹤|获取|取得|请求|請求|调查|調查|分析|测量|測量)"
)
NUMBERED_LIST_MARKER = re.compile(r"(?m)^([ \t]*)\d+[.)]\s+")
SECTION_HEADING = re.compile(r"(?m)^(결론|판단 근거|확인할 항목|结论|判断依据|需确认)\s*:?\s*$")
INLINE_SECTION_HEADING = re.compile(
    r"(?m)^(결론|판단 근거|확인할 항목|结论|判断依据|需确认)\s*:\s*(?=\S)"
)
EMPTY_REASONING_SECTION = re.compile(
    r"(?m)^(?:판단 근거|判断依据)\s*:\s*\n+(?=\s*(?:확인할 항목|需确认)\s*:)"
)
TREND_TERM = re.compile(r"(?:추이|변화|趋势|趨勢|变化|變化)")
UNAVAILABLE_TREND = re.compile(
    r"(?:판단할 수 없|확인할 수 없|평가할 수 없|단정할 수 없|알 수 없|"
    r"(?:비교\s*)?근거가 부족|데이터가 없|이력이 없|"
    r"无法判断|无法确认|无法评估|缺少.*数据|没有.*记录|無法判斷|缺少.*資料)"
)
UNSUPPORTED_TARGET_TREND = re.compile(
    r"(?:(?:계획|시간)\s*대비[^.\n]{0,30}(?:미달|낮|부족)|낮은\s*수준|"
    r"(?:지연|악화|개선|정체)(?:된|되는|하는|\s*상태|\s*추이)|"
    r"低于计划|低於計劃|进度偏低|進度偏低|延迟状态|延遲狀態|恶化趋势|惡化趨勢)"
)
REDUNDANT_STATUS_RECHECK = re.compile(
    r"(?:가동|생산|진행)\s*(?:상태|여부).{0,8}재확인|"
    r"(?:运行|生产|生產|进度|進度)(?:状态|狀態|与否|與否).{0,8}(?:再次确认|再次確認)"
)
MISSING_ACTIVE_MACHINE_ZERO_CLAIM = re.compile(
    r"(?:(?:가동(?:된|한|했던|\s*중인)?\s*사출기|(?:현재\s*)?가동\s*(?:설비|장비))"
    r"(?:는|가)?\s*(?:(?:한\s*대|하나)도\s*)?(?:없|존재하지)|"
    r"사출기(?:는|가)?\s*(?:가동되지\s*않|한\s*대도\s*가동되지)|"
    r"(?:没有|不存在).{0,16}(?:运行过的|运行的)?注塑机|"
    r"(?:运行过的|运行的)?注塑机.{0,12}(?:没有|不存在))"
)
ACTIVE_MACHINE_SUBJECT = re.compile(
    r"(?:사출기|(?:가동|운전)(?:된|한|했던|\s*중인)?\s*(?:사출기|설비|장비)|"
    r"注塑机|运行(?:设备|設備))"
)
NEGATIVE_EXISTENCE_CLAIM = re.compile(
    r"(?:없|존재하지|가동되지\s*않|미가동|没有|不存在|未运行|未开机|未開機)"
)
DATA_UNAVAILABLE_LIMITATION = re.compile(
    r"(?:기록|데이터|자료|정보|근거|확인할\s*수\s*없|판단할\s*수\s*없|"
    r"记录|記錄|数据|數據|资料|資料|信息|資訊|依据|依據|无法确认|無法確認|无法判断|無法判斷)"
)
UNVERIFIED_CAUSE_SOURCE = re.compile(
    r"(?:원료|자재|인력|공급사|금형|설비|장비|작업자|압력|온도|실수|오류|"
    r"原料|材料|人员|人員|供应商|供應商|模具|设备|設備|作业员|作業員|压力|壓力|温度|溫度|失误|失誤|错误|錯誤)"
)
UNVERIFIED_CAUSE_EFFECT = re.compile(
    r"(?:지연|차질|생산성|생산\s*속도|불량|중단|저하|하락|늦|"
    r"延迟|延遲|影响生产|影響生產|生产率|生產率|速度|不良|中断|中斷|下降|降低)"
)
RAW_SCHEMA_TERMS = {
    "shot_count": ("형합수", "合模数"),
    "active_machine_count": ("가동 사출기 대수", "运行注塑机数量"),
    "lookback_minutes": ("조회 시간 구간", "查询时间区间"),
}

PROCESS_ALIASES = {
    "injection": ("injection", "사출", "注塑"),
    "machining": ("machining", "가공", "加工"),
}
IDENTIFIER_KEYS = {
    "machine",
    "machine_name",
    "equipment_label",
    "equipment_name",
    "equipment_key",
    "part_no",
    "model_name",
    "product_family_code",
    "product_family_name",
    "label",
    "line",
    "line_name",
    "fact_id",
}
METADATA_SUBTREES = {
    "cache",
    "calculation_basis",
    "conversation_history",
    "data_freshness",
    "retrieval_trace",
    "scope",
    "used_data",
    "warnings",
}
TRUSTED_PROSE_KEYS = {
    "answer",
    "deterministic_answer",
    "deterministic_summary",
    "draft_summary",
    "summary",
    "verified_answer",
    "verified_evidence_sentences",
}


def _normalize_number(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float, Decimal)):
        raw = str(value)
    elif isinstance(value, str) and NUMBER_TOKEN.fullmatch(value.strip()):
        raw = value.strip()
    else:
        return None
    try:
        return Decimal(raw.replace(",", "").replace("\N{MINUS SIGN}", "-")).normalize()
    except (InvalidOperation, ValueError):
        return None


def _is_metadata_number_key(key: str) -> bool:
    normalized = key.strip().lower()
    return (
        normalized in {
            "date",
            "business_date",
            "completed_at",
            "created_at",
            "generated_at",
            "id",
            "job_id",
            "machine_number",
            "reference_time",
            "row_count",
            "schedule_slot",
            "sequence",
            "started_at",
            "updated_at",
        }
        or normalized.endswith("_at")
        or normalized.endswith("_date")
        or normalized.endswith("_id")
        or normalized.startswith("timestamp")
        or normalized.startswith("range_")
    )


def _process_identifiers(value: Any) -> dict[str, int]:
    normalized = str(value or "").strip().lower()
    found: dict[str, int] = {}
    for process, aliases in PROCESS_ALIASES.items():
        if normalized == process or process in normalized:
            found.update({alias.casefold(): 1 for alias in aliases})
    return found


def _explicit_identifiers(node: dict[str, Any]) -> dict[str, int]:
    identifiers: dict[str, int] = {}
    for key in IDENTIFIER_KEYS:
        value = node.get(key)
        if not isinstance(value, str) or not value.strip() or value.strip() == "-":
            continue
        identifiers[value.strip().casefold()] = 3
    machine_number = _normalize_number(node.get("machine_number"))
    if machine_number is not None and machine_number == machine_number.to_integral_value():
        number = str(int(machine_number))
        identifiers[f"{number}호기".casefold()] = 3
        identifiers[f"{number}号机".casefold()] = 3
        identifiers[f"{number}號機".casefold()] = 3
    identifiers.update(_process_identifiers(node.get("process")))
    return identifiers


def _path_identifiers(path: tuple[str, ...]) -> dict[str, int]:
    identifiers: dict[str, int] = {}
    for component in path:
        identifiers.update(_process_identifiers(component))
    return identifiers


def _append_grounding_record(
    records: list[GroundingRecord],
    identifiers: dict[str, int],
    values: set[Decimal],
) -> None:
    if not identifiers or not values:
        return
    max_specificity = max(identifiers.values())
    specific_identifiers = tuple(sorted(
        identifier for identifier, specificity in identifiers.items()
        if specificity == max_specificity
    ))
    record = GroundingRecord(specific_identifiers, frozenset(values))
    if record not in records:
        records.append(record)


def _collect_structured_records(
    node: Any,
    records: list[GroundingRecord],
    path: tuple[str, ...] = (),
    inherited_identifiers: dict[str, int] | None = None,
) -> None:
    if isinstance(node, list):
        for item in node:
            _collect_structured_records(item, records, path, inherited_identifiers)
        return
    if not isinstance(node, dict):
        return

    identifiers = dict(inherited_identifiers or {})
    identifiers.update(_path_identifiers(path))
    identifiers.update(_explicit_identifiers(node))
    values: set[Decimal] = set()
    for key, value in node.items():
        if _is_metadata_number_key(str(key)) or str(key) in IDENTIFIER_KEYS:
            continue
        normalized = _normalize_number(value)
        if normalized is not None:
            values.add(normalized)
    _append_grounding_record(records, identifiers, values)

    for key, value in node.items():
        normalized_key = str(key).strip().lower()
        if normalized_key in METADATA_SUBTREES or normalized_key in TRUSTED_PROSE_KEYS:
            continue
        if normalized_key == "historical_snapshots" and isinstance(value, list):
            for snapshot in value:
                if isinstance(snapshot, dict):
                    _collect_structured_records(snapshot.get("facts"), records, path + ("facts",))
            continue
        if isinstance(value, (dict, list)):
            child_identifiers = identifiers if normalized_key in {"parts", "related_parts"} else None
            _collect_structured_records(value, records, path + (normalized_key,), child_identifiers)


def _identifier_spans(text: str, identifier: str) -> list[tuple[int, int]]:
    needle = str(identifier or "").casefold()
    if not needle:
        return []
    folded = text.casefold()
    spans = []
    offset = 0
    while True:
        start = folded.find(needle, offset)
        if start < 0:
            break
        end = start + len(needle)
        before = folded[start - 1] if start > 0 else ""
        after = folded[end] if end < len(folded) else ""
        first = needle[0]
        last = needle[-1]
        left_conflict = bool(before) and (
            (first.isdigit() and before.isdigit())
            or (first.isascii() and first.isalnum() and before.isascii() and before.isalnum())
        )
        right_conflict = bool(after) and (
            (last.isdigit() and after.isdigit())
            or (last.isascii() and last.isalnum() and after.isascii() and after.isalnum())
        )
        if not left_conflict and not right_conflict:
            spans.append((start, end))
        offset = start + 1
    return spans


def _matched_identifiers(text: str, records: list[GroundingRecord]) -> set[str]:
    return {
        identifier
        for record in records
        for identifier in record.identifiers
        if _identifier_spans(text, identifier)
    }


def _text_without_identifiers(text: str, identifiers: set[str]) -> str:
    spans = sorted(
        (span for identifier in identifiers for span in _identifier_spans(text, identifier)),
        key=lambda item: (item[0], -(item[1] - item[0])),
    )
    if not spans:
        return text
    chars = list(text)
    covered_until = -1
    for start, end in spans:
        if start < covered_until:
            continue
        chars[start:end] = " " * (end - start)
        covered_until = end
    return "".join(chars)


def _numbers_in_claim(text: str, identifiers: set[str]) -> set[Decimal]:
    without_identifiers = _text_without_identifiers(text, identifiers)
    without_metadata = DATE_OR_TIME.sub(" ", without_identifiers)
    numbers = set()
    for match in NUMBER_TOKEN.finditer(without_metadata):
        normalized = _normalize_number(match.group(0))
        if normalized is not None:
            numbers.add(normalized)
    return numbers


def _known_identifiers(records: list[GroundingRecord]) -> set[str]:
    return {identifier for record in records for identifier in record.identifiers}


def _collect_trusted_prose_records(grounding: Any, records: list[GroundingRecord]) -> None:
    if not isinstance(grounding, dict):
        return
    known_identifiers = _known_identifiers(records)
    known_identifiers.update(alias.casefold() for aliases in PROCESS_ALIASES.values() for alias in aliases)
    machine_identifier = re.compile(r"(?<!\d)\d+\s*(?:호기|号机|號機)|(?<![A-Za-z0-9])\d{3,4}T-\d+(?![A-Za-z0-9])", re.IGNORECASE)

    for key in TRUSTED_PROSE_KEYS:
        value = grounding.get(key)
        if not isinstance(value, str):
            continue
        for clause in CLAUSE_SPLIT.split(value):
            clause = clause.strip()
            if not clause:
                continue
            identifiers = {
                identifier: 3 if identifier not in {
                    alias.casefold() for aliases in PROCESS_ALIASES.values() for alias in aliases
                } else 1
                for identifier in known_identifiers
                if _identifier_spans(clause, identifier)
            }
            for match in machine_identifier.finditer(clause):
                identifiers[match.group(0).replace(" ", "").casefold()] = 3
            if identifiers:
                max_specificity = max(identifiers.values())
                specific_identifiers = {
                    identifier for identifier, specificity in identifiers.items()
                    if specificity == max_specificity
                }
                canonical_processes = {
                    process
                    for process, aliases in PROCESS_ALIASES.items()
                    if any(identifier in {alias.casefold() for alias in aliases} for identifier in specific_identifiers)
                }
                subject_count = len(canonical_processes) if canonical_processes else len(specific_identifiers)
                if subject_count > 1:
                    continue
            matched = set(identifiers)
            values = _numbers_in_claim(clause, matched)
            _append_grounding_record(records, identifiers, values)


def _grounding_records(grounding: dict[str, Any]) -> list[GroundingRecord]:
    records: list[GroundingRecord] = []
    _collect_structured_records(grounding, records)
    if not records:
        _collect_trusted_prose_records(grounding, records)
    return records


def _authoritative_date_times(grounding: Any, parent_key: str = "") -> set[str]:
    values: set[str] = set()
    if isinstance(grounding, list):
        for item in grounding:
            values.update(_authoritative_date_times(item, parent_key))
        return values
    if not isinstance(grounding, dict):
        return values
    for key, value in grounding.items():
        normalized_key = str(key).strip().lower()
        if normalized_key in {"conversation_history", "question"}:
            continue
        if isinstance(value, str) and (
            _is_metadata_number_key(normalized_key)
            or normalized_key in TRUSTED_PROSE_KEYS
            or parent_key in TRUSTED_PROSE_KEYS
        ):
            values.update(match.group(0) for match in DATE_OR_TIME.finditer(value))
        elif isinstance(value, (dict, list)):
            values.update(_authoritative_date_times(value, normalized_key))
    return values


def _canonical_claim_clause(value: str) -> str:
    def replace_number(match: re.Match[str]) -> str:
        normalized = _normalize_number(match.group(0))
        return f"<number:{normalized}>" if normalized is not None else match.group(0)

    normalized_numbers = NUMBER_TOKEN.sub(replace_number, value.casefold())
    return " ".join(normalized_numbers.split())


def _authoritative_claim_clauses(grounding: Any) -> set[str]:
    clauses: set[str] = set()
    if isinstance(grounding, list):
        for item in grounding:
            clauses.update(_authoritative_claim_clauses(item))
        return clauses
    if not isinstance(grounding, dict):
        return clauses
    for key, value in grounding.items():
        normalized_key = str(key).strip().lower()
        if normalized_key in {"conversation_history", "question"}:
            continue
        if normalized_key in TRUSTED_PROSE_KEYS:
            trusted_values = [value] if isinstance(value, str) else (
                [item for item in value if isinstance(item, str)]
                if isinstance(value, list) else []
            )
            for trusted_value in trusted_values:
                clauses.update(
                    _canonical_claim_clause(clause.strip())
                    for clause in CLAUSE_SPLIT.split(trusted_value)
                    if clause.strip()
                )
        elif isinstance(value, (dict, list)):
            clauses.update(_authoritative_claim_clauses(value))
    return clauses


def summary_numbers_are_grounded(summary: str, grounding: dict[str, Any]) -> bool:
    records = _grounding_records(grounding)
    all_identifiers = _known_identifiers(records)
    authoritative_date_times = _authoritative_date_times(grounding)
    authoritative_claim_clauses = _authoritative_claim_clauses(grounding)
    for clause in CLAUSE_SPLIT.split(str(summary or "")):
        clause = clause.strip()
        if not clause:
            continue
        if any(match.group(0) not in authoritative_date_times for match in DATE_OR_TIME.finditer(clause)):
            return False
        if SPELLED_QUANTITY.search(clause) or ATTACHED_SPELLED_QUANTITY.search(clause):
            return False
        matched = _matched_identifiers(clause, records)
        numbers = _numbers_in_claim(clause, all_identifiers)
        if not numbers:
            continue
        canonical_clause = _canonical_claim_clause(clause)
        if canonical_clause in authoritative_claim_clauses:
            continue
        if not matched:
            return False
        # Numeric prose must preserve a complete deterministic clause. This is
        # intentionally stricter than a value allow-list: it prevents swapping
        # plan/actual fields or values between subjects that share one row.
        if canonical_clause not in authoritative_claim_clauses:
            return False
    return True


def _replace_unprotected_matches(
    value: str,
    pattern: re.Pattern[str],
    replacement: str,
    protected_spans: list[tuple[int, int]],
) -> str:
    matches = [
        match
        for match in pattern.finditer(value)
        if not any(match.start() >= start and match.end() <= end for start, end in protected_spans)
    ]
    for match in reversed(matches):
        value = f"{value[:match.start()]}{replacement}{value[match.end():]}"
    return value


def _qualitative_text(value: Any, allowed_identifiers: set[str], language: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    replacements = [
        (NUMERIC_DURATION, "측정 구간" if language == "ko" else "测量区间"),
        (NUMERIC_SPECIFICATION, "해당 규격" if language == "ko" else "相关规格"),
        (NUMERIC_MACHINE, "대상 설비" if language == "ko" else "目标设备"),
        (NUMERIC_MEASUREMENT, "검증 수치" if language == "ko" else "已验证数值"),
        (DATE_OR_TIME, "기준 시점" if language == "ko" else "基准时间"),
        (NUMBER_TOKEN, "검증 수치" if language == "ko" else "已验证数值"),
    ]
    for pattern, replacement in replacements:
        protected_spans = sorted(
            span
            for identifier in allowed_identifiers
            for span in _identifier_spans(text, identifier)
        )
        text = _replace_unprotected_matches(text, pattern, replacement, protected_spans)
    text = ATTACHED_SPELLED_QUANTITY.sub("관련 수량" if language == "ko" else "相关数量", text)
    text = SPELLED_QUANTITY.sub("관련 수량" if language == "ko" else "相关数量", text)
    return " ".join(text.split())[:2000]


def _verified_exact_identifiers(grounding: Any) -> list[str]:
    identifiers: list[str] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        if not isinstance(value, str):
            return
        cleaned = value.strip()
        folded = cleaned.casefold()
        if cleaned and cleaned != "-" and len(cleaned) <= 120 and folded not in seen:
            seen.add(folded)
            identifiers.append(cleaned)

    def visit(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                visit(item)
            return
        if not isinstance(node, dict):
            return
        for key, value in node.items():
            if key in IDENTIFIER_KEYS:
                add(value)
            if key == "machine_number":
                machine_number = _normalize_number(value)
                if machine_number is not None and machine_number == machine_number.to_integral_value():
                    number = str(int(machine_number))
                    add(f"{number}호기")
                    add(f"{number}号机")
                    add(f"{number}號機")
            if isinstance(value, (dict, list)):
                visit(value)

    visit(grounding)
    return identifiers


def _prioritized_exact_identifiers(
    grounding: dict[str, Any],
    candidate_text: str,
    question: str,
    limit: int = 80,
) -> list[str]:
    verified = _verified_exact_identifiers(grounding)
    referenced_text = f"{question} {candidate_text}"
    referenced = [
        identifier for identifier in verified
        if _identifier_spans(referenced_text, identifier.casefold())
    ]
    referenced_keys = {identifier.casefold() for identifier in referenced}
    return (referenced + [
        identifier for identifier in verified
        if identifier.casefold() not in referenced_keys
    ])[:limit]


def _verified_qualitative_evidence(
    grounding: dict[str, Any],
    allowed_identifiers: list[str],
    language: str,
) -> dict[str, Any]:
    allowed_keys = {identifier.casefold() for identifier in allowed_identifiers}
    analysis_skill = grounding.get("analysis_skill")
    focus_keys = {
        str(identifier).strip().casefold()
        for identifier in (
            analysis_skill.get("focus_identifiers") or []
            if isinstance(analysis_skill, dict)
            else []
        )
        if str(identifier).strip()
    }
    process_statuses: list[dict[str, str]] = []
    facts = grounding.get("verified_facts")
    if isinstance(facts, dict) and not focus_keys:
        for process in PROCESS_ALIASES:
            process_fact = facts.get(process)
            status = process_fact.get("status") if isinstance(process_fact, dict) else None
            if isinstance(status, str) and status.strip():
                process_statuses.append({"process": process, "status": status.strip()})

    row_statuses: list[dict[str, Any]] = []
    tables = grounding.get("verified_tables")
    if isinstance(tables, list):
        for table in tables:
            if not isinstance(table, dict):
                continue
            table_name = str(table.get("name") or "verified_table").strip()
            process = "injection" if table_name.startswith("injection_") else (
                "machining" if table_name.startswith("machining_") else "production"
            )
            for row in table.get("rows") or []:
                if not isinstance(row, dict):
                    continue
                row_identifier_keys = {
                    str(row.get(key)).strip().casefold()
                    for key in IDENTIFIER_KEYS
                    if isinstance(row.get(key), str) and str(row.get(key)).strip()
                }
                if focus_keys and not row_identifier_keys.intersection(focus_keys):
                    continue
                evidence_row: dict[str, Any] = {"process": process}
                for key in IDENTIFIER_KEYS:
                    value = row.get(key)
                    if (
                        isinstance(value, str)
                        and value.strip().casefold() in allowed_keys
                    ):
                        evidence_row[key] = value.strip()
                status = row.get("status")
                if isinstance(status, str) and status.strip():
                    evidence_row["status"] = _qualitative_text(status, set(), language)
                is_running = row.get("is_running")
                if isinstance(is_running, bool):
                    evidence_row["is_running"] = is_running
                if len(evidence_row) > 1:
                    row_statuses.append(evidence_row)
                if len(row_statuses) >= 40:
                    break
            if len(row_statuses) >= 40:
                break

    warnings: list[str] = []
    for warning in grounding.get("warnings") or []:
        if not isinstance(warning, str) or not warning.strip():
            continue
        cleaned = _qualitative_text(warning, set(allowed_identifiers), language)
        if cleaned:
            warnings.append(cleaned)
        if len(warnings) >= 10:
            break

    freshness = grounding.get("data_freshness")
    data_is_stale = freshness.get("is_stale") if isinstance(freshness, dict) else None
    analysis_constraints = {}
    if isinstance(analysis_skill, dict):
        analysis_constraints = {
            "mode": analysis_skill.get("mode"),
            "focus_identifiers": analysis_skill.get("focus_identifiers") or [],
            "limitations": analysis_skill.get("limitations") or [],
            "answer_constraints": analysis_skill.get("answer_constraints") or {},
        }
    return {
        "process_statuses": process_statuses,
        "equipment_and_part_statuses": row_statuses,
        "warnings": warnings,
        "data_is_stale": data_is_stale if isinstance(data_is_stale, bool) else None,
        "analysis_constraints": analysis_constraints,
    }


def build_repair_payload(
    job: dict[str, Any],
    candidate: dict[str, Any],
    grounding: dict[str, Any],
) -> dict[str, Any]:
    """Build a qualitative-only retry payload without authoritative measurements."""
    language = "zh" if (job.get("input_payload") or {}).get("language") == "zh" else "ko"
    candidate_text = " ".join([
        str(candidate.get("title") or ""),
        str(candidate.get("summary") or ""),
    ])
    question = (job.get("input_payload") or {}).get("question") or ""
    exact_identifiers = _prioritized_exact_identifiers(
        grounding,
        candidate_text,
        str(question),
    )
    analysis_skill = grounding.get("analysis_skill")
    focus_keys = {
        str(identifier).strip().casefold()
        for identifier in (
            analysis_skill.get("focus_identifiers") or []
            if isinstance(analysis_skill, dict)
            else []
        )
        if str(identifier).strip()
    }
    if focus_keys:
        exact_identifiers = [
            identifier for identifier in exact_identifiers
            if identifier.casefold() in focus_keys
        ]
    allowed_identifiers = set(exact_identifiers)
    limitations = set(
        analysis_skill.get("limitations") or []
        if isinstance(analysis_skill, dict)
        else []
    )
    discard_rejected_summary = bool(
        limitations.intersection({
            "historical_snapshots_unavailable",
            "target_level_history_unavailable",
        })
    )
    return {
        "language": language,
        "question_topic": _qualitative_text(question, allowed_identifiers, language),
        "qualitative_draft": {
            "title": _qualitative_text(candidate.get("title"), allowed_identifiers, language),
            "summary": "" if discard_rejected_summary else _qualitative_text(
                candidate.get("summary"),
                allowed_identifiers,
                language,
            ),
        },
        "verified_qualitative_evidence": _verified_qualitative_evidence(
            grounding,
            exact_identifiers,
            language,
        ),
        "allowed_exact_identifiers": exact_identifiers,
        "instruction": (
            "한국어 JSON으로 결론, 판단 근거, 확인할 항목 순서의 구체적인 정성 설명만 반환하세요. "
            "검증된 상태와 정확한 설비 식별자를 우선 사용하고 원시 상태코드와 일부/대부분 표현은 쓰지 마세요. "
            "검증 수치 표식은 문맥에 맞는 정성 표현으로 바꾸세요."
            if language == "ko"
            else "仅返回按结论、判断依据、需确认顺序组织的具体中文 JSON 定性说明；"
            "优先使用已验证的状态和准确设备标识符，不得输出原始状态代码或模糊数量词；"
            "将数值占位改为符合语境的定性表达。"
        ),
    }


def _summary_claims_are_safe(
    summary: str,
    grounding: dict[str, Any],
    *,
    enforce_quality: bool,
) -> bool:
    text = str(summary or "")
    verified_facts = grounding.get("verified_facts")
    missing_active_machine_data = (
        isinstance(verified_facts, dict)
        and verified_facts.get("metric") == "injection_active_machine_count"
        and verified_facts.get("active_machine_count") is None
    )
    if missing_active_machine_data:
        for clause in CLAUSE_SPLIT.split(text):
            if MISSING_ACTIVE_MACHINE_ZERO_CLAIM.search(clause):
                return False
            if (
                ACTIVE_MACHINE_SUBJECT.search(clause)
                and NEGATIVE_EXISTENCE_CLAIM.search(clause)
                and not DATA_UNAVAILABLE_LIMITATION.search(clause)
            ):
                return False
    if RAW_STATUS_TOKEN.search(text):
        return False
    if enforce_quality and VAGUE_QUANTIFIER.search(text) and _verified_exact_identifiers(grounding):
        return False
    if UNSUPPORTED_CAUSAL_ASSERTION.search(text) or UNSUPPORTED_OPERATIONAL_DIRECTIVE.search(text):
        return False
    if enforce_quality and REDUNDANT_STATUS_RECHECK.search(text):
        return False
    for clause in CLAUSE_SPLIT.split(text):
        if (
            UNVERIFIED_CAUSE_SOURCE.search(clause)
            and UNVERIFIED_CAUSE_EFFECT.search(clause)
            and not CHECK_OR_INFORMATION_LIMITATION.search(clause)
        ):
            # Question jobs do not carry verified root-cause facts. If a
            # clause joins an operational cause candidate with an adverse
            # effect, reject it unless it is explicitly framed as something
            # to verify. This avoids depending on an open-ended Korean/Chinese
            # causal-verb allow-list.
            return False
        if RISK_ASSERTION.search(clause) and not CHECK_OR_INFORMATION_LIMITATION.search(clause):
            return False
        if DIRECTIVE_MARKER.search(clause) and not SAFE_ANALYSIS_ACTION.search(clause):
            return False
    analysis_skill = grounding.get("analysis_skill")
    if not isinstance(analysis_skill, dict):
        return True
    limitations = set(analysis_skill.get("limitations") or [])
    if limitations.intersection({"historical_snapshots_unavailable", "target_level_history_unavailable"}):
        if not TREND_TERM.search(text) or not UNAVAILABLE_TREND.search(text):
            return False
        if UNSUPPORTED_TARGET_TREND.search(text):
            return False
    focus_identifiers = {
        str(identifier).strip().casefold()
        for identifier in analysis_skill.get("focus_identifiers") or []
        if str(identifier).strip()
    }
    if focus_identifiers:
        for identifier in _verified_exact_identifiers(grounding):
            if identifier.casefold() in focus_identifiers:
                continue
            if _identifier_spans(text, identifier.casefold()):
                return False
    return True


def summary_is_specific(summary: str, grounding: dict[str, Any]) -> bool:
    """Diagnostic quality check retained for tests and observability."""
    return _summary_claims_are_safe(summary, grounding, enforce_quality=True)


def summary_claims_are_safe(summary: str, grounding: dict[str, Any]) -> bool:
    """Reject factual grounding risks without replacing an answer for style alone."""
    return _summary_claims_are_safe(summary, grounding, enforce_quality=False)


def summary_quality_warnings(summary: str, grounding: dict[str, Any]) -> list[str]:
    warnings = []
    text = str(summary or "")
    if VAGUE_QUANTIFIER.search(text) and _verified_exact_identifiers(grounding):
        warnings.append("vague_quantifier")
    if REDUNDANT_STATUS_RECHECK.search(text):
        warnings.append("redundant_status_recheck")
    return warnings


def prune_redundant_numeric_lines(
    summary: str,
    verified_answer: str,
    grounding: dict[str, Any],
) -> tuple[str, bool]:
    """Keep a verbatim verified answer and drop only extra ungrounded numeric lines.

    Qwen sometimes follows the instruction to quote the server answer, then
    repeats the same count or duration in an evidence bullet with different
    spacing. The duplicate fails strict clause grounding even though the first
    Qwen response is otherwise useful. Removing that redundant line preserves
    the original response without invoking a second, generic rewrite.
    """
    verified = str(verified_answer or "").strip()
    normalized_verified = " ".join(verified.split())
    if not normalized_verified:
        return summary, False

    verified_pattern = r"\s+".join(
        re.escape(token) for token in normalized_verified.split(" ")
    )
    verified_match = re.search(verified_pattern, summary)
    if not verified_match:
        return summary, False

    # Isolate the authoritative answer on its own line. This preserves it even
    # when Qwen inserted a visual line wrap in the middle of a sentence.
    prefix = summary[:verified_match.start()].rstrip(" \t")
    suffix = summary[verified_match.end():].lstrip(" \t")
    before = "" if not prefix or prefix.endswith("\n") else "\n"
    after = "" if not suffix or suffix.startswith("\n") else "\n"
    summary = f"{prefix}{before}{normalized_verified}{after}{suffix}"

    kept_lines = []
    pruned = False
    for line in summary.splitlines():
        if summary_numbers_are_grounded(line, grounding):
            kept_lines.append(line)
        else:
            pruned = True
    cleaned = re.sub(r"\n{3,}", "\n\n", "\n".join(kept_lines)).strip()
    return cleaned, pruned


def prune_ungrounded_numeric_lines(
    summary: str,
    grounding: dict[str, Any],
) -> tuple[str, bool]:
    """Drop only model-written lines containing unverified quantities.

    A model can produce a useful grounded conclusion and then add one unsafe
    numeric bullet. Rejecting the whole answer hides the selected model even
    though the safe prose is still usable. This keeps headings and grounded
    lines, while the final whole-summary safety check still rejects unsupported
    causes, directives, statuses, and identifiers.
    """
    kept_lines: list[str] = []
    pruned = False
    for line in str(summary or "").splitlines():
        stripped = line.strip()
        if not stripped or SECTION_HEADING.fullmatch(stripped.rstrip(":")):
            kept_lines.append(line)
            continue
        if summary_numbers_are_grounded(line, grounding):
            kept_lines.append(line)
        else:
            pruned = True
    cleaned = re.sub(r"\n{3,}", "\n\n", "\n".join(kept_lines)).strip()
    return cleaned, pruned


def naturalize_schema_terms(summary: str) -> tuple[str, bool]:
    is_zh = bool(re.search(r"(?:结论|判断依据|需确认)", summary))
    normalized = summary
    changed = False
    for raw_term, replacements in RAW_SCHEMA_TERMS.items():
        replacement = replacements[1] if is_zh else replacements[0]
        updated = re.sub(
            rf"(?<![A-Za-z0-9_]){raw_term}(?![A-Za-z0-9_])",
            replacement,
            normalized,
            flags=re.IGNORECASE,
        )
        if updated != normalized:
            changed = True
            normalized = updated
    return normalized, changed


def classify_llm_error(exc: Exception) -> str:
    if isinstance(exc, LlmGroundingError):
        return "grounding_rejected"
    name = exc.__class__.__name__.lower()
    message = str(exc).lower()
    if "timeout" in name or "timed out" in message or "timeout" in message:
        return "timeout"
    if "http" in name or "connection" in name or "connection" in message:
        return "model_unavailable"
    if isinstance(exc, (ValueError, KeyError, TypeError)):
        return "invalid_response"
    return "model_error"


def normalize_result(
    result: dict[str, Any],
    fallback: dict[str, Any],
    model_name: str,
    grounding: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Accept prose from the LLM while keeping every fact and issue deterministic."""
    candidate = dict(result or {})
    title = candidate.get("title")
    summary = candidate.get("summary")
    if not isinstance(title, str) or not title.strip():
        title = fallback.get("title") or "Local AI Analysis"
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("LLM response did not contain a summary string.")
    summary = NUMBERED_LIST_MARKER.sub(r"\1- ", summary.strip())
    summary = INLINE_SECTION_HEADING.sub(r"\1:\n", summary)
    summary = SECTION_HEADING.sub(r"\1:", summary)[:2000]
    summary, schema_terms_normalized = naturalize_schema_terms(summary)
    authoritative_grounding = dict(grounding or {})
    authoritative_grounding["deterministic_answer"] = fallback.get("answer") or ""
    authoritative_grounding["deterministic_summary"] = fallback.get("summary") or ""
    summary, numeric_lines_pruned = prune_redundant_numeric_lines(
        summary,
        fallback.get("answer") or "",
        authoritative_grounding,
    )
    if not summary_numbers_are_grounded(summary, authoritative_grounding):
        summary, additional_numeric_lines_pruned = prune_ungrounded_numeric_lines(
            summary,
            authoritative_grounding,
        )
        numeric_lines_pruned = numeric_lines_pruned or additional_numeric_lines_pruned
    summary, empty_sections_removed = EMPTY_REASONING_SECTION.subn("", summary)
    summary = re.sub(r"\n{3,}", "\n\n", summary).strip()
    substantive_lines = [
        line.strip(" \t-*•")
        for line in summary.splitlines()
        if line.strip()
        and not SECTION_HEADING.fullmatch(line.strip().rstrip(":"))
    ]
    if not any(substantive_lines):
        raise LlmGroundingError(
            "LLM prose introduced an unverified number and had no grounded answer after safety pruning.",
            candidate,
        )
    title_was_replaced = not summary_numbers_are_grounded(title, authoritative_grounding)
    if title_was_replaced:
        title = fallback.get("title") or "Local AI Analysis"
    if not summary_numbers_are_grounded(summary, authoritative_grounding):
        raise LlmGroundingError("LLM prose introduced an unverified number.", candidate)
    if authoritative_grounding.get("analysis_skill") and not summary_claims_are_safe(summary, authoritative_grounding):
        raise LlmGroundingError("LLM prose introduced an unsupported claim or identifier.", candidate)

    normalized = dict(fallback)
    normalized.update({
        "title": title.strip()[:200],
        "summary": summary,
        "model_name": model_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "local_llm_rewrite",
    })
    if title_was_replaced:
        normalized["llm_title_fallback"] = True
    if numeric_lines_pruned:
        normalized["llm_numeric_lines_pruned"] = True
    if schema_terms_normalized:
        normalized["llm_schema_terms_normalized"] = True
    if empty_sections_removed:
        normalized["llm_empty_sections_removed"] = True
    quality_warnings = summary_quality_warnings(summary, authoritative_grounding)
    if quality_warnings:
        normalized["llm_quality_warnings"] = quality_warnings
    return normalized


def handle_job(
    job: dict,
    use_llm: bool,
    llm: LocalLlmClient | None,
    model_name: str,
    fallback_to_deterministic: bool,
) -> tuple[dict, str]:
    job_type = job.get("job_type")
    handler = handler_for_job(job)
    if not handler:
        raise ValueError(f"Unsupported job type: {job_type}")

    if hasattr(handler, "validate_job"):
        handler.validate_job(job)

    deterministic = handler.build_dummy_result(job, model_name="deterministic-local-worker")
    if use_llm and llm:
        result: dict[str, Any] = {}
        first_candidate: dict[str, Any] = {}
        attempts = 0
        initial_grounding_rejected = False
        try:
            llm_payload = handler.build_llm_payload(job) if hasattr(handler, "build_llm_payload") else (job.get("input_payload") or {})
            grounding_payload = (
                handler.build_grounding_payload(job)
                if hasattr(handler, "build_grounding_payload")
                else llm_payload
            )
            attempts = 1
            llm_options: dict[str, Any] = {}
            if getattr(handler, "ENABLE_THINKING", False):
                llm_options = {
                    "enable_thinking": True,
                    "thinking_budget": int(getattr(handler, "THINKING_BUDGET", 384)),
                }
            initial_timeout = getattr(handler, "INITIAL_TIMEOUT_SECONDS", None)
            if initial_timeout is not None:
                llm_options["timeout_seconds"] = max(1, int(initial_timeout))
            required_output_schema = getattr(handler, "REQUIRED_OUTPUT_SCHEMA", {
                "title": "string",
                "summary": "string",
            })
            result = llm.structured_analysis(handler.SYSTEM_PROMPT, {
                "job_type": job_type,
                "scope": job.get("scope") or {},
                "input_payload": llm_payload,
                "required_output_schema": required_output_schema,
            }, **llm_options)
            first_candidate = dict(result or {})
            if hasattr(handler, "normalize_llm_result"):
                normalized = handler.normalize_llm_result(
                    result,
                    deterministic,
                    model_name,
                    llm_payload,
                    grounding_payload,
                )
                normalized["llm_attempted"] = True
                normalized["llm_attempts"] = attempts
                return normalized, handler.PROMPT_VERSION
            try:
                normalized = normalize_result(result, deterministic, model_name, grounding_payload)
            except LlmGroundingError:
                initial_grounding_rejected = True
                attempts = 2
                repair_payload = build_repair_payload(job, first_candidate, grounding_payload)
                repair_options: dict[str, Any] = {}
                repair_timeout = getattr(handler, "REPAIR_TIMEOUT_SECONDS", None)
                if repair_timeout is not None:
                    repair_options["timeout_seconds"] = max(1, int(repair_timeout))
                result = llm.structured_analysis(REPAIR_SYSTEM_PROMPT, {
                    "job_type": job_type,
                    "input_payload": repair_payload,
                    "required_output_schema": {
                        "title": "string",
                        "summary": "string",
                    },
                }, **repair_options)
                normalized = normalize_result(result, deterministic, model_name, grounding_payload)
                normalized["llm_repaired"] = True
            if hasattr(handler, "enrich_summary"):
                enriched_summary = handler.enrich_summary(normalized["summary"], llm_payload)
                if not summary_numbers_are_grounded(enriched_summary, grounding_payload):
                    raise LlmGroundingError("Worker metric enrichment failed grounding validation.", result)
                if RAW_STATUS_TOKEN.search(enriched_summary):
                    raise LlmGroundingError("Worker metric enrichment exposed a raw status token.", result)
                normalized["summary"] = enriched_summary[:4000]
            normalized["llm_attempted"] = True
            normalized["llm_attempts"] = attempts
            return normalized, handler.PROMPT_VERSION
        except Exception as exc:
            if not fallback_to_deterministic:
                raise
            fallback_code = classify_llm_error(exc)
            deterministic["llm_fallback"] = True
            deterministic["llm_attempted"] = True
            deterministic["llm_attempts"] = attempts
            deterministic["llm_fallback_code"] = fallback_code
            if initial_grounding_rejected:
                deterministic["llm_initial_grounding_rejected"] = True
            deterministic["llm_error"] = str(exc)[:500]
            deterministic["model_name"] = model_name
            deterministic["source"] = "local_llm_guarded_fallback"
            review_candidate = first_candidate or (result if isinstance(result, dict) else {})
            review_title = review_candidate.get("title")
            review_summary = review_candidate.get("summary")
            if isinstance(review_title, str) and review_title.strip():
                deterministic["llm_review_title"] = review_title.strip()[:200]
            if isinstance(review_summary, str) and review_summary.strip():
                deterministic["llm_review_summary"] = review_summary.strip()[:2000]
            return deterministic, handler.PROMPT_VERSION

    if getattr(handler, "REQUIRE_LLM_FOR_READY_RESULT", False):
        deterministic.update({
            "source": "local_llm_guarded_fallback",
            "llm_fallback": True,
            "llm_attempted": False,
            "llm_attempts": 0,
            "llm_fallback_code": "llm_disabled",
            "llm_error": "Local LLM execution was disabled for this Worker run.",
        })
    else:
        deterministic["source"] = "deterministic"
    return deterministic, handler.PROMPT_VERSION


def run_once(
    client: RenderClient,
    worker_name: str,
    use_llm: bool,
    llm: LocalLlmClient | None,
    model_name: str,
    fallback_to_deterministic: bool,
    enqueue_periodic: bool,
    report: RunOnceReport | None = None,
    model_targets: dict[str, LocalModelTarget] | None = None,
    default_model_id: str = QWEN_MODEL_ID,
) -> int:
    report = report if report is not None else RunOnceReport()
    if enqueue_periodic:
        try:
            client.enqueue_periodic_jobs()
        except Exception as exc:
            message = f"periodic enqueue failed: {exc}"
            report.add(message, failure=True)
            print(message, file=sys.stderr)
    jobs = client.claim_jobs(
        worker_name,
        limit=1,
        job_types=list(HANDLERS.keys()),
        worker_version=WORKER_VERSION,
    )
    if not jobs:
        return 0

    for job in jobs:
        job_id = int(job["id"])
        handler = handler_for_job(job)
        allow_unavailable_fallback = bool(
            fallback_to_deterministic
            and handler
            and getattr(handler, "ALLOW_UNAVAILABLE_MODEL_FALLBACK", False)
        )
        selected_llm = llm
        selected_model_name = model_name
        selected_model_id = default_model_id
        model_unavailable_error = ""
        try:
            selected_model_id = requested_model_id(job, default_model_id)
            if model_targets is not None:
                target = model_targets.get(selected_model_id)
                if target is None:
                    if not allow_unavailable_fallback:
                        raise ValueError(f"Local AI model is not configured: {selected_model_id}")
                    selected_llm = None
                    selected_model_name = ""
                    model_unavailable_error = f"Local AI model is not configured: {selected_model_id}"
                else:
                    selected_llm = target.client
                    selected_model_name = target.model_name
            job_use_llm = use_llm
            if use_llm and not model_unavailable_error:
                if selected_llm is None:
                    model_unavailable_error = f"Local AI model is not configured: {selected_model_id}"
                else:
                    readiness_check = getattr(selected_llm, "is_ready", None)
                    if callable(readiness_check) and not readiness_check(timeout=3):
                        model_unavailable_error = f"Local AI model is unavailable: {selected_model_id}"
                if model_unavailable_error:
                    if not allow_unavailable_fallback:
                        raise RuntimeError(model_unavailable_error)
                    job_use_llm = False
            client.start_job(job_id)
            result, prompt_version = handle_job(
                job,
                job_use_llm,
                selected_llm,
                selected_model_name,
                fallback_to_deterministic,
            )
            if model_unavailable_error:
                result.update({
                    "llm_fallback": True,
                    "llm_attempted": True,
                    "llm_attempts": 0,
                    "llm_fallback_code": "model_unavailable",
                    "llm_error": model_unavailable_error,
                    "model_name": selected_model_name,
                    "source": "local_llm_guarded_fallback",
                })
            result["model_id"] = selected_model_id
            if result.get("llm_fallback") and result.get("llm_error"):
                fallback_code = result.get("llm_fallback_code") or "model_error"
                fallback_message = f"ai job {job_id} LLM fallback [{fallback_code}]: {result['llm_error']}"
                report.add(fallback_message)
                print(fallback_message, file=sys.stderr)
            client.complete_job(
                job_id,
                result_payload=result,
                model_name=result.get("model_name") or selected_model_name,
                prompt_version=prompt_version,
            )
            print(f"completed ai job {job_id} with {selected_model_id}")
        except Exception as exc:
            message = f"ai job {job_id} failed: {exc}"
            report.add(message, failure=True)
            try:
                client.fail_job(job_id, str(exc), model_name=selected_model_name)
            except Exception as fail_exc:
                report.add(f"ai job {job_id} fail transition failed: {fail_exc}", failure=True)
            print(message, file=sys.stderr)
    return len(jobs)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="claim and process at most one batch")
    parser.add_argument("--check-llm", action="store_true", help="verify the configured local LLM endpoint")
    args = parser.parse_args()

    env_path = Path(__file__).resolve().parent / ".env"
    load_dotenv(env_path)

    api_base_url = os.getenv("RENDER_API_BASE_URL", "http://127.0.0.1:8000/api")
    worker_token = os.getenv("AI_WORKER_TOKEN", "")
    worker_name = os.getenv("WORKER_NAME", "mac-studio-local-ai")
    poll_interval = max(1, int(os.getenv("POLL_INTERVAL_SECONDS", "5") or 5))
    periodic_check_interval = max(60, int(os.getenv("PERIODIC_ENQUEUE_CHECK_SECONDS", "60") or 60))
    heartbeat_interval = max(15, int(os.getenv("AI_WORKER_HEARTBEAT_SECONDS", "30") or 30))
    use_llm = truthy(os.getenv("AI_WORKER_USE_LLM"))
    fallback_to_deterministic = truthy(os.getenv("AI_WORKER_FALLBACK_TO_DETERMINISTIC", "true"))
    enqueue_periodic = truthy(os.getenv("AI_WORKER_ENQUEUE_PERIODIC", "true"))
    qwen_model = os.getenv(
        "LOCAL_LLM_MODEL",
        "/Users/macstudio_ted/Developer/local-ai/models/Qwen3.5-35B-A3B-4bit",
    )
    gemma_model = os.getenv(
        "LOCAL_GEMMA_MODEL",
        "/Users/macstudio_ted/Developer/local-ai/models/gemma-4-26b-a4b-it-4bit",
    )
    default_model_id = os.getenv("LOCAL_LLM_DEFAULT_MODEL_ID", QWEN_MODEL_ID).strip()
    if default_model_id not in SUPPORTED_MODEL_IDS:
        print(f"Unsupported LOCAL_LLM_DEFAULT_MODEL_ID: {default_model_id}", file=sys.stderr)
        return 2
    # Heartbeats share this single-threaded loop with inference. Keep the LLM timeout
    # below the backend's 180-second stale threshold, leaving time for API transitions.
    llm_timeout = min(120, max(5, int(os.getenv("LOCAL_LLM_TIMEOUT_SECONDS", "45") or 45)))

    if not worker_token:
        print("AI_WORKER_TOKEN is required.", file=sys.stderr)
        return 2

    client = RenderClient(api_base_url=api_base_url, worker_token=worker_token)
    llm = None
    model_targets: dict[str, LocalModelTarget] = {}
    if use_llm:
        qwen_llm = LocalLlmClient(
            base_url=os.getenv("LOCAL_LLM_BASE_URL", "http://127.0.0.1:8080/v1"),
            model=qwen_model,
            timeout=llm_timeout,
            model_family="qwen",
        )
        gemma_llm = LocalLlmClient(
            base_url=os.getenv("LOCAL_GEMMA_BASE_URL", "http://127.0.0.1:8081/v1"),
            model=gemma_model,
            timeout=llm_timeout,
            model_family="gemma4",
        )
        model_targets = {
            QWEN_MODEL_ID: LocalModelTarget(QWEN_MODEL_ID, qwen_llm, qwen_model),
            GEMMA_MODEL_ID: LocalModelTarget(GEMMA_MODEL_ID, gemma_llm, gemma_model),
        }
        llm = model_targets[default_model_id].client

    if args.check_llm:
        if not llm:
            print("AI_WORKER_USE_LLM=true is required for --check-llm.", file=sys.stderr)
            return 2
        for model_id, target in model_targets.items():
            if target.client is None or not target.client.is_ready(timeout=5):
                print(f"{model_id}: unavailable", file=sys.stderr)
                return 1
            result = target.client.structured_analysis(
                "Return only a JSON object with status set to ok.",
                {"task": "health_check", "expected_status": "ok"},
            )
            if not health_check_passed(result):
                print(f"{model_id}: invalid health-check response", file=sys.stderr)
                return 1
            print(f"{model_id}: ready ({Path(target.model_name).name})")
        return 0

    next_periodic_check = 0.0
    next_heartbeat = 0.0
    last_worker_error = ""
    default_target = model_targets.get(default_model_id)
    while True:
        monotonic_now = time.monotonic()
        should_enqueue_periodic = enqueue_periodic and monotonic_now >= next_periodic_check
        if monotonic_now >= next_heartbeat:
            model_readiness = {
                model_id: bool(target.client and target.client.is_ready(timeout=3))
                for model_id, target in model_targets.items()
            }
            llm_ready = model_readiness.get(default_model_id, False)
            reported_worker_version = heartbeat_worker_version(model_readiness)
            try:
                client.send_heartbeat(
                    worker_name,
                    llm_enabled=use_llm,
                    llm_ready=llm_ready,
                    model_name=default_target.model_name if default_target else "",
                    worker_version=reported_worker_version,
                    last_error=last_worker_error,
                    available_model_ids=[
                        model_id
                        for model_id, is_ready in model_readiness.items()
                        if is_ready
                    ],
                )
                last_worker_error = ""
            except Exception as exc:
                print(f"worker heartbeat failed: {exc}", file=sys.stderr)
            next_heartbeat = monotonic_now + heartbeat_interval
        try:
            run_report = RunOnceReport()
            run_once(
                client,
                worker_name,
                use_llm,
                llm,
                default_target.model_name if default_target else "",
                fallback_to_deterministic,
                should_enqueue_periodic,
                report=run_report,
                model_targets=model_targets if use_llm else None,
                default_model_id=default_model_id,
            )
            if run_report.messages:
                last_worker_error = run_report.summary()
            if args.once and run_report.had_failure:
                return 1
        except Exception as exc:
            last_worker_error = str(exc)[:500]
            print(f"worker polling failed: {exc}", file=sys.stderr)
            if args.once:
                return 1
        if should_enqueue_periodic:
            next_periodic_check = monotonic_now + periodic_check_interval
        if args.once:
            return 0
        time.sleep(poll_interval)


if __name__ == "__main__":
    raise SystemExit(main())
