"""Shared read-only injection-board source boundary; runtime is disconnected.

Implementations may return a precollected, reviewed immutable batch. This hook
must not authenticate, perform network/database I/O, import fixtures, mint task
bindings from names, or dispatch MES actions on a public browser request.
"""
from dataclasses import dataclass

from .inspection_board_status import (
    BoardScope, CurrentTaskBinding, PeriodicSchedule, QualityObservation, ReadState,
)


@dataclass(frozen=True)
class BoardQualitySource:
    bindings: tuple[CurrentTaskBinding, ...]
    observations: tuple[QualityObservation, ...]
    read: ReadState
    schedule: PeriodicSchedule | None = None


def read_board_quality_source(scope: BoardScope) -> BoardQualitySource | None:
    """Unavailable until the shared integration core supplies verified evidence.

    ``scope`` identifies the displayed local plan, not a verified MES relation.
    Never fill ReadState's captured scope/generation from this argument after an
    old collector response arrives. Its original captured values must survive.
    """
    return None
