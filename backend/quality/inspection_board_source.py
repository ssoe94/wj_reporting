"""Shared read-only injection-board source boundary over persisted evidence.

The separate repository performs bounded database reads of server-published
evidence. This hook never authenticates, calls MES/network, imports fixtures,
mints task bindings from names or dispatches actions on a public browser request.
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
    """Unavailable unless the stage writer has published exact verified evidence.

    ``scope`` identifies the displayed local plan, not a verified MES relation.
    Never fill ReadState's captured scope/generation from this argument after an
    old collector response arrives. Its original captured values must survive.
    """
    # Preserve the pure projection's standalone use without configuring Django.
    from django.conf import settings
    if not settings.configured:
        return None
    from .inspection_board_repository import read_persisted_board_source
    return read_persisted_board_source(scope)
