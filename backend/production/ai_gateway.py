from __future__ import annotations

import os
import re
import json
from datetime import datetime, time, timedelta
from typing import Any

import pytz
import requests
from django.utils import timezone

from injection.models import InjectionMonitoringRecord

from .models import ProductionPartCavity, ProductionPlan


DEFAULT_MODEL = "mlx-community/gemma-4-e2b-it-8bit"
DEFAULT_LLM_BASE_URL = "http://127.0.0.1:8080/v1"
MACHINE_TONNAGE = {
    1: "850T",
    2: "850T",
    3: "1300T",
    4: "1400T",
    5: "1400T",
    6: "2500T",
    7: "1800T",
    8: "850T",
    9: "850T",
    10: "650T",
    11: "550T",
    12: "550T",
    13: "450T",
    14: "850T",
    15: "650T",
    16: "1050T",
    17: "1200T",
}


def machine_name_from_number(machine_number: int) -> str:
    return f"{machine_number}호기"


def machine_label_from_number(machine_number: int) -> str:
    tonnage = MACHINE_TONNAGE.get(machine_number, f"{machine_number * 50}T")
    return f"{tonnage}-{machine_number}"


def parse_machine_number(machine_name: str | None) -> int | None:
    if not machine_name:
        return None
    digits = "".join(ch for ch in str(machine_name).split("-")[-1] if ch.isdigit())
    if not digits:
        digits = "".join(ch for ch in str(machine_name) if ch.isdigit())
    try:
        return int(digits)
    except (TypeError, ValueError):
        return None


def get_business_range(business_date: Any) -> tuple[datetime, datetime]:
    cst = pytz.timezone("Asia/Shanghai")
    if isinstance(business_date, str):
        day = datetime.strptime(business_date, "%Y-%m-%d").date()
    else:
        day = business_date
    start = cst.localize(datetime.combine(day, time(8, 0, 0)))
    return start, start + timedelta(days=1)


def latest_record_time(start: datetime, end: datetime) -> datetime:
    latest = (
        InjectionMonitoringRecord.objects
        .filter(timestamp__gte=start, timestamp__lt=end)
        .order_by("-timestamp")
        .values_list("timestamp", flat=True)
        .first()
    )
    if latest:
        return latest.astimezone(pytz.timezone("Asia/Shanghai"))
    now = timezone.now().astimezone(pytz.timezone("Asia/Shanghai"))
    return min(max(now, start), end)


def capacity_delta(machine_name: str, start: datetime, end: datetime) -> int:
    before = (
        InjectionMonitoringRecord.objects
        .filter(machine_name=machine_name, timestamp__lt=start, capacity__isnull=False)
        .order_by("-timestamp")
        .values_list("capacity", flat=True)
        .first()
    )
    latest = (
        InjectionMonitoringRecord.objects
        .filter(machine_name=machine_name, timestamp__gte=start, timestamp__lte=end, capacity__isnull=False)
        .order_by("-timestamp")
        .values_list("capacity", flat=True)
        .first()
    )
    if before is None or latest is None:
        return 0
    delta = float(latest) - float(before)
    return int(round(delta)) if delta > 0 else 0


def build_injection_plan_context(business_date: str) -> dict[str, Any]:
    start, end = get_business_range(business_date)
    latest_time = latest_record_time(start, end)
    recent_start = max(start, latest_time - timedelta(minutes=60))

    plans = list(
        ProductionPlan.objects
        .filter(plan_date=business_date, plan_type="injection", planned_quantity__gt=0)
        .order_by("machine_name", "sequence", "id")
        .values(
            "machine_name",
            "lot_no",
            "model_name",
            "part_spec",
            "product_family_code",
            "product_family_name",
            "is_finished_product",
            "part_no",
            "planned_quantity",
            "sequence",
        )
    )
    part_nos = sorted({(row.get("part_no") or "").strip().upper() for row in plans if row.get("part_no")})
    cavity_map = {
        (row["part_no"] or "").strip().upper(): int(row["cavity"] or 1)
        for row in ProductionPartCavity.objects.filter(part_no__in=part_nos).values("part_no", "cavity")
    }

    plans_by_machine: dict[int, list[dict[str, Any]]] = {}
    for row in plans:
        machine_number = parse_machine_number(row.get("machine_name"))
        if not machine_number:
            continue
        row["planned_quantity"] = int(round(float(row.get("planned_quantity") or 0)))
        row["part_no"] = (row.get("part_no") or "").strip().upper()
        row["cavity"] = max(1, int(cavity_map.get(row["part_no"], 1) or 1))
        plans_by_machine.setdefault(machine_number, []).append(row)

    machines = []
    for machine_number in range(1, 18):
        machine_name = machine_name_from_number(machine_number)
        day_shots = capacity_delta(machine_name, start, latest_time)
        recent_shots = capacity_delta(machine_name, recent_start, latest_time)
        remaining_shots = day_shots
        machine_plans = plans_by_machine.get(machine_number, [])
        parts = []

        for index, plan in enumerate(machine_plans, start=1):
            planned_qty = int(plan.get("planned_quantity") or 0)
            cavity = max(1, int(plan.get("cavity") or 1))
            required_shots = planned_qty / cavity if planned_qty > 0 else 0
            allocated_shots = max(0, min(remaining_shots, required_shots))
            estimated_qty = min(planned_qty, int(round(allocated_shots * cavity)))
            progress_rate = (estimated_qty / planned_qty * 100) if planned_qty > 0 else 0
            status = "completed" if progress_rate >= 99.9 else "in_progress" if progress_rate > 0 else "pending"
            remaining_shots -= allocated_shots
            parts.append({
                "sequence": index,
                "part_no": plan.get("part_no") or "-",
                "model_name": plan.get("model_name") or plan.get("part_spec") or "-",
                "part_spec": plan.get("part_spec") or "",
                "product_family_code": plan.get("product_family_code"),
                "product_family_name": plan.get("product_family_name"),
                "product_stage": "finished_product" if plan.get("is_finished_product") else "semi_finished_product",
                "planned_qty": planned_qty,
                "cavity": cavity,
                "estimated_qty": estimated_qty,
                "progress_rate": round(progress_rate, 1),
                "status": status,
            })

        current_part = next((part for part in parts if part["status"] == "in_progress"), None)
        if current_part is None and recent_shots > 0:
            current_part = next((part for part in parts if part["status"] == "pending"), None)

        machines.append({
            "machine_number": machine_number,
            "machine": machine_label_from_number(machine_number),
            "machine_name": machine_name,
            "day_shots": day_shots,
            "recent_60m_shots": recent_shots,
            "recent_60m_avg_ct_sec": round(3600 / recent_shots, 1) if recent_shots > 0 else None,
            "is_running": recent_shots > 0,
            "current_part": current_part,
            "parts": parts,
        })

    return {
        "business_date": business_date,
        "range_start": start.isoformat(),
        "range_end": latest_time.isoformat(),
        "recent_range_start": recent_start.isoformat(),
        "recent_range_end": latest_time.isoformat(),
        "product_glossary": {
            "B/C": "Back cover",
            "C/A": "Cabinet",
            "G/P": "Guide Panel",
            "finished_product_marker": "完",
        },
        "machines": machines,
    }


def local_llm_settings() -> tuple[str, str]:
    base_url = os.getenv("LOCAL_LLM_BASE_URL", DEFAULT_LLM_BASE_URL).rstrip("/")
    model = os.getenv("LOCAL_LLM_MODEL", DEFAULT_MODEL)
    return base_url, model


def extract_json_object(text: str) -> dict[str, Any]:
    if not text:
        return {}
    stripped = text.strip()
    try:
        data = json.loads(stripped)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
    if not match:
        return {}
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def normalize_product_family(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip().lower().replace(" ", "")
    if normalized in {"bc", "b/c", "backcover", "백커버"}:
        return "BC"
    if normalized in {"ca", "c/a", "cabinet", "캐비넷"}:
        return "CA"
    if normalized in {"gp", "g/p", "guidepanel", "가이드패널"}:
        return "GP"
    return None


def normalize_intent(raw: dict[str, Any]) -> dict[str, Any]:
    intent = str(raw.get("intent") or "unknown").strip()
    if intent not in {"injection_cycle_time", "production_output", "production_status", "production_summary", "unknown"}:
        intent = "unknown"
    filters = raw.get("filters") if isinstance(raw.get("filters"), dict) else {}
    sort = raw.get("sort") if raw.get("sort") in {"ct_desc", "ct_asc", "output_desc", "output_asc", None} else None
    try:
        limit = int(raw.get("limit") or 6)
    except (TypeError, ValueError):
        limit = 6

    return {
        "intent": intent,
        "metric": raw.get("metric") or None,
        "filters": {
            "running_only": bool(filters.get("running_only")),
            "product_family": normalize_product_family(filters.get("product_family")),
            "target_text": str(filters.get("target_text") or "").strip() or None,
            "machine": str(filters.get("machine") or "").strip() or None,
        },
        "sort": sort,
        "limit": max(1, min(limit, 20)),
    }


def heuristic_intent_from_question(question: str) -> dict[str, Any]:
    normalized = question.lower()
    mentions_ct = any(token in normalized for token in ["c/t", "ct", "cycle", "사이클", "싸이클", "시간", "节拍", "周期"])
    mentions_output = any(token in normalized for token in ["생산량", "실적", "몇개", "몇 개", "output", "production", "产量", "实绩"])
    mentions_status_count = any(token in normalized for token in ["몇대", "몇 대", "수는", "수량", "몇台", "几台", "多少台"])
    mentions_summary = any(token in normalized for token in ["진도", "진행", "진척", "상황", "어때", "어떄", "怎么样", "进度", "情况"])
    running_only = any(token in normalized for token in ["현재", "지금", "running", "생산중", "가동", "现在", "当前", "运行"])
    longest = any(token in normalized for token in ["가장 길", "제일 길", "longest", "최장", "最慢", "最长"])
    shortest = any(token in normalized for token in ["가장 짧", "제일 짧", "shortest", "최단", "最快", "最短"])
    product_family = None
    if any(token in normalized for token in ["back cover", "backcover", "b/c", "bc", "백커버"]):
        product_family = "BC"
    elif any(token in normalized for token in ["cabinet", "c/a", "캐비넷"]):
        product_family = "CA"
    elif any(token in normalized for token in ["guide panel", "g/p", "가이드"]):
        product_family = "GP"

    target_tokens = [
        token.upper()
        for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9./_-]{2,}", question)
        if len(token) >= 4 and token.lower() not in {"back", "cover", "cycle", "output", "production"}
    ]

    if mentions_ct:
        return normalize_intent({
            "intent": "injection_cycle_time",
            "metric": "recent_60m_avg_ct_sec",
            "filters": {
                "running_only": running_only,
                "product_family": product_family,
                "target_text": target_tokens[0] if target_tokens else None,
            },
            "sort": "ct_desc" if longest else "ct_asc" if shortest else None,
            "limit": 1 if (longest or shortest) else 8,
        })
    if mentions_output:
        return normalize_intent({
            "intent": "production_output",
            "metric": "estimated_qty",
            "filters": {
                "running_only": running_only,
                "product_family": product_family,
                "target_text": target_tokens[0] if target_tokens else None,
            },
            "sort": "output_desc",
            "limit": 8,
        })
    if mentions_status_count and running_only:
        return normalize_intent({
            "intent": "production_status",
            "metric": "running_count",
            "filters": {"running_only": True, "product_family": product_family},
            "sort": None,
            "limit": 17,
        })
    if mentions_summary:
        return normalize_intent({
            "intent": "production_summary",
            "metric": "progress_rate",
            "filters": {"running_only": False, "product_family": product_family},
            "sort": None,
            "limit": 8,
        })
    return normalize_intent({"intent": "unknown"})


def request_question_intent(question: str, business_date: str, language: str) -> dict[str, Any]:
    base_url, model = local_llm_settings()
    system_prompt = (
        "You convert Korean/Chinese manufacturing questions into JSON only. "
        "Do not answer the question. Do not calculate. Return one JSON object with this schema: "
        '{"intent":"injection_cycle_time|production_output|production_status|production_summary|unknown",'
        '"metric":"recent_60m_avg_ct_sec|estimated_qty|day_shots|running_count|progress_rate|null",'
        '"filters":{"running_only":true/false,"product_family":"BC|CA|GP|null","target_text":"part/model/machine text or null","machine":"machine text or null"},'
        '"sort":"ct_desc|ct_asc|output_desc|output_asc|null","limit":number}. '
        "Glossary: B/C, back cover, 백커버=BC. C/A, cabinet=CA. G/P, guide panel=GP. "
        "C/T, ct, cycle time, 节拍, 周期 mean injection_cycle_time. 생산량, 실적, 产量 mean production_output. "
        f"Default business_date is {business_date}. JSON only."
    )
    examples = (
        'Q: 지금 백커버 만드는 기계 중 제일 느린 거 뭐야?\n'
        'A: {"intent":"injection_cycle_time","metric":"recent_60m_avg_ct_sec","filters":{"running_only":true,"product_family":"BC","target_text":null,"machine":null},"sort":"ct_desc","limit":1}\n'
        'Q: 现在生产B/C的注塑机哪台节拍最慢？\n'
        'A: {"intent":"injection_cycle_time","metric":"recent_60m_avg_ct_sec","filters":{"running_only":true,"product_family":"BC","target_text":null,"machine":null},"sort":"ct_desc","limit":1}\n'
        'Q: 24g411 오늘 얼마나 나왔어?\n'
        'A: {"intent":"production_output","metric":"estimated_qty","filters":{"running_only":false,"product_family":null,"target_text":"24G411","machine":null},"sort":"output_desc","limit":8}\n'
        'Q: 오늘 생산중인 사출기의 수는?\n'
        'A: {"intent":"production_status","metric":"running_count","filters":{"running_only":true,"product_family":null,"target_text":null,"machine":null},"sort":null,"limit":17}\n'
        'Q: 오늘 생산 진도 어때?\n'
        'A: {"intent":"production_summary","metric":"progress_rate","filters":{"running_only":false,"product_family":null,"target_text":null,"machine":null},"sort":null,"limit":8}'
    )

    try:
        response = requests.post(
            f"{base_url}/chat/completions",
            json={
                "model": model,
                "temperature": 0,
                "max_tokens": 220,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": f"{examples}\n\nQ: {question}\nA:"},
                ],
            },
            timeout=float(os.getenv("LOCAL_LLM_INTENT_TIMEOUT_SECONDS", "18")),
        )
        response.raise_for_status()
        content = response.json().get("choices", [{}])[0].get("message", {}).get("content") or ""
        parsed = normalize_intent(extract_json_object(str(content)))
        if parsed["intent"] != "unknown":
            return parsed
    except Exception:
        pass
    return heuristic_intent_from_question(question)


def part_matches_target(part: dict[str, Any], target_text: str | None) -> bool:
    if not target_text:
        return True
    needle = target_text.strip().upper()
    haystack = " ".join([
        str(part.get("part_no") or ""),
        str(part.get("model_name") or ""),
        str(part.get("part_spec") or ""),
    ]).upper()
    return needle in haystack


def machine_matches_target(machine: dict[str, Any], target_text: str | None) -> bool:
    if not target_text:
        return True
    needle = target_text.strip().upper()
    haystack = f"{machine.get('machine', '')} {machine.get('machine_name', '')} {machine.get('machine_number', '')}".upper()
    return needle in haystack


def answer_from_intent(intent: dict[str, Any], context: dict[str, Any], language: str) -> str | None:
    filters = intent.get("filters") or {}
    product_family = filters.get("product_family")
    target_text = filters.get("target_text")
    machine_filter = filters.get("machine")
    running_only = bool(filters.get("running_only"))
    is_zh = language == "zh"

    if intent.get("intent") == "injection_cycle_time":
        rows = []
        for machine in context["machines"]:
            if running_only and not machine["is_running"]:
                continue
            if not machine_matches_target(machine, machine_filter):
                continue
            part = machine.get("current_part")
            if product_family and (not part or part.get("product_family_code") != product_family):
                continue
            if part and not part_matches_target(part, target_text):
                continue
            if machine.get("recent_60m_avg_ct_sec") is None:
                continue
            rows.append({
                "machine": machine["machine"],
                "part_no": part.get("part_no") if part else "-",
                "model_name": part.get("model_name") if part else "-",
                "family": part.get("product_family_name") if part else "-",
                "shots": machine["recent_60m_shots"],
                "ct": machine["recent_60m_avg_ct_sec"],
            })

        sort = intent.get("sort")
        if sort == "ct_desc":
            rows.sort(key=lambda item: item["ct"], reverse=True)
        elif sort == "ct_asc":
            rows.sort(key=lambda item: item["ct"])
        limit = int(intent.get("limit") or 6)
        if not rows:
            return "조건에 맞는 최근 60분 C/T 데이터를 찾지 못했습니다." if not is_zh else "未找到符合条件的最近60分钟 C/T 数据。"

        if limit == 1 or sort in {"ct_desc", "ct_asc"}:
            top = rows[0]
            if is_zh:
                return f"最近60分钟 기준，{top['machine']} 的 C/T 为约 {top['ct']} 秒，当前推定 Part 为 {top['part_no']}（{top['model_name']}，{top['family']}），60分钟合模数 {top['shots']} 次。"
            return f"최근 60분 기준 {top['machine']}의 평균 C/T는 약 {top['ct']}초입니다. 현재 추정 Part는 {top['part_no']} ({top['model_name']}, {top['family']})이고, 최근 60분 형합수는 {top['shots']}회입니다."

        average_ct = sum(row["ct"] for row in rows) / len(rows)
        details = ", ".join(f"{row['machine']} {row['ct']}초" for row in rows[:limit])
        if is_zh:
            return f"最近60分钟 기준 대상注塑机 {len(rows)}台의 평균 C/T는 약 {average_ct:.1f}초입니다. 明细: {details}。"
        return f"최근 60분 기준 대상 사출기 {len(rows)}대의 평균 C/T는 약 {average_ct:.1f}초입니다. 설비별로는 {details}입니다."

    if intent.get("intent") == "production_output":
        rows = []
        for machine in context["machines"]:
            if running_only and not machine["is_running"]:
                continue
            if not machine_matches_target(machine, machine_filter):
                continue
            for part in machine.get("parts", []):
                if product_family and part.get("product_family_code") != product_family:
                    continue
                if not part_matches_target(part, target_text):
                    continue
                rows.append({
                    "machine": machine["machine"],
                    "part_no": part.get("part_no") or "-",
                    "model_name": part.get("model_name") or "-",
                    "estimated_qty": int(part.get("estimated_qty") or 0),
                    "planned_qty": int(part.get("planned_qty") or 0),
                })
        rows.sort(key=lambda item: item["estimated_qty"], reverse=intent.get("sort") != "output_asc")
        if not rows:
            return "조건에 맞는 생산계획 또는 MES 추정 실적을 찾지 못했습니다." if not is_zh else "未找到符合条件的生产计划或 MES 推定实绩。"
        limit = int(intent.get("limit") or 8)
        selected = rows[:limit]
        total_estimated = sum(item["estimated_qty"] for item in rows)
        total_planned = sum(item["planned_qty"] for item in rows)
        details = ", ".join(f"{item['machine']} {item['part_no']} {item['estimated_qty']:,}/{item['planned_qty']:,}" for item in selected)
        if is_zh:
            return f"基准日当前推定产量合计 {total_estimated:,} 个，计划 {total_planned:,} 个。明细: {details}。"
        return f"기준일 현재 추정 생산량은 총 {total_estimated:,}개이고, 계획은 {total_planned:,}개입니다. 설비별 주요 내역은 {details}입니다."

    if intent.get("intent") == "production_status":
        running = []
        for machine in context["machines"]:
            if not machine.get("is_running"):
                continue
            part = machine.get("current_part")
            if product_family and (not part or part.get("product_family_code") != product_family):
                continue
            running.append(machine)
        labels = ", ".join(machine["machine"] for machine in running[:17])
        if is_zh:
            return f"最近60分钟 기준 현재 생산중인 사출기는 {len(running)}대입니다. 대상 설비: {labels or '-'}."
        return f"최근 60분 형합수 기준 현재 생산중인 사출기는 {len(running)}대입니다. 대상 설비는 {labels or '-'}입니다."

    if intent.get("intent") == "production_summary":
        parts = [
            part
            for machine in context["machines"]
            for part in machine.get("parts", [])
            if not product_family or part.get("product_family_code") == product_family
        ]
        planned_qty = sum(int(part.get("planned_qty") or 0) for part in parts)
        estimated_qty = sum(int(part.get("estimated_qty") or 0) for part in parts)
        progress_rate = (estimated_qty / planned_qty * 100) if planned_qty > 0 else 0
        completed = sum(1 for part in parts if part.get("status") == "completed")
        in_progress = sum(1 for part in parts if part.get("status") == "in_progress")
        pending = sum(1 for part in parts if part.get("status") == "pending")
        running = [machine for machine in context["machines"] if machine.get("is_running")]
        top_machines = sorted(
            [
                {
                    "machine": machine["machine"],
                    "estimated_qty": sum(int(part.get("estimated_qty") or 0) for part in machine.get("parts", [])),
                }
                for machine in context["machines"]
            ],
            key=lambda item: item["estimated_qty"],
            reverse=True,
        )[:4]
        top_text = ", ".join(f"{item['machine']} {item['estimated_qty']:,}개" for item in top_machines if item["estimated_qty"] > 0) or "-"
        if is_zh:
            return f"今天注塑进度约 {progress_rate:.0f}%，推定实绩 {estimated_qty:,} / 计划 {planned_qty:,} 个。最近60分钟运行设备 {len(running)}台，作业状态为完成 {completed}、进行中 {in_progress}、待开始 {pending}。主要生产设备: {top_text}。"
        return f"오늘 사출 생산 진도는 약 {progress_rate:.0f}%입니다. 추정 실적은 {estimated_qty:,} / 계획 {planned_qty:,}개이고, 최근 60분 기준 가동 사출기는 {len(running)}대입니다. 작업 상태는 완료 {completed}건, 진행중 {in_progress}건, 대기 {pending}건이며, 상위 생산 설비는 {top_text}입니다."

    return None


def answer_rule_based(question: str, context: dict[str, Any], language: str) -> str | None:
    normalized = question.lower()
    mentions_ct = any(token in normalized for token in ["c/t", "ct", "cycle", "사이클", "싸이클", "시간"])
    mentions_output = any(token in normalized for token in ["생산량", "실적", "몇개", "몇 개", "output", "production"])
    mentions_running = any(token in normalized for token in ["현재", "지금", "running", "생산중", "가동"])
    mentions_longest = any(token in normalized for token in ["가장 길", "제일 길", "longest", "최장"])
    mentions_back_cover = any(token in normalized for token in ["back cover", "backcover", "b/c", "bc", "백커버"])

    if mentions_output and not mentions_ct:
        tokens = [
            token.upper()
            for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9./_-]{2,}", question)
            if len(token) >= 4
        ]
        matched = []
        for machine in context["machines"]:
            for part in machine.get("parts", []):
                haystack = " ".join([
                    str(part.get("part_no") or ""),
                    str(part.get("model_name") or ""),
                    str(part.get("part_spec") or ""),
                ]).upper()
                if tokens and not any(token in haystack for token in tokens):
                    continue
                if not tokens and part.get("estimated_qty", 0) <= 0:
                    continue
                matched.append({
                    "machine": machine["machine"],
                    "part_no": part.get("part_no") or "-",
                    "model_name": part.get("model_name") or "-",
                    "estimated_qty": int(part.get("estimated_qty") or 0),
                    "planned_qty": int(part.get("planned_qty") or 0),
                    "progress_rate": float(part.get("progress_rate") or 0),
                })

        if not matched:
            return "질문에서 찾은 품번/모델에 해당하는 기준일 생산계획 또는 MES 추정 실적을 찾지 못했습니다."

        total_estimated = sum(item["estimated_qty"] for item in matched)
        total_planned = sum(item["planned_qty"] for item in matched)
        details = ", ".join(
            f"{item['machine']} {item['part_no']} {item['estimated_qty']}/{item['planned_qty']}개"
            for item in matched[:8]
        )
        return (
            f"기준일 현재 해당 조건의 추정 생산량은 총 {total_estimated:,}개입니다. "
            f"계획은 {total_planned:,}개이며, 설비별로는 {details}입니다."
        )

    if not mentions_ct:
        return None

    rows = []
    for machine in context["machines"]:
        if mentions_running and not machine["is_running"]:
            continue
        part = machine.get("current_part")
        if mentions_back_cover and (not part or part.get("product_family_code") != "BC"):
            continue
        if machine.get("recent_60m_avg_ct_sec") is None:
            continue
        rows.append({
            "machine": machine["machine"],
            "part_no": part.get("part_no") if part else "-",
            "model_name": part.get("model_name") if part else "-",
            "family": part.get("product_family_name") if part else "-",
            "shots": machine["recent_60m_shots"],
            "ct": machine["recent_60m_avg_ct_sec"],
        })

    rows.sort(key=lambda item: item["ct"], reverse=mentions_longest)
    if not rows:
        return "조건에 맞는 최근 60분 생산 데이터가 없습니다. 해당 설비가 현재 생산 중인지, 또는 생산계획의 제품군 정보가 저장되어 있는지 확인이 필요합니다."

    if mentions_longest:
        top = rows[0]
        return (
            f"최근 60분 기준 생산 C/T가 가장 긴 사출기는 {top['machine']}입니다. "
            f"현재 추정 Part는 {top['part_no']} ({top['model_name']}, {top['family']})이고, "
            f"최근 60분 형합수는 {top['shots']}회, 평균 C/T는 약 {top['ct']}초입니다."
        )

    average_ct = sum(row["ct"] for row in rows) / len(rows)
    sample = ", ".join(f"{row['machine']} {row['ct']}초" for row in rows[:6])
    return (
        f"최근 60분 기준 대상 사출기 {len(rows)}대의 평균 C/T는 약 {average_ct:.1f}초입니다. "
        f"주요 설비별 C/T는 {sample}입니다."
    )


def request_local_llm(question: str, context: dict[str, Any], language: str) -> str:
    base_url = os.getenv("LOCAL_LLM_BASE_URL", DEFAULT_LLM_BASE_URL).rstrip("/")
    model = os.getenv("LOCAL_LLM_MODEL", DEFAULT_MODEL)
    is_korean = language != "zh"
    compact_context = {
        **context,
        "machines": [
            {
                "machine": machine["machine"],
                "recent_60m_shots": machine["recent_60m_shots"],
                "recent_60m_avg_ct_sec": machine["recent_60m_avg_ct_sec"],
                "is_running": machine["is_running"],
                "current_part": machine["current_part"],
            }
            for machine in context["machines"]
            if machine["is_running"] or machine.get("current_part")
        ],
    }

    response = requests.post(
        f"{base_url}/chat/completions",
        json={
            "model": model,
            "temperature": 0.1,
            "max_tokens": 500,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "당신은 제조 생산관리 분석 보조자입니다. 제공된 계산 결과만 근거로 한국어로 짧게 답하세요. "
                        "C/T는 recent_60m_avg_ct_sec를 사용하고, 모르면 모른다고 말하세요."
                        if is_korean else
                        "你是制造生产管理分析助手。仅基于提供的计算结果，用中文简洁回答。C/T 使用 recent_60m_avg_ct_sec，不知道就说明不知道。"
                    ),
                },
                {
                    "role": "user",
                    "content": f"질문/问题: {question}\n\n데이터/Data:\n{json.dumps(compact_context, ensure_ascii=False)}",
                },
            ],
        },
        timeout=45,
    )
    response.raise_for_status()
    data = response.json()
    return str(data.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
