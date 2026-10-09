"""Additive local preparation. This module has no credential or MES write access."""
import hashlib
import json
import uuid
from collections import Counter
from datetime import date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation, localcontext
from zoneinfo import ZoneInfo

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import APIException, ValidationError

from .mes_execution_contract import mes_id
from .plan_workflow_read_context import (PlanWorkflowReadContext, group_execution_records,
                                         order_read_context)
from .models import (ProductionPlan, ProductionExecution, PlanWorkflowLock, PlanWorkIdentity, PlanWorkRevision,
                     PlanMaterialApproval, PlanMaterialDefault, PlanWorkOrder,
                     PlanMesRequest, PlanMesRequestEvent)

FIELDS = ('plan_date', 'plan_type', 'machine_name', 'part_no', 'lot_no', 'model_name',
          'part_spec', 'product_family_code', 'product_family_name', 'is_finished_product',
          'sequence', 'planned_quantity')
SHANGHAI = ZoneInfo('Asia/Shanghai')


class WorkflowConflict(APIException):
    status_code = 409
    default_detail = '계획이 변경되었습니다. 최신 버전을 확인하세요. / 计划已变更，请确认最新版本。'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(',', ':')).encode()).hexdigest()


def decimal_text(value):
    if isinstance(value, (bool, float)) or not isinstance(value, (str, int, Decimal)):
        raise ValidationError('정확한 소수 문자열이 필요합니다. / 请使用精确的数量字符串。')
    try:
        number = Decimal(value)
    except (InvalidOperation, ValueError):
        raise ValidationError('Invalid quantity.') from None
    if not number.is_finite() or number < 0 or number > Decimal('1000000000000000') or number.as_tuple().exponent < -10:
        raise ValidationError('Quantity out of range/precision.')
    return format(number, 'f')


def text(value, maximum=255):
    if not isinstance(value, str) or not value.strip() or value.strip() == '-' or len(value) > maximum:
        raise ValidationError('유효한 값이 필요합니다. / 请输入有效值。')
    return value.strip()


def exact_id(value):
    # API input is text: JavaScript numbers may already have lost precision.
    if not isinstance(value, str):
        raise ValidationError('MES ID must be a decimal string.')
    try:
        return str(mes_id(value))
    except ValueError:
        raise ValidationError('Invalid MES ID.') from None


def lock_type(plan_type):
    # Seeded in the additive migration; all plan writers use this protocol.
    return PlanWorkflowLock.objects.select_for_update().get(plan_type=plan_type)


def snapshot(plan):
    result = {field: getattr(plan, field) for field in FIELDS}
    result['plan_date'] = str(result['plan_date'])
    # Match the migration's lossless representation of the legacy FloatField.
    # Reading/history must not apply the narrower MES write precision contract.
    result['planned_quantity'] = format(Decimal(str(result['planned_quantity'])), 'f')
    return result


def valid_plan_quantity(value):
    try:
        decimal_text(value)
    except ValidationError:
        return False
    return True


def _record(plan, actor, change, *, resolution='identified', candidates=None, reason=''):
    if plan.work_uid:
        work = PlanWorkIdentity.objects.get(uid=plan.work_uid)
        previous = work.revisions.get(version=work.current_version)
        if previous.fingerprint == digest(snapshot(plan)) and work.active:
            plan.work_version = work.current_version
            return previous
        work.current_version += 1
        work.active = True
    else:
        work = PlanWorkIdentity.objects.create(plan_type=plan.plan_type, resolution=resolution,
                                             candidates=candidates or [])
        plan.work_uid = work.uid
    work.save()
    plan.work_version = work.current_version
    revision = PlanWorkRevision.objects.create(work=work, version=work.current_version,
        snapshot=snapshot(plan), fingerprint=digest(snapshot(plan)), change=change, actor=actor, reason=reason)
    ProductionPlan.objects.filter(pk=plan.pk).update(work_uid=plan.work_uid, work_version=plan.work_version)
    # Unsent older requests cannot become executable. Sent/uncertain requests remain fenced.
    for order in PlanWorkOrder.objects.filter(plan_type=plan.plan_type):
        if str(work.uid) in order.members:
            for request in order.requests.filter(state__in=['disabled', 'prepared']):
                request.state = 'superseded'
                request.save(update_fields=['state', 'updated_at'])
                PlanMesRequestEvent.objects.create(request=request, state='superseded')
    return revision


def retire(plan, actor):
    if not plan.work_uid:
        _record(plan, actor, 'baseline')
    work = PlanWorkIdentity.objects.get(uid=plan.work_uid)
    work.active = False
    work.current_version += 1
    work.save()
    PlanWorkRevision.objects.create(work=work, version=work.current_version, snapshot=snapshot(plan),
                                   fingerprint=digest(snapshot(plan)), change='removed', actor=actor)
    for order in PlanWorkOrder.objects.filter(plan_type=plan.plan_type):
        if str(work.uid) in order.members:
            for request in order.requests.filter(state__in=['disabled', 'prepared']):
                request.state = 'superseded'
                request.save(update_fields=['state', 'updated_at'])
                PlanMesRequestEvent.objects.create(request=request, state='superseded')


def identity_key(plan):
    return (str(plan.plan_date), plan.machine_name, plan.part_no, plan.lot_no or '',
            plan.model_name or '', plan.part_spec or '')


def replace_uploaded_plans(plans, available_days, plan_type, actor):
    """Keep legacy delete/recreate behavior; only unambiguous unmoved rows reuse UID."""
    lock_type(plan_type)
    old = list(ProductionPlan.objects.filter(plan_date__in=available_days, plan_type=plan_type))
    for row in old:
        if not row.work_uid:
            _record(row, actor, 'baseline', resolution='identified' if row.part_no else 'confirmation')
    old_counts, new_counts = Counter(map(identity_key, old)), Counter(map(identity_key, plans))
    reusable = {identity_key(row): row for row in old if old_counts[identity_key(row)] == 1}
    prior_candidates = []
    for work in PlanWorkIdentity.objects.filter(plan_type=plan_type).prefetch_related('revisions'):
        previous = next((r for r in work.revisions.all() if r.version == work.current_version), None)
        if previous: prior_candidates.append((str(work.uid), previous.snapshot['part_no']))
    used = set()
    for row in plans:
        key = identity_key(row)
        candidate = reusable.get(key)
        if (candidate and new_counts[key] == 1 and row.part_no and row.sequence == candidate.sequence):
            row.work_uid, row.work_version = candidate.work_uid, candidate.work_version
            used.add(candidate.work_uid)
    for row in old:
        if row.work_uid not in used:
            retire(row, actor)
    deleted_count, _ = ProductionPlan.objects.filter(plan_date__in=available_days, plan_type=plan_type).delete()
    ProductionPlan.objects.bulk_create(plans)
    for row in plans:
        if row.work_uid:
            _record(row, actor, 'changed')
        else:
            candidates = [uid for uid, part in prior_candidates if row.part_no and part == row.part_no]
            ambiguous = bool(candidates) or new_counts[identity_key(row)] > 1 or not row.part_no
            _record(row, actor, 'added', resolution='confirmation' if ambiguous else 'identified',
                    candidates=candidates[:100])
    return deleted_count


def resolve_identity(plan, data, actor):
    if type(data.get('version')) is not int or data.get('version') != plan.work_version:
        raise WorkflowConflict()
    reason = text(data.get('reason'), 500)
    current = PlanWorkIdentity.objects.get(uid=plan.work_uid)
    if current.resolution != 'confirmation':
        raise WorkflowConflict('Identity is already resolved.')
    target = data.get('previous_uid')
    if target:
        if target not in current.candidates:
            raise ValidationError('Choose a recorded candidate.')
        work = PlanWorkIdentity.objects.get(uid=target, plan_type=plan.plan_type)
        if work.active or ProductionPlan.objects.filter(work_uid=work.uid).exists():
            raise WorkflowConflict('Previous identity is still active; cannot merge rows.')
        retire(plan, actor)
        plan.work_uid = work.uid
        _record(plan, actor, 'identity_confirmed', reason=reason)
    else:
        current.resolution = 'identified'
        current.save(update_fields=['resolution'])
        # Identity decision is a new immutable version and invalidates old approvals.
        current.current_version += 1
        current.save(update_fields=['current_version'])
        plan.work_version = current.current_version
        ProductionPlan.objects.filter(pk=plan.pk).update(work_version=plan.work_version)
        PlanWorkRevision.objects.create(work=current, version=current.current_version,
            snapshot=snapshot(plan), fingerprint=digest(snapshot(plan)), change='identity_confirmed', actor=actor, reason=reason)
    return {'uid': str(plan.work_uid), 'version': plan.work_version, 'reason': reason}


def material_catalog():
    """One stored original dataset, no live call, ID/code or unit fallback."""
    from inventory.models import RawMaterialMESDataset
    meta = RawMaterialMESDataset.objects.filter(kind='inventory').only('id', 'refreshed_at').first()
    if not meta:
        return {'source': 'stored_mes_inventory', 'dataset_id': None, 'refreshed_at': None, 'materials': []}
    dataset = RawMaterialMESDataset.objects.get(pk=meta.pk)
    options = {}
    for row in dataset.payload:
        if not isinstance(row, dict) or row.get('syntheticZero'):
            continue
        material, amount = row.get('material'), row.get('amount')
        if not isinstance(material, dict) or not isinstance(amount, dict):
            continue
        unit = amount.get('unit')
        if not isinstance(unit, dict):
            continue
        try:
            item = {'material_id': str(mes_id(material.get('id'))), 'material_code': text(material.get('code')),
                    'material_name': text(material.get('name')), 'unit_id': str(mes_id(unit.get('id'))),
                    'unit_name': text(unit.get('name')), 'material_version': material.get('version') or ''}
            key = digest(item)
            options[key] = {**item, 'key': key, 'dataset_id': dataset.pk}
        except (ValueError, APIException):
            continue
    # A code with different MES IDs is shown but cannot be approved automatically.
    codes = {}
    for item in options.values():
        codes.setdefault(item['material_code'], set()).add(item['material_id'])
    for item in options.values():
        item['selectable'] = len(codes[item['material_code']]) == 1
    return {'source': 'stored_mes_inventory', 'dataset_id': dataset.pk,
            'refreshed_at': dataset.refreshed_at.isoformat(), 'materials': list(options.values())[:1000]}


def approve_materials(plan, data, actor):
    if type(data.get('version')) is not int or data.get('version') != plan.work_version or str(plan.work_uid) != data.get('uid'):
        raise WorkflowConflict()
    work = PlanWorkIdentity.objects.get(uid=plan.work_uid)
    if work.resolution != 'identified' or not plan.part_no:
        raise WorkflowConflict('작업 동일성을 먼저 확인하세요. / 请先确认任务标识。')
    # Displaying a legacy value is not authorization to round or send it.
    decimal_text(snapshot(plan)['planned_quantity'])
    catalog = material_catalog()
    choices = {row['key']: row for row in catalog['materials'] if row['selectable']}
    rows = data.get('inputs')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 20:
        raise ValidationError('Select 1–20 materials.')
    inputs = []
    for row in rows:
        if not isinstance(row, dict) or row.get('key') not in choices:
            raise ValidationError('Material source changed or invalid ID/unit.')
        item = choices[row['key']]
        if data.get('dataset_id') != catalog['dataset_id']:
            raise WorkflowConflict('MES material dataset changed; review the selection.')
        numerator = decimal_text(row.get('numerator'))
        denominator = decimal_text(row.get('denominator'))
        if Decimal(numerator) <= 0 or Decimal(denominator) <= 0:
            raise ValidationError('A positive reviewed BOM ratio is required.')
        with localcontext() as context:
            context.prec = 100
            required = Decimal(str(plan.planned_quantity)) * Decimal(numerator) / Decimal(denominator)
        inputs.append({**item, 'material_version': text(row.get('material_version') or item['material_version']),
                       'numerator': numerator, 'denominator': denominator,
                       'required_quantity': decimal_text(format(required, 'f'))})
    if len({row['material_id'] for row in inputs}) != len(inputs):
        raise ValidationError('Duplicate material.')
    setup = {key: text(data.get(key)) for key in ('bom_version', 'mold_code', 'resource_code',
              'process_code', 'process_num', 'route_code', 'output_unit_name', 'output_version')}
    setup['output_unit_id'] = exact_id(data.get('output_unit_id'))
    setup['inputs'] = sorted(inputs, key=lambda row: row['material_id'])
    setup['source_refreshed_at'] = catalog['refreshed_at']
    setup['quantity'] = decimal_text(str(plan.planned_quantity))
    setup['uid'], setup['version'] = str(plan.work_uid), plan.work_version
    revision = work.revisions.get(version=plan.work_version)
    reason = text(data.get('reason'), 500)
    previous = revision.approvals.order_by('-id').first()
    if (previous and previous.fingerprint == digest(setup)
            and previous.actor_id == actor.pk and previous.reason == reason):
        return previous
    for order in PlanWorkOrder.objects.filter(plan_type=plan.plan_type):
        if str(plan.work_uid) in order.members:
            for request in order.requests.filter(state__in=['disabled', 'prepared']):
                request.state = 'superseded'
                request.save(update_fields=['state', 'updated_at'])
                PlanMesRequestEvent.objects.create(request=request, state='superseded')
    return PlanMaterialApproval.objects.create(revision=revision, snapshot=setup,
        fingerprint=digest(setup), reason=reason, actor=actor)


def setup_snapshot(approval):
    result = {key: value for key, value in approval.snapshot.items() if key not in ('uid', 'version', 'quantity', 'source_refreshed_at')}
    result['inputs'] = [{key: value for key, value in row.items()
                        if key not in ('key', 'dataset_id', 'selectable', 'required_quantity')}
                       for row in result['inputs']]
    return result


def serialize_row(plan, context=None):
    if context is None:
        context = PlanWorkflowReadContext(plan.plan_date, plan.plan_date, plan.plan_type)
    context.load_display()
    work = context.works.get(plan.work_uid)
    candidate_uids = {str(uuid.UUID(uid)) for uid in work.candidates} if work else set()
    approval = context.approval(plan)
    row_snapshot = snapshot(plan)
    previous_approval = None
    if work and not approval:
        previous_approval = next((item for item in context.approvals_by_work[work.uid]
                                  if item.revision.version < plan.work_version), None)
        if previous_approval and any(previous_approval.revision.snapshot[key] != row_snapshot[key] for key in ('part_no', 'machine_name')):
            previous_approval = None
    defaults = context.defaults[plan.part_no]
    default = next((item for item in defaults if item.effective_from <= plan.plan_date), None)
    latest_default = max(defaults, key=lambda item: item.version, default=None)
    return {'id': plan.pk, 'uid': str(plan.work_uid) if plan.work_uid else None, 'version': plan.work_version,
        **row_snapshot, 'quantity_valid': valid_plan_quantity(row_snapshot['planned_quantity']),
        'identity_state': work.resolution if work else 'confirmation',
        'candidates': work.candidates if work else [],
        'candidate_details': [item for uid, item in context.candidate_details.items()
                              if uid in candidate_uids] if work else [],
        'approval': {'id': approval.pk, 'snapshot': approval.snapshot, 'actor_id': approval.actor_id,
                     'actor_name': (approval.actor.first_name or approval.actor.username) if approval.actor else '',
                     'approved_at': approval.created_at.isoformat()} if approval else None,
        'previous_approval': {'snapshot': previous_approval.snapshot} if previous_approval else None,
        'default_version': latest_default.version if latest_default else 0,
        'recommendation': {'version': default.version, 'snapshot': default.snapshot} if default else None}


def execution_records(plan):
    # A direct edit can change sequence while retaining its explicit UID. Check
    # historical composite keys conservatively; never assign these as MES totals.
    return group_execution_records([[plan]], snapshot)[0].items()


def preview(start, end, plan_type, context=None):
    """Consecutive injection days only after explicit setup/material approval.

    Read all machine rows around the requested window so boundaries never split an
    existing campaign silently. Multiple rows/day, missing approvals, gaps and
    intervening products are hard boundaries; they are never skipped.
    """
    context = context or PlanWorkflowReadContext(start, end, plan_type)
    plans, truncated = context.plans, context.truncated
    counts = Counter((row.machine_name, str(row.plan_date)) for row in plans)
    groups, current = [], None
    for plan in plans:
        # Grouping needs identity/current approval, not display defaults,
        # actor/candidate serialization or historical execution SQL per row.
        work = context.works.get(plan.work_uid)
        approval = context.approval(plan)
        row_snapshot = snapshot(plan)
        row = {'uid': str(plan.work_uid) if plan.work_uid else None,
               'identity_state': work.resolution if work else 'confirmation',
               'quantity_valid': valid_plan_quantity(row_snapshot['planned_quantity'])}
        setup = setup_snapshot(approval) if approval else None
        blockers = ['plan_scope_truncated'] if truncated else []
        if not row['quantity_valid']: blockers.append('plan_quantity_review')
        if row['identity_state'] != 'identified': blockers.append('identity_confirmation')
        if not approval: blockers.append('material_confirmation')
        if plan_type == 'injection' and counts[(plan.machine_name, str(plan.plan_date))] > 1:
            blockers.append('multiple_rows_setup_review')
        setup_hash = digest(setup) if setup else ''
        same = (plan_type == 'injection' and current and not blockers and not current['blockers']
            and current['machine_name'] == plan.machine_name and current['part_no'] == plan.part_no
            and current['lot_no'] == (plan.lot_no or '') and current['setup_fingerprint'] == setup_hash
            and date.fromisoformat(current['last_date']) + timedelta(days=1) == plan.plan_date)
        if not same:
            current = {'plan_type': plan_type, 'machine_name': plan.machine_name, 'part_no': plan.part_no,
                'lot_no': plan.lot_no or '', 'first_date': str(plan.plan_date), 'last_date': str(plan.plan_date),
                'members': [], 'quantity': '0', 'setup': setup, 'setup_fingerprint': setup_hash,
                'blockers': blockers, 'approval_ids': [], 'versions': {}, '_plans': []}
            groups.append(current)
        current['_plans'].append(plan)
        current['members'].append(row['uid'])
        current['versions'][row['uid']] = plan.work_version
        if approval: current['approval_ids'].append(approval.pk)
        current['last_date'] = str(plan.plan_date)
        if row['quantity_valid']:
            with localcontext() as numeric_context:
                numeric_context.prec = 100
                current['quantity'] = format(Decimal(current['quantity']) + Decimal(row_snapshot['planned_quantity']), 'f')
        else:
            # An invalid row is its own hard boundary, still visible verbatim.
            current['quantity'] = row_snapshot['planned_quantity']
    groups = [group for group in groups if group['last_date'] >= str(start) and group['first_date'] <= str(end)]
    executions = group_execution_records([group.pop('_plans') for group in groups], snapshot)
    by_member, unresolved, pending_disabled = order_read_context(plan_type) if groups else ({}, set(), {})
    results = []
    for group, execution in zip(groups, executions):
        # Validate totals after grouping; never split a continuous campaign just
        # to make each outgoing quantity fit the write limit.
        if not valid_plan_quantity(group['quantity']) and 'plan_quantity_review' not in group['blockers']:
            group['blockers'].append('plan_quantity_review')
        group['planned_start'] = datetime.combine(date.fromisoformat(group['first_date']), time(8), SHANGHAI).isoformat()
        group['planned_end'] = datetime.combine(date.fromisoformat(group['last_date']) + timedelta(days=1), time(8), SHANGHAI).isoformat()
        overlaps = list({order.uid: order for uid in group['members']
                         for order in by_member.get(uid, ())}.values())
        group['operation'] = 'create'
        group['work_order_code'] = None
        group['mes_id'] = None
        group['reported_quantity'], group['inbound_quantity'] = None, None
        if overlaps:
            if len(overlaps) != 1 or not set(overlaps[0].members).issubset(set(group['members'])):
                group['blockers'].append('campaign_members_changed')
            else:
                order = overlaps[0]
                group['work_order_code'] = order.code
                group['mes_id'] = str(order.mes_id) if order.mes_id else None
                group['order_version'] = order.version
                group['operation'] = 'update' if order.mes_id else 'prepare'
                group['reported_quantity'] = str(order.reported_quantity) if order.observed_at else None
                group['inbound_quantity'] = str(order.inbound_quantity) if order.observed_at else None
                if any(group[key] != order.approved_snapshot[key] for key in ('part_no', 'machine_name', 'lot_no')):
                    group['blockers'].append('work_target_changed_review')
                if group['setup_fingerprint'] != order.setup_fingerprint:
                    group['blockers'].append('setup_changed_new_work_review')
                if group['planned_start'] != order.approved_snapshot['planned_start']:
                    group['blockers'].append('planned_start_changed')
                if order.mes_id and not order.observation_complete:
                    group['blockers'].append('mes_observation_incomplete')
                if ('plan_quantity_review' not in group['blockers']
                        and Decimal(group['quantity']) < max(order.reported_quantity, order.inbound_quantity)):
                    group['blockers'].append('below_produced_or_inbound')
                if order.uid in unresolved:
                    group['blockers'].append('readback_required')
                if ('plan_quantity_review' not in group['blockers']
                        and digest(order.approved_snapshot) == digest(_intent(group))):
                    group['operation'] = 'unchanged'
                    if not order.mes_id:
                        from .plan_workflow_contract import build_contract
                        contract, blockers = build_contract(order, _intent(group))
                        pending = pending_disabled.get(order.uid)
                        if pending and (digest(pending.contract) != digest(contract) or pending.blockers != blockers):
                            group['operation'] = 'prepare'
        if ('plan_quantity_review' not in group['blockers']
                and Decimal(group['quantity']) < sum(execution.values(), Decimal('0'))):
            group['blockers'].append('below_existing_execution_review')
        group['key'] = digest(_intent(group))
        results.append(group)
    return results


def _intent(group):
    return {key: group[key] for key in ('plan_type', 'machine_name', 'part_no', 'lot_no', 'members',
            'versions', 'approval_ids', 'quantity', 'setup', 'setup_fingerprint', 'planned_start', 'planned_end')}


@transaction.atomic
def prepare(start, end, plan_type, keys, actor, *, contract_builder=None):
    lock_type(plan_type)
    groups = {group['key']: group for group in preview(start, end, plan_type)}
    if (not isinstance(keys, list) or not 1 <= len(keys) <= 50
            or any(not isinstance(key, str) or len(key) != 64 for key in keys)
            or len(set(keys)) != len(keys)):
        raise ValidationError('Select 1–50 distinct previews.')
    if any(key not in groups for key in keys): raise WorkflowConflict()
    results = []
    for key in keys:
        group = groups[key]
        # Each item is independent: blocked items do not discard prepared items.
        if group['blockers']:
            results.append({'key': key, 'state': 'blocked', 'blockers': group['blockers']})
            continue
        if group['operation'] == 'unchanged':
            results.append({'key': key, 'state': 'unchanged', 'work_order_code': group['work_order_code']})
            continue
        intent = _intent(group)
        if group['work_order_code']:
            order = PlanWorkOrder.objects.get(code=group['work_order_code'])
            order.version += 1
            order.members, order.approved_snapshot = group['members'], intent
            order.save(update_fields=['version', 'members', 'approved_snapshot'])
        else:
            order_uid = uuid.uuid4()
            order = PlanWorkOrder.objects.create(uid=order_uid, code='WJ-' + order_uid.hex,
                plan_type=plan_type, members=group['members'], setup_fingerprint=group['setup_fingerprint'],
                approved_snapshot=intent)
        from .plan_workflow_contract import build_contract
        contract, blockers = (contract_builder or build_contract)(order, intent)
        request, created = PlanMesRequest.objects.get_or_create(dedupe_key=digest({'code': order.code, 'intent': intent, 'contract': contract, 'blockers': blockers}),
            defaults={'work_order': order, 'operation': 'update' if order.mes_id else 'create', 'intent': intent,
                      'contract': contract, 'blockers': blockers, 'actor': actor, 'state': 'disabled'})
        if created:
            for old in order.requests.filter(state='disabled').exclude(pk=request.pk):
                old.state = 'superseded'
                old.save(update_fields=['state', 'updated_at'])
                PlanMesRequestEvent.objects.create(request=old, state='superseded')
            PlanMesRequestEvent.objects.create(request=request, state='disabled', evidence={'write_enabled': False})
        results.append({'key': key, 'uid': str(request.uid), 'state': request.state, 'blockers': request.blockers,
                        'work_order_code': order.code})
    return results


def claim_for_isolated_adapter(request_uid, *, fixture=False):
    """Production transport stays disabled even if an unrelated flag is enabled."""
    if not fixture: raise WorkflowConflict('MES plan writer is disabled.')
    with transaction.atomic():
        plan_type = PlanMesRequest.objects.get(uid=request_uid).work_order.plan_type
        lock_type(plan_type)
        req = PlanMesRequest.objects.select_for_update().get(uid=request_uid)
        if req.state != 'disabled' or req.blockers: raise WorkflowConflict('Request cannot be sent.')
        for uid, version in req.intent['versions'].items():
            if not ProductionPlan.objects.filter(work_uid=uid, work_version=version).exists():
                raise WorkflowConflict('Stale plan version.')
        for approval_id in req.intent['approval_ids']:
            approval = PlanMaterialApproval.objects.get(pk=approval_id)
            if approval.revision.approvals.order_by('-id').first().pk != approval_id:
                raise WorkflowConflict('Material approval changed.')
        req.state, req.attempt = 'sending', req.attempt + 1
        req.save(update_fields=['state', 'attempt', 'updated_at'])
        PlanMesRequestEvent.objects.create(request=req, state='sending')
        return req


@transaction.atomic
def record_adapter_result(request_uid, outcome, *, work_order_id=''):
    req = PlanMesRequest.objects.select_for_update().get(uid=request_uid)
    if req.state != 'sending': raise WorkflowConflict()
    # Even a provider success awaits exact readback; timeout is never retried.
    req.state = 'readback_pending' if outcome == 'acknowledged' else 'uncertain'
    req.save(update_fields=['state', 'updated_at'])
    PlanMesRequestEvent.objects.create(request=req, state=req.state,
        evidence={'work_order_id': exact_id(work_order_id)} if work_order_id else {})


@transaction.atomic
def reconcile_readback(request_uid, evidence):
    """Internal trusted adapter only; no client-supplied completion API."""
    req = PlanMesRequest.objects.select_for_update().select_related('work_order').get(uid=request_uid)
    if req.state not in ('sending', 'uncertain', 'readback_pending', 'review'): raise WorkflowConflict()
    order, intent = req.work_order, req.intent
    expected = {key: intent[key] for key in ('quantity', 'planned_start', 'planned_end', 'setup_fingerprint')}
    expected['work_order_code'] = order.code
    good = (not order.mes_id or evidence.get('work_order_id') == order.mes_id) and evidence.get('complete') is True and all(evidence.get(k) == v for k, v in expected.items())
    if good:
        order.mes_id = exact_id(evidence.get('work_order_id'))
        if evidence.get('scope') != 'creation_snapshot':
            order.reported_quantity = Decimal(decimal_text(evidence.get('reported_quantity')))
            order.inbound_quantity = Decimal(decimal_text(evidence.get('inbound_quantity')))
            order.observed_at, order.observation_complete = timezone.now(), True
        if evidence.get('actual_started_at') and order.actual_started_at is None:
            from django.utils.dateparse import parse_datetime
            started = parse_datetime(evidence['actual_started_at'])
            if not started or timezone.is_naive(started): raise ValidationError('Exact actual start required.')
            order.actual_started_at = started
        order.save()
        req.state = 'confirmed'
    else:
        req.state = 'review'
    req.save(update_fields=['state', 'updated_at'])
    PlanMesRequestEvent.objects.create(request=req, state=req.state, evidence={
        'complete': good, 'scope': evidence.get('scope', 'production_totals'),
        'work_order_id': order.mes_id if good else '', 'checked_at': timezone.now().isoformat()})
    return req.state
