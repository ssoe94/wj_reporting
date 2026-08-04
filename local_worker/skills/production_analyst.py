from __future__ import annotations

import re
from typing import Any


SKILL_NAME = "production-analyst"
SKILL_VERSION = "production-analyst-v1"

IDENTIFIER_KEYS = (
    "machine",
    "machine_name",
    "equipment_label",
    "equipment_name",
    "equipment_key",
    "part_no",
    "model_name",
    "product_family_code",
    "product_family_name",
    "line",
    "line_name",
)

TREND_TERMS = (
    "추이", "오르", "내리", "증가", "감소", "변화", "개선", "악화", "정체",
    "趋势", "上升", "下降", "增加", "减少", "变化", "改善", "恶化", "停滞",
)
DECISION_TERMS = (
    "우선", "먼저", "조치", "위험", "문제", "확인", "판단", "의사결정", "왜", "원인", "이유",
    "优先", "首先", "措施", "风险", "问题", "确认", "判断", "决策", "为什么", "原因", "理由",
)
SUMMARY_TERMS = (
    "잘되고", "잘 되고", "상황", "현황", "진도", "요약", "어때", "어떠",
    "顺利", "情况", "现状", "进度", "总结", "怎么样",
)
REFERENCE_TERMS = (
    "그 모델", "그 설비", "그 장비", "그 라인", "그 part", "그 부품",
    "해당 모델", "해당 설비", "해당 장비", "해당 라인", "해당 part", "해당 부품",
    "위 모델", "위 설비", "위 장비", "위 라인", "그건", "그것",
    "该型号", "该设备", "该产线", "该零件", "那个型号", "那个设备", "它",
)


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _fmt_num(value: Any) -> str:
    number = _number(value)
    return "-" if number is None else f"{int(round(number)):,}"


def _fmt_rate(value: Any) -> str:
    number = _number(value)
    if number is None:
        return "-"
    return f"{number:.1f}".rstrip("0").rstrip(".")


def _status_text(value: Any, language: str) -> str:
    status = str(value or "unknown")
    if language == "zh":
        return {
            "ahead": "快于时间基准",
            "on_track": "接近时间基准",
            "behind": "低于时间基准",
            "no_plan": "无计划基准",
            "in_progress": "生产中",
            "pending": "未开始",
            "completed": "已完成",
            "mes_reported": "MES实绩已反映",
            "manual_partial": "手工实绩局部匹配",
            "manual_open": "存在未匹配的手工实绩",
            "manual_matched": "手工实绩匹配完成",
            "needs_review": "实绩需要确认",
            "manual_mismatch": "手工实绩不一致，需要确认",
        }.get(status, "状态未确认")
    return {
        "ahead": "시간 기준보다 빠른 상태",
        "on_track": "시간 기준과 유사한 상태",
        "behind": "시간 기준보다 지연된 상태",
        "no_plan": "계획 기준이 없는 상태",
        "in_progress": "생산 중",
        "pending": "미시작",
        "completed": "완료",
        "mes_reported": "MES 실적 반영",
        "manual_partial": "수기 실적 부분 매칭",
        "manual_open": "미매칭 수기 실적 있음",
        "manual_matched": "수기 실적 매칭 완료",
        "needs_review": "실적 확인 필요",
        "manual_mismatch": "수기 실적 불일치 확인 필요",
    }.get(status, "상태 미확인")


def select_analysis_mode(question: str) -> str:
    normalized = str(question or "").casefold()
    if any(term.casefold() in normalized for term in TREND_TERMS):
        return "trend_assessment"
    if any(term.casefold() in normalized for term in DECISION_TERMS):
        return "decision_support"
    if any(term.casefold() in normalized for term in SUMMARY_TERMS):
        return "status_summary"
    return "direct_answer"


def _process_sentence(process: str, fact: dict[str, Any], language: str) -> str | None:
    if not isinstance(fact, dict) or not fact:
        return None
    if any(
        _number(fact.get(key)) is None
        for key in ("actual_qty", "planned_qty", "progress_rate", "time_progress_rate")
    ):
        return None
    actual = _fmt_num(fact.get("actual_qty"))
    planned = _fmt_num(fact.get("planned_qty"))
    progress = _fmt_rate(fact.get("progress_rate"))
    time_progress = _fmt_rate(fact.get("time_progress_rate"))
    status = _status_text(fact.get("status"), language)
    if language == "zh":
        label = "注塑" if process == "injection" else "加工"
        return (
            f"{label}实绩为 {actual} 个且计划为 {planned} 个并且完成率为 {progress}%且"
            f"时间进度为 {time_progress}%并且状态为{status}。"
        )
    label = "사출" if process == "injection" else "가공"
    return (
        f"{label} 실적은 {actual}개이고 계획은 {planned}개이며 완료율은 {progress}%이고 "
        f"시간 진행률은 {time_progress}%이며 상태는 {status}입니다."
    )


def _row_identifiers(row: dict[str, Any]) -> list[str]:
    identifiers = []
    for key in IDENTIFIER_KEYS:
        value = row.get(key)
        if isinstance(value, str) and value.strip() and value.strip() != "-":
            identifiers.append(value.strip())
    return identifiers


def _identifier_aliases(identifier: str) -> tuple[str, ...]:
    aliases = [identifier]
    machine_match = re.search(r"T-(\d+)$", identifier, re.IGNORECASE)
    if machine_match:
        number = machine_match.group(1)
        aliases.extend((f"{number}호기", f"{number}号机", f"{number}號機"))
    return tuple(aliases)


def _contains_identifier(text: str, identifier: str) -> bool:
    folded_text = str(text or "").casefold()
    for alias in _identifier_aliases(identifier):
        folded_alias = alias.casefold()
        offset = 0
        while True:
            start = folded_text.find(folded_alias, offset)
            if start < 0:
                break
            end = start + len(folded_alias)
            before = folded_text[start - 1] if start > 0 else ""
            after = folded_text[end] if end < len(folded_text) else ""
            if not (
                (folded_alias[0].isdigit() and before.isdigit())
                or (folded_alias[-1].isdigit() and after.isdigit())
            ):
                return True
            offset = start + 1
    return False


def _matching_rows(question: str, tables: list[dict[str, Any]]) -> list[dict[str, Any]]:
    folded_question = str(question or "").casefold()
    matches = []
    for table in tables:
        if not isinstance(table, dict):
            continue
        for row in table.get("rows") or []:
            if not isinstance(row, dict):
                continue
            identifiers = _row_identifiers(row)
            matched = [identifier for identifier in identifiers if _contains_identifier(folded_question, identifier)]
            if matched:
                matches.append({
                    "table": table.get("name") or "verified_table",
                    "matched_identifiers": matched,
                    "row": row,
                })
            if len(matches) >= 12:
                return matches
    return matches


def prioritize_verified_rows(
    tables: list[dict[str, Any]],
    question_context: str,
    limit_per_table: int = 60,
) -> list[dict[str, Any]]:
    """Keep exact question targets before applying the prompt row limit."""
    folded_context = str(question_context or "").casefold()
    prioritized_tables = []
    for table in tables:
        if not isinstance(table, dict):
            continue
        rows = [row for row in (table.get("rows") or []) if isinstance(row, dict)]
        matched_rows = [
            row for row in rows
            if any(_contains_identifier(folded_context, identifier) for identifier in _row_identifiers(row))
        ]
        matched_ids = {id(row) for row in matched_rows}
        selected_rows = (matched_rows + [row for row in rows if id(row) not in matched_ids])[:limit_per_table]
        prioritized_tables.append({
            "name": table.get("name"),
            "columns": table.get("columns") or [],
            "rows": selected_rows,
        })
    return prioritized_tables


def _target_sentence(match: dict[str, Any], language: str) -> str | None:
    table = str(match.get("table") or "")
    row = match.get("row") if isinstance(match.get("row"), dict) else {}
    identifiers = _row_identifiers(row)
    subject = " / ".join(identifiers[:3])
    if not subject:
        return None

    if table == "injection_machine_progress":
        if any(_number(row.get(key)) is None for key in ("actual_qty", "planned_qty", "progress_rate")):
            return None
        running = row.get("is_running")
        running_text = (
            "运行中" if running is True else "未运行" if running is False else "运行状态未提供"
        ) if language == "zh" else (
            "가동 중" if running is True else "비가동" if running is False else "가동 상태 미제공"
        )
        if language == "zh":
            return (
                f"{subject} 实绩为 {_fmt_num(row.get('actual_qty'))} 个且计划为 {_fmt_num(row.get('planned_qty'))} 个并且"
                f"完成率为 {_fmt_rate(row.get('progress_rate'))}%且当前为{running_text}。"
            )
        return (
            f"{subject} 실적은 {_fmt_num(row.get('actual_qty'))}개이고 계획은 {_fmt_num(row.get('planned_qty'))}개이며 "
            f"완료율은 {_fmt_rate(row.get('progress_rate'))}%이며 현재 {running_text}입니다."
        )

    if table == "injection_part_progress":
        actual_key = "estimated_qty"
    elif table in {"machining_line_progress", "machining_part_progress"}:
        actual_key = "actual_qty"
    else:
        return None
    if any(_number(row.get(key)) is None for key in (actual_key, "planned_qty", "progress_rate")):
        return None
    if language == "zh":
        return (
            f"{subject} 实绩为 {_fmt_num(row.get(actual_key))} 个且计划为 {_fmt_num(row.get('planned_qty'))} 个并且"
            f"完成率为 {_fmt_rate(row.get('progress_rate'))}%且状态为{_status_text(row.get('status'), language)}。"
        )
    return (
        f"{subject} 실적은 {_fmt_num(row.get(actual_key))}개이고 계획은 {_fmt_num(row.get('planned_qty'))}개이며 "
        f"완료율은 {_fmt_rate(row.get('progress_rate'))}%이며 상태는 {_status_text(row.get('status'), language)}입니다."
    )


def _history_has_target_detail(
    snapshots: list[dict[str, Any]],
    matched_target_identifiers: list[str],
) -> bool:
    target_keys = {
        identifier.strip().casefold()
        for identifier in matched_target_identifiers
        if identifier.strip()
    }
    if not target_keys:
        return False

    observation_keys = {
        "actual_qty",
        "estimated_qty",
        "progress_rate",
        "shot_count",
    }

    def visit(node: Any) -> bool:
        if isinstance(node, list):
            return any(visit(item) for item in node)
        if not isinstance(node, dict):
            return False
        node_identifiers = {identifier.casefold() for identifier in _row_identifiers(node)}
        has_observation = any(_number(node.get(key)) is not None for key in observation_keys)
        if target_keys.issubset(node_identifiers) and has_observation:
            return True
        return any(visit(value) for value in node.values() if isinstance(value, (dict, list)))

    matched_snapshot_ids = set()
    for snapshot in snapshots:
        if not isinstance(snapshot, dict) or not visit(snapshot):
            continue
        snapshot_id = next((
            snapshot.get(key)
            for key in ("completed_at", "captured_at", "reference_time", "job_id")
            if snapshot.get(key) not in {None, ""}
        ), None)
        if snapshot_id is not None:
            matched_snapshot_ids.add(str(snapshot_id))
    return len(matched_snapshot_ids) >= 2


def _resolve_history_matches(
    question: str,
    conversation_history: list[dict[str, Any]],
    tables: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], str | None]:
    normalized_question = str(question or "").casefold()
    if not any(term.casefold() in normalized_question for term in REFERENCE_TERMS):
        return [], None
    for item in reversed(conversation_history):
        if not isinstance(item, dict) or item.get("role") not in {None, "user"}:
            continue
        content = str(item.get("content") or "")
        matches = _matching_rows(content, tables)
        if matches:
            return matches, content
    return [], None


def build_skill_payload(llm_payload: dict[str, Any]) -> dict[str, Any]:
    language = "zh" if llm_payload.get("language") == "zh" else "ko"
    question = str(llm_payload.get("question") or "")
    mode = select_analysis_mode(question)
    facts = llm_payload.get("verified_facts") if isinstance(llm_payload.get("verified_facts"), dict) else {}
    tables = llm_payload.get("verified_tables") if isinstance(llm_payload.get("verified_tables"), list) else []
    snapshots = llm_payload.get("historical_snapshots") if isinstance(llm_payload.get("historical_snapshots"), list) else []
    conversation_history = (
        llm_payload.get("conversation_history")
        if isinstance(llm_payload.get("conversation_history"), list)
        else []
    )
    matches = _matching_rows(question, tables)
    resolved_reference_from_history = False
    if not matches:
        matches, _referenced_question = _resolve_history_matches(question, conversation_history, tables)
        resolved_reference_from_history = bool(matches)
    matched_target_identifiers = []
    for match in matches:
        for identifier in match.get("matched_identifiers") or []:
            if identifier not in matched_target_identifiers:
                matched_target_identifiers.append(identifier)
    focus_identifiers = []
    for match in matches[:6]:
        row = match.get("row") if isinstance(match.get("row"), dict) else {}
        for identifier in _row_identifiers(row):
            if identifier not in focus_identifiers:
                focus_identifiers.append(identifier)

    evidence_sentences = []
    for match in matches[:4]:
        sentence = _target_sentence(match, language)
        if sentence and sentence not in evidence_sentences:
            evidence_sentences.append(sentence)
    if not evidence_sentences:
        for process in ("injection", "machining"):
            sentence = _process_sentence(process, facts.get(process), language)
            if sentence:
                evidence_sentences.append(sentence)
    if not evidence_sentences and llm_payload.get("answer_mode") == "verified_answer_rewrite":
        verified_answer = str(llm_payload.get("verified_answer") or "").strip()
        if verified_answer:
            evidence_sentences.append(verified_answer[:2000])

    limitations = []
    if mode == "trend_assessment" and not snapshots:
        limitations.append("historical_snapshots_unavailable")
    elif mode == "trend_assessment" and matches and not _history_has_target_detail(
        snapshots,
        matched_target_identifiers,
    ):
        limitations.append("target_level_history_unavailable")
    if not matches and mode == "direct_answer":
        limitations.append("exact_target_not_matched")
    verified_rewrite = llm_payload.get("answer_mode") == "verified_answer_rewrite"
    if language == "ko":
        evidence_instruction = (
            "verified_answer는 결론 시작에 원문 그대로 한 번 사용하고, 그 밖의 수치는 반복하지 마세요. "
            if verified_rewrite else
            "verified_evidence_sentences는 판단에만 사용하고 수치는 답변에 반복하지 마세요. "
            "검증 수치 문장은 Worker가 최종 답변에 별도로 삽입합니다. "
        )
    else:
        evidence_instruction = (
            "请在结论开头完整引用一次 verified_answer，除此之外不得重复数值。"
            if verified_rewrite else
            "verified_evidence_sentences 只用于判断，不得在回答中重复数字；Worker 会另行插入已验证的数据句子。"
        )

    return {
        "name": SKILL_NAME,
        "version": SKILL_VERSION,
        "mode": mode,
        "matched_targets": [match["matched_identifiers"] for match in matches[:6]],
        "resolved_reference_from_history": resolved_reference_from_history,
        "focus_identifiers": focus_identifiers[:30],
        "verified_evidence_sentences": evidence_sentences[:6],
        "verified_status_findings": {
            process: {"status": fact.get("status")}
            for process in ("injection", "machining")
            if isinstance((fact := facts.get(process)), dict) and fact.get("status")
        },
        "status_semantics": {
            "is_running_true": "currently_running",
            "is_running_false": "not_running_at_snapshot_not_proven_fault",
            "behind": "below_time_progress_not_a_proven_cause",
            "on_track": "within_time_progress_tolerance",
        },
        "limitations": limitations,
        "answer_constraints": {
            "target_rows_only": bool(matches),
            "trend_requires_target_history": mode == "trend_assessment",
            "current_status_is_not_a_trend": True,
        },
        "instructions": (
            "자료에서 질문과 직접 관련된 상태, 변화, 이상 징후를 먼저 고르고 의사결정에 필요한 확인 항목을 제시하세요. "
            f"{evidence_instruction}"
            "대상 수준 이력이 없으면 특정 모델의 추이를 단정하지 마세요."
            if language == "ko"
            else "先选择与问题直接相关的状态、变化和异常信号，再给出有助于决策的确认事项。"
            f"{evidence_instruction}"
            "缺少目标级历史数据时，不得断言特定型号的趋势。"
        ),
    }


def insert_verified_metrics(summary: str, skill_payload: dict[str, Any], language: str) -> str:
    sentences = [
        str(value).strip()
        for value in skill_payload.get("verified_evidence_sentences") or []
        if isinstance(value, str) and value.strip()
    ][:2]
    if not sentences:
        return str(summary or "").strip()

    cleaned = str(summary or "").strip()
    normalized_cleaned = " ".join(cleaned.split())
    sentences = [
        sentence
        for sentence in sentences
        if " ".join(sentence.split()) not in normalized_cleaned
    ]
    if not sentences:
        return cleaned
    for sentence in sentences:
        exact_line = re.compile(rf"(?m)^[ \t]*(?:[-*]\s*)?{re.escape(sentence)}[ \t]*$")
        cleaned = exact_line.sub("", cleaned)
        cleaned = cleaned.replace(sentence, "")
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    metric_section = "\n".join([
        "核心数据:" if language == "zh" else "핵심 수치:",
        *sentences,
    ])
    evidence_heading = "判断依据:" if language == "zh" else "판단 근거:"
    heading_index = cleaned.find(evidence_heading)
    if heading_index > 0:
        conclusion = cleaned[:heading_index].strip()
        remainder = cleaned[heading_index:].strip()
        return f"{conclusion}\n\n{metric_section}\n\n{remainder}"
    first_break = cleaned.find("\n\n")
    if first_break > 0:
        return f"{cleaned[:first_break].strip()}\n\n{metric_section}\n\n{cleaned[first_break:].strip()}"
    return f"{cleaned}\n\n{metric_section}" if cleaned else metric_section
