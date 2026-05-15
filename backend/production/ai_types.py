from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


ProgressStatus = Literal["ahead", "on_track", "behind", "no_plan"]
BriefSeverity = Literal["normal", "warning", "critical"]


@dataclass
class AiUsedData:
    name: str
    row_count: int
    filters: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AiDataFreshness:
    last_plan_updated_at: str | None = None
    last_mes_recorded_at: str | None = None
    last_machining_reported_at: str | None = None
    is_stale: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AiBriefCache:
    hit: bool = False
    generated_at: str | None = None
    expires_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AiProcessSummary:
    actual_qty: int
    planned_qty: int
    progress_rate: float
    time_progress_rate: float | None
    gap_qty: int
    status: ProgressStatus
    active_equipment_count: int = 0
    running_equipment_count: int = 0
    total_equipment_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AiRiskItem:
    type: str
    label: str
    gap_qty: int
    process: str
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AiContextPack:
    question: str
    language: str
    scope: dict[str, Any]
    facts: dict[str, Any]
    tables: list[dict[str, Any]]
    calculation_basis: list[str]
    data_freshness: AiDataFreshness
    warnings: list[str]
    retrieval_trace: list[str]

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["data_freshness"] = self.data_freshness.to_dict()
        return payload


@dataclass
class AiBriefingPayload:
    answer: str
    severity: BriefSeverity
    facts: dict[str, Any]
    top_risks: list[AiRiskItem]
    used_data: list[AiUsedData]
    calculation_basis: list[str]
    context_pack: AiContextPack
    cache: AiBriefCache

    def to_dict(self) -> dict[str, Any]:
        return {
            "answer": self.answer,
            "severity": self.severity,
            "facts": self.facts,
            "top_risks": [item.to_dict() for item in self.top_risks],
            "used_data": [item.to_dict() for item in self.used_data],
            "calculation_basis": self.calculation_basis,
            "context_pack": self.context_pack.to_dict(),
            "cache": self.cache.to_dict(),
        }
