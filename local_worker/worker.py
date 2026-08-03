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
    from .job_handlers import production_daily_analysis, production_machine_analysis, production_question_analysis
    from .llm_client import LocalLlmClient
    from .render_client import RenderClient, WORKER_VERSION
except ImportError:
    from job_handlers import production_daily_analysis, production_machine_analysis, production_question_analysis
    from llm_client import LocalLlmClient
    from render_client import RenderClient, WORKER_VERSION


HANDLERS = {
    "production_daily_analysis": production_daily_analysis,
    "production_machine_analysis": production_machine_analysis,
}

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
    rf"(?:{KOREAN_SPELLED_NUMBER}{KOREAN_APPROXIMATION}\s*{KOREAN_QUANTITY_UNIT}"
    rf"|(?:백분의|천분의)\s*{KOREAN_SPELLED_NUMBER}"
    r"|절반|반절"
    rf"|{CHINESE_SPELLED_NUMBER}{CHINESE_APPROXIMATION}\s*{CHINESE_QUANTITY_UNIT}"
    rf"|(?:百分之|千分之)\s*{CHINESE_SPELLED_NUMBER}"
    r"|一半|半数|半數)"
)

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
    if not identifier:
        return []
    folded = text.casefold()
    spans = []
    offset = 0
    while True:
        start = folded.find(identifier, offset)
        if start < 0:
            break
        end = start + len(identifier)
        before = folded[start - 1] if start > 0 else ""
        after = folded[end] if end < len(folded) else ""
        first = identifier[0]
        last = identifier[-1]
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
        if normalized_key in TRUSTED_PROSE_KEYS and isinstance(value, str):
            clauses.update(
                _canonical_claim_clause(clause.strip())
                for clause in CLAUSE_SPLIT.split(value)
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
        if SPELLED_QUANTITY.search(clause):
            return False
        matched = _matched_identifiers(clause, records)
        numbers = _numbers_in_claim(clause, all_identifiers)
        if not numbers:
            continue
        if not matched:
            return False
        # Numeric prose must preserve a complete deterministic clause. This is
        # intentionally stricter than a value allow-list: it prevents swapping
        # plan/actual fields or values between subjects that share one row.
        if _canonical_claim_clause(clause) not in authoritative_claim_clauses:
            return False
    return True


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
    summary = summary.strip()[:2000]
    authoritative_grounding = dict(grounding or {})
    authoritative_grounding["deterministic_answer"] = fallback.get("answer") or ""
    authoritative_grounding["deterministic_summary"] = fallback.get("summary") or ""
    if (
        not summary_numbers_are_grounded(title, authoritative_grounding)
        or not summary_numbers_are_grounded(summary, authoritative_grounding)
    ):
        raise ValueError("LLM prose introduced an unverified number.")

    normalized = dict(fallback)
    normalized.update({
        "title": title.strip()[:200],
        "summary": summary,
        "model_name": model_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "local_llm_rewrite",
    })
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

    deterministic = handler.build_dummy_result(job, model_name="deterministic-local-worker")
    if use_llm and llm:
        try:
            llm_payload = handler.build_llm_payload(job) if hasattr(handler, "build_llm_payload") else (job.get("input_payload") or {})
            result = llm.structured_analysis(handler.SYSTEM_PROMPT, {
                "job_type": job_type,
                "scope": job.get("scope") or {},
                "input_payload": llm_payload,
                "required_output_schema": {
                    "title": "string",
                    "summary": "string",
                },
            })
            grounding_payload = (
                handler.build_grounding_payload(job)
                if hasattr(handler, "build_grounding_payload")
                else llm_payload
            )
            return normalize_result(result, deterministic, model_name, grounding_payload), handler.PROMPT_VERSION
        except Exception as exc:
            if not fallback_to_deterministic:
                raise
            deterministic["llm_fallback"] = True
            deterministic["llm_error"] = str(exc)[:500]
            deterministic["model_name"] = "deterministic-local-worker"
            deterministic["source"] = "deterministic_fallback"
            return deterministic, handler.PROMPT_VERSION

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
        try:
            client.start_job(job_id)
            result, prompt_version = handle_job(job, use_llm, llm, model_name, fallback_to_deterministic)
            if result.get("llm_fallback") and result.get("llm_error"):
                report.add(f"ai job {job_id} LLM fallback: {result['llm_error']}")
            client.complete_job(
                job_id,
                result_payload=result,
                model_name=result.get("model_name") or model_name,
                prompt_version=prompt_version,
            )
            print(f"completed ai job {job_id}")
        except Exception as exc:
            message = f"ai job {job_id} failed: {exc}"
            report.add(message, failure=True)
            try:
                client.fail_job(job_id, str(exc), model_name=model_name)
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
    local_model = os.getenv(
        "LOCAL_LLM_MODEL",
        "/Users/macstudio_ted/Developer/local-ai/models/Qwen3.5-35B-A3B-4bit",
    )
    # Heartbeats share this single-threaded loop with inference. Keep the LLM timeout
    # below the backend's 180-second stale threshold, leaving time for API transitions.
    llm_timeout = min(120, max(5, int(os.getenv("LOCAL_LLM_TIMEOUT_SECONDS", "45") or 45)))

    if not worker_token:
        print("AI_WORKER_TOKEN is required.", file=sys.stderr)
        return 2

    client = RenderClient(api_base_url=api_base_url, worker_token=worker_token)
    llm = None
    if use_llm:
        llm = LocalLlmClient(
            base_url=os.getenv("LOCAL_LLM_BASE_URL", "http://127.0.0.1:8080/v1"),
            model=local_model,
            timeout=llm_timeout,
        )

    if args.check_llm:
        if not llm:
            print("AI_WORKER_USE_LLM=true is required for --check-llm.", file=sys.stderr)
            return 2
        result = llm.structured_analysis(
            "Return only a JSON object with status and model_name.",
            {"task": "health_check", "expected_status": "ok"},
        )
        print(result)
        return 0

    next_periodic_check = 0.0
    next_heartbeat = 0.0
    last_worker_error = ""
    while True:
        monotonic_now = time.monotonic()
        should_enqueue_periodic = enqueue_periodic and monotonic_now >= next_periodic_check
        if monotonic_now >= next_heartbeat:
            llm_ready = llm.is_ready(timeout=3) if llm else False
            try:
                client.send_heartbeat(
                    worker_name,
                    llm_enabled=use_llm,
                    llm_ready=llm_ready,
                    model_name=local_model if use_llm else "",
                    worker_version=WORKER_VERSION,
                    last_error=last_worker_error,
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
                local_model,
                fallback_to_deterministic,
                should_enqueue_periodic,
                report=run_report,
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
