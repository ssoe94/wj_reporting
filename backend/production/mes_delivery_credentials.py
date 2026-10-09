"""The historical production writer is permanently unavailable in WJ.

Production and inbound actions belong to MES. WJ only observes their state;
QC result saving and individual inspection completion keep their own adapter.
No flags, role evidence or user credential can activate this compatibility seam.
"""
from dataclasses import dataclass
from datetime import datetime
from rest_framework.exceptions import PermissionDenied


@dataclass(frozen=True)
class VerifiedProductionAuthority:
    """Historical contract type; it grants no callable production authority."""
    actor_id: int
    mes_user_id: int
    tenant: str
    verification_reference: str
    evidence_digest: str
    observed_at: datetime
    allowed_actions: frozenset


class ScopedProductionWriter:
    def __init__(self, *args, **kwargs):
        raise PermissionDenied('Production and inbound actions must be performed in MES.')

    @property
    def dispatched(self):
        return False

    @property
    def status_flag(self):
        return 'disabled_read_only'

    def consume_readback_allowance(self):
        return False

    def __call__(self, *args, **kwargs):
        raise PermissionDenied('Production and inbound actions must be performed in MES.')
