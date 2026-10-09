"""Read completed-role source under the caller's existing request lock.

The caller must authenticate/authorize first, enter transaction.atomic(), take
the common ``inspection:<request_id>`` lock, and fetch the current request with
select_for_update(). This adapter takes workflow/area row locks in that same
transaction. It neither acquires execution authority nor sends MES requests.

UI migration 0015's terminal, item-authorship and completion-recorder fields are
mandatory. A checkout without those model fields cannot capture this source.
Stored names/snapshots are copied as recorded; missing provenance is never
filled from current users, a terminal designation or the future MES executor.
"""
from copy import deepcopy
from datetime import datetime
from decimal import Decimal


class DjangoCompletedSource:
    @staticmethod
    def capture(request):
        # Keep the pure module and Django dependency lazy on this read adapter.
        from .inspection_full_snapshot import FullSnapshotError
        from django.db import DEFAULT_DB_ALIAS, connections
        from .inspection_models import InspectionAudit, InspectionRequest
        from .inspection_role_models import InspectionAreaResult, InspectionRoleWorkflow

        def fail(reason):
            raise FullSnapshotError(reason)

        required = (
            (InspectionRoleWorkflow, {
                'request', 'config_version', 'status', 'new_role_only', 'item_areas',
                'shift_snapshot', 'actor_snapshot', 'shared_terminal_operator',
                'shared_terminal_operator_name',
            }),
            (InspectionAreaResult, {
                'workflow', 'area', 'version', 'status', 'assigned_to', 'assigned_person',
                'assigned_to_name', 'completed_by', 'completed_person', 'completed_by_name',
                'completed_recorded_by', 'completed_recorded_by_name',
                'completed_at', 'judgement', 'measurements', 'evidence',
                'item_authorship',
            }),
            (InspectionRequest, {
                'version', 'status', 'inspection_items', 'quantity_mode',
                'inspected_quantity', 'accepted_quantity', 'rejected_quantity',
                'require_evidence', 'evidence', 'judgement',
            }),
            (InspectionAudit, {
                'request', 'actor', 'actor_name', 'action', 'version', 'created_at',
            }),
        )
        for model, names in required:
            if not names.issubset({field.name for field in model._meta.get_fields()}):
                fail('provenance_schema_unavailable')

        if not isinstance(request, InspectionRequest) or request.pk is None:
            fail('source_request_unavailable')
        alias = request._state.db or DEFAULT_DB_ALIAS
        if not connections[alias].in_atomic_block:
            fail('source_transaction_required')

        # The caller already owns the common request lock. Do not replace it
        # with independent area locks or claim a remote/whole-request CAS here.
        workflow = (InspectionRoleWorkflow.objects.using(alias).select_for_update()
                    .filter(request_id=request.pk).first())
        if workflow is None:
            fail('role_workflow_unavailable')
        areas = list(InspectionAreaResult.objects.using(alias).select_for_update()
                     .filter(workflow_id=workflow.pk).order_by('area', 'id'))
        actions = tuple('role_' + area + '_' + action
                        for area in ('appearance', 'dimension')
                        for action in ('save', 'complete', 'reopen'))
        history = list(InspectionAudit.objects.using(alias)
                       .filter(request_id=request.pk, action__in=actions)
                       .order_by('id'))

        def iso(value):
            if value is None:
                return None
            if not isinstance(value, datetime):
                fail('source_time_unavailable')
            # Preserve the stored timezone/offset; never invent one for a
            # historical naive timestamp. The pure validator rejects it.
            return value.isoformat()

        def quantity(value):
            if type(value) not in (Decimal, int):
                fail('source_quantity_unavailable')
            number = Decimal(value)
            if not number.is_finite():
                fail('source_quantity_unavailable')
            return format(number, 'f')

        def identity(actor_id, name, *, display_person_id=None):
            if display_person_id is not None:
                if actor_id is not None:
                    fail('missing_actor_provenance')
                return {'id': display_person_id, 'name': name, 'kind': 'display_inspector'}
            return {'id': actor_id, 'name': name}

        source = {
            'request_id': request.pk,
            'request_version': request.version,
            'config_version': workflow.config_version,
            'request_status': request.status,
            'workflow_status': workflow.status,
            'new_role_only': workflow.new_role_only,
            'item_areas': deepcopy(workflow.item_areas),
            'items': deepcopy(request.inspection_items),
            'quantity_mode': request.quantity_mode,
            'quantities': {
                'inspected': quantity(request.inspected_quantity),
                'accepted': quantity(request.accepted_quantity),
                'rejected': quantity(request.rejected_quantity),
            },
            'require_evidence': request.require_evidence,
            'evidence': deepcopy(request.evidence),
            'judgement': request.judgement,
            'shift_snapshot': deepcopy(workflow.shift_snapshot),
            'actor_snapshot': deepcopy(workflow.actor_snapshot),
            'terminal': identity(workflow.shared_terminal_operator_id,
                                 workflow.shared_terminal_operator_name),
            'areas': [{
                'area': area.area,
                'version': area.version,
                'status': area.status,
                'assigned': identity(area.assigned_to_id, area.assigned_to_name, display_person_id=area.assigned_person_id),
                'completion': {
                    'inspector': identity(area.completed_by_id, area.completed_by_name, display_person_id=area.completed_person_id),
                    'recorder': identity(area.completed_recorded_by_id,
                                         area.completed_recorded_by_name),
                    'at': iso(area.completed_at),
                },
                'judgement': area.judgement,
                'measurements': deepcopy(area.measurements),
                'evidence': deepcopy(area.evidence),
                'authorship': deepcopy(area.item_authorship),
            } for area in areas],
            'historical_contributors': [{
                'id': row.pk,
                'actor_id': row.actor_id,
                'actor_name': row.actor_name,
                'action': row.action,
                'version': row.version,
                'at': iso(row.created_at),
            } for row in history],
        }
        if request.status == 'approved':
            from .inspection_validation import digest
            from .inspection_workflow import result_payload
            projected = [row for area in areas for row in area.measurements]
            def measurement_map(rows):
                if (type(rows) is not list or any(type(row) is not dict
                        or type(row.get('item_id')) is not str for row in rows)):
                    fail('independent_approval_changed')
                result = {row['item_id']: row for row in rows}
                if len(result) != len(rows):
                    fail('independent_approval_changed')
                return result
            if measurement_map(projected) != measurement_map(request.measurements):
                fail('independent_approval_changed')
            result_digest = digest(result_payload(request))
            submitted = (InspectionAudit.objects.using(alias).filter(request_id=request.pk,
                         action='submit').order_by('-id').first())
            reviewed = (InspectionAudit.objects.using(alias).filter(request_id=request.pk,
                        action__in=('approve', 'review-failure')).order_by('-id').first())
            if (submitted is None or reviewed is None
                    or submitted.actor_id != request.submitted_by_id
                    or reviewed.actor_id != request.reviewed_by_id
                    or submitted.result_digest != result_digest
                    or reviewed.result_digest != result_digest
                    or reviewed.reason != request.review_reason):
                fail('independent_approval_changed')
            def audit_snapshot(row):
                return {'id': row.pk, 'actor_id': row.actor_id, 'actor_name': row.actor_name,
                        'action': row.action, 'version': row.version, 'at': iso(row.created_at),
                        'result_digest': row.result_digest, 'reason': row.reason}
            source['approval'] = {
                'submitter': identity(request.submitted_by_id, submitted.actor_name),
                'reviewer': identity(request.reviewed_by_id, reviewed.actor_name),
                'submitted_at': iso(request.submitted_at),
                'reviewed_at': iso(request.reviewed_at),
                'result_digest': result_digest,
                'submit_audit': audit_snapshot(submitted),
                'review_audit': audit_snapshot(reviewed),
            }
        return source
