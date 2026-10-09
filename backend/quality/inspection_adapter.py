"""Fail-closed MES boundary. No undocumented endpoints or runtime enable switch.

A future verified adapter must implement scoped refresh, result recording and
inspection finish with operation reconciliation. Tests inject a synthetic adapter;
production always receives DisabledInspectionAdapter until that work is reviewed.
Do not import legacy MES clients here: even their imports may discover credentials.
"""


class MesContractUnavailable(Exception):
    code = 'mes_contract_unverified'


class MesOutcomeUnknown(Exception):
    """Timeout/partial success: reconcile using the same operation, never resubmit."""
    code = 'mes_outcome_unknown'


class MesRejected(Exception):
    code = 'mes_rejected'


class DisabledInspectionAdapter:
    enabled = False

    def capabilities(self):
        return {'enabled': False, 'reason_code': MesContractUnavailable.code,
                'message': 'MES 검사 연결·수행인·완료 검증 전 / MES 检验接口、执行人及完成状态待验证',
                'can_refresh': False, 'can_sync': False}

    def refresh(self, request, operation):
        raise MesContractUnavailable()

    def save_result(self, request, operation):
        raise MesContractUnavailable()

def get_inspection_adapter():
    return DisabledInspectionAdapter()
