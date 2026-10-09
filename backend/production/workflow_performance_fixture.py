"""Deterministic synthetic workflow load; never imports deployment settings.

Used by the isolated benchmark and query-budget tests. Writes are confined to
fixture setup. IDs, exact quantities and response-visible times are stable
across processes; the DB digest checks each run's state before and after GET.
"""
from collections import deque
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import hashlib
import json
import re
import time
import uuid

from django.contrib.auth import get_user_model
from django.core.serializers.json import DjangoJSONEncoder
from django.core.management.color import no_style
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.renderers import JSONRenderer
from rest_framework.test import APIRequestFactory, force_authenticate

from inventory.models import RawMaterialMESDataset
from production.models import (ProductionPlan, ProductionExecution, PlanWorkIdentity,
    PlanWorkRevision, PlanMaterialApproval, PlanMaterialDefault, PlanWorkOrder,
    PlanMesRequest, PlanMesRequestEvent)
from production.plan_workflow import digest, snapshot, setup_snapshot

START = date(2026, 10, 8)
END = date(2026, 10, 10)
CLOCK = datetime(2026, 10, 7, 0, 0, tzinfo=timezone.utc)
SHANGHAI = timezone(timedelta(hours=8))


def uid(key):
    return uuid.uuid5(uuid.NAMESPACE_URL, f'wj-workflow-performance/{key}')


def seed_performance_fixture(total_plans=5611, *, selected_history_limit=4200):
    """Bulk seed both processes, long selected-machine histories and boundaries.

    By default each selected main machine has up to 4,200 older rows, below the existing
    5,000-row safety cap. Extra >10k rows use machines outside the selected day.
    This separates the all-table size from the selected-machine history size.
    """
    if total_plans < 100 or ProductionPlan.objects.exists():
        raise ValueError('Use at least 100 plans in an empty disposable fixture DB.')
    User = get_user_model()
    user = User(id=900001, username='SYNTHETIC-PERFORMANCE', first_name='SYNTHETIC',
                is_staff=True, is_superuser=True, is_active=True, password='!')
    User.objects.bulk_create([user])
    dataset = RawMaterialMESDataset(id=900001, kind='inventory', scope_key='synthetic-performance',
        record_count=1, payload=[{'material': {'id': '17000000000000001', 'code': 'SYNTHETIC-RM',
            'name': 'SYNTHETIC Resin', 'version': 'V1'},
            'amount': {'amount': '50', 'unit': {'id': '17000000000000002', 'name': '千克'}}}])
    RawMaterialMESDataset.objects.bulk_create([dataset])
    RawMaterialMESDataset.objects.filter(pk=dataset.pk).update(refreshed_at=CLOCK)
    dataset.refreshed_at = CLOCK
    named, plans, kinds = {}, [], {}

    def add(name, kind, machine, day, quantity=1000, part=None, *, version=1, approval=True,
            resolution='identified', sequence=1, candidates=None):
        plan = ProductionPlan(id=len(plans) + 1, work_uid=uid(name), work_version=version,
            plan_date=day, plan_type=kind, machine_name=machine, lot_no='SYNTHETIC-LOT',
            model_name='SYNTHETIC-MODEL', part_spec='SYNTHETIC-SPEC',
            part_no=part or f'SYNTHETIC-{name.upper()}', planned_quantity=quantity, sequence=sequence)
        plans.append(plan)
        kinds[plan.pk] = (approval, resolution, candidates or [])
        named[name] = plan
        return plan

    for day, quantity in [(8, 1000), (9, 1000), (10, 300)]:
        add(f'campaign_{day}', 'injection', 'imm01', date(2026, 10, day), quantity, 'SYNTHETIC-CAMPAIGN')
    add('legacy', 'injection', 'imm02', START, 123.4567890123456, approval=False)
    add('revision', 'injection', 'imm03', START, version=2, approval=False)
    add('duplicate_a', 'injection', 'imm04', START, part='SYNTHETIC-DUPLICATE', sequence=1)
    add('duplicate_b', 'injection', 'imm04', START, part='SYNTHETIC-DUPLICATE', sequence=2)
    add('identity', 'injection', 'imm05', START, approval=False, resolution='confirmation', candidates=[str(uid('retired'))])
    add('uncertain', 'injection', 'imm06', START)
    add('machining_8', 'machining', 'line01', START, part='SYNTHETIC-MACHINING')
    add('machining_9', 'machining', 'line01', START + timedelta(days=1), 500, 'SYNTHETIC-MACHINING')
    add('machining_revision', 'machining', 'line02', START, version=2, approval=False)
    add('machining_execution', 'machining', 'line03', START)
    add('machining_identity', 'machining', 'line04', START, approval=False, resolution='confirmation')
    add('machining_observed', 'machining', 'line05', START)
    add('machining_sequence_a', 'machining', 'line06', START, sequence=1)
    add('machining_sequence_b', 'machining', 'line06', START, sequence=2)
    core_names = set(named)
    for index in range(total_plans - len(plans)):
        kind = 'injection' if index % 2 == 0 else 'machining'
        number = index // 2
        # Past dates have recurring products, different setups and deliberate
        # gaps: no old campaign can silently merge into the selected window.
        selected = number < selected_history_limit
        machine = ('imm01' if kind == 'injection' else 'line01') if selected else f'SYNTHETIC-UNSELECTED-{kind}'
        add(f'history_{kind}_{number}', kind, machine, date(2000, 1, 1) + timedelta(days=number),
            125.25, f'SYNTHETIC-HISTORY-{number % 17:02}', sequence=1,
            approval=number % 11 != 0, version=2 if number % 13 == 0 else 1)

    ProductionPlan.objects.bulk_create(plans, batch_size=250)
    identities = [PlanWorkIdentity(uid=plan.work_uid, plan_type=plan.plan_type, current_version=plan.work_version,
        resolution=kinds[plan.pk][1], candidates=kinds[plan.pk][2]) for plan in plans]
    retired = PlanWorkIdentity(uid=uid('retired'), plan_type='injection', active=False, current_version=1)
    PlanWorkIdentity.objects.bulk_create([*identities, retired], batch_size=250)
    revisions, approvals, current_approvals = [], [], {}

    def material_snapshot(plan, version, quantity):
        return {'uid': str(plan.work_uid), 'version': version, 'quantity': quantity,
            'bom_version': 'SYNTHETIC-BOM-V1', 'mold_code': f'SYNTHETIC-MOLD-{plan.machine_name}',
            'resource_code': f'SYNTHETIC-{plan.machine_name.upper()}', 'process_code': 'ZS',
            'process_num': '10', 'route_code': 'SYNTHETIC-ROUTE', 'output_unit_name': '个',
            'output_unit_id': '17000000000000003', 'output_version': 'V1',
            'source_refreshed_at': CLOCK.isoformat(), 'inputs': [{
                'key': digest({'material_id': '17000000000000001', 'material_code': 'SYNTHETIC-RM',
                    'material_name': 'SYNTHETIC Resin', 'material_version': 'V1',
                    'unit_id': '17000000000000002', 'unit_name': '千克'}),
                'material_id': '17000000000000001', 'material_code': 'SYNTHETIC-RM',
                'material_name': 'SYNTHETIC Resin', 'material_version': 'V1',
                'unit_id': '17000000000000002', 'unit_name': '千克', 'selectable': True,
                'dataset_id': dataset.pk, 'numerator': '0.02', 'denominator': '1',
                'required_quantity': format(Decimal(quantity) * Decimal('0.02'), 'f')}]}

    for plan in plans:
        for version in range(1, plan.work_version + 1):
            snap = snapshot(plan)
            if version < plan.work_version:
                snap['sequence'] = 9
                snap['planned_quantity'] = '2000.0'
            revision = PlanWorkRevision(id=len(revisions) + 1, work_id=plan.work_uid,
                version=version, snapshot=snap, fingerprint=digest(snap), change='baseline' if version == 1 else 'updated',
                reason='SYNTHETIC history', actor=user)
            revisions.append(revision)
            if kinds[plan.pk][0] or version < plan.work_version:
                material = material_snapshot(plan, version, snap['planned_quantity'])
                approval = PlanMaterialApproval(id=len(approvals) + 1, revision_id=revision.pk,
                    snapshot=material, fingerprint=digest(material), reason='SYNTHETIC exact reviewed ratio', actor=user)
                approvals.append(approval)
                if version == plan.work_version:
                    current_approvals[plan.pk] = approval
    retired_snapshot = snapshot(named['identity'])
    revisions.append(PlanWorkRevision(id=len(revisions) + 1, work_id=retired.uid, version=1,
        snapshot=retired_snapshot, fingerprint=digest(retired_snapshot), change='removed', actor=user))
    PlanWorkRevision.objects.bulk_create(revisions, batch_size=250)
    PlanMaterialApproval.objects.bulk_create(approvals, batch_size=250)
    for approval in approvals:
        approval.created_at = CLOCK + timedelta(microseconds=approval.pk)
    PlanMaterialApproval.objects.bulk_update(approvals, ['created_at'], batch_size=250)
    defaults, seen_parts = [], set()
    for plan in plans:
        if (plan.plan_type, plan.part_no) in seen_parts:
            continue
        seen_parts.add((plan.plan_type, plan.part_no))
        for version, effective in [(1, date(2000, 1, 1)), (2, date(2030, 1, 1))]:
            defaults.append(PlanMaterialDefault(id=len(defaults) + 1, plan_type=plan.plan_type,
                part_no=plan.part_no, version=version, effective_from=effective,
                snapshot=material_snapshot(plan, 1, '1000.0'), reason='SYNTHETIC explicit default', actor=user))
    PlanMaterialDefault.objects.bulk_create(defaults, batch_size=250)
    executions = []
    for name, actual, sequence in [('revision', 1500, 9), ('machining_revision', 1500, 9), ('machining_execution', 1100, 1)]:
        plan = named[name]
        executions.append(ProductionExecution(id=len(executions) + 1, plan_date=plan.plan_date,
            plan_type=plan.plan_type, machine_name=plan.machine_name, part_no=plan.part_no,
            lot_no=plan.lot_no, sequence=sequence, actual_qty=actual, updated_by=user))
    for kind in ('injection', 'machining'):
        for number in range(8):
            plan = named[f'history_{kind}_{number}']
            executions.append(ProductionExecution(id=len(executions) + 1, plan_date=plan.plan_date,
                plan_type=kind, machine_name=plan.machine_name, part_no=plan.part_no,
                lot_no=plan.lot_no, sequence=plan.sequence, actual_qty=10, updated_by=user))
    ProductionExecution.objects.bulk_create(executions, batch_size=250)
    orders, requests, events = [], [], []

    def order_for(key, members, *, state='disabled', observed=False):
        first, last = members[0], members[-1]
        material = setup_snapshot(current_approvals[first.pk])
        intent = {'plan_type': first.plan_type, 'machine_name': first.machine_name, 'part_no': first.part_no,
            'lot_no': first.lot_no, 'members': [str(plan.work_uid) for plan in members],
            'versions': {str(plan.work_uid): plan.work_version for plan in members},
            'approval_ids': [current_approvals[plan.pk].pk for plan in members],
            'quantity': format(sum((Decimal(str(plan.planned_quantity)) for plan in members), Decimal('0')), 'f'),
            'setup': material, 'setup_fingerprint': digest(material),
            'planned_start': datetime.combine(first.plan_date, datetime.min.time().replace(hour=8), SHANGHAI).isoformat(),
            'planned_end': datetime.combine(last.plan_date + timedelta(days=1), datetime.min.time().replace(hour=8), SHANGHAI).isoformat()}
        order = PlanWorkOrder(uid=uid(f'order-{key}'), code=f'SYNTHETIC-PERF-{key}', plan_type=first.plan_type,
            members=intent['members'], approved_snapshot=intent, setup_fingerprint=intent['setup_fingerprint'],
            mes_id='17000000000000009' if observed else '', observed_at=CLOCK if observed else None,
            observation_complete=observed, actual_started_at=CLOCK if observed else None,
            reported_quantity=1100 if key == 'machining-observed' else 20,
            inbound_quantity=1000 if key == 'machining-observed' else 10)
        orders.append(order)
        request = PlanMesRequest(uid=uid(f'request-{key}'), work_order=order, operation='create', state=state,
            intent=intent, contract={}, blockers=[], dedupe_key=digest({'synthetic-request': key}), actor=user,
            attempt=1 if state in ('sending', 'uncertain', 'readback_pending', 'review') else 0)
        requests.append(request)
        events.append(PlanMesRequestEvent(id=len(events) + 1, request=request, state=state, evidence={'synthetic': True}))

    order_for('campaign', [named[f'campaign_{day}'] for day in (8, 9, 10)])
    order_for('uncertain', [named['uncertain']], state='uncertain', observed=True)
    order_for('machining-observed', [named['machining_observed']], state='confirmed', observed=True)
    states = ('disabled', 'sending', 'uncertain', 'readback_pending', 'review', 'confirmed', 'superseded')
    for kind in ('injection', 'machining'):
        for number, state in enumerate(states, 1):
            order_for(f'history-{kind}-{number}', [named[f'history_{kind}_{number}']], state=state)
    PlanWorkOrder.objects.bulk_create(orders, batch_size=250)
    PlanMesRequest.objects.bulk_create(requests, batch_size=250)
    for index, request in enumerate(requests):
        request.created_at = CLOCK + timedelta(seconds=index)
        request.updated_at = request.created_at
    PlanMesRequest.objects.bulk_update(requests, ['created_at', 'updated_at'], batch_size=250)
    PlanMesRequestEvent.objects.bulk_create(events, batch_size=250)
    # Deterministic explicit PKs must not collide with later authorized fixture
    # mutations on PostgreSQL; SQLite advances its rowid automatically.
    sequence_models = [User, RawMaterialMESDataset, ProductionPlan, PlanWorkRevision,
        PlanMaterialApproval, PlanMaterialDefault, ProductionExecution, PlanMesRequestEvent]
    with connection.cursor() as cursor:
        for statement in connection.ops.sequence_reset_sql(no_style(), sequence_models):
            cursor.execute(statement)
        if connection.vendor == 'postgresql':
            # Autovacuum cannot analyze this fixture's uncommitted bulk rows.
            # Populate realistic cardinalities before measuring either source;
            # otherwise old LIMIT-1 joins pick pathological empty-table plans.
            for model in [*sequence_models, PlanWorkIdentity, PlanWorkOrder, PlanMesRequest]:
                cursor.execute(f'ANALYZE {connection.ops.quote_name(model._meta.db_table)}')
    return {'user': user, 'start': START, 'end': END, 'plans': plans,
        'named': {key: value for key, value in named.items() if key in core_names},
        'counts': {'plans': len(plans), 'identities': len(identities) + 1, 'revisions': len(revisions),
            'approvals': len(approvals), 'defaults': len(defaults), 'executions': len(executions),
            'orders': len(orders), 'requests': len(requests), 'events': len(events)}}


def measure_workflow_get(fixture, plan_type):
    from production.plan_workflow_views import PlanWorkflowView
    request = APIRequestFactory().get('/api/production/plan-workflow/', {
        'start': str(fixture['start']), 'end': str(fixture['end']), 'plan_type': plan_type})
    force_authenticate(request, user=fixture['user'])
    begin = time.perf_counter()
    # Django's normal 9,000-entry ring buffer would silently undercount the
    # unoptimized baseline. Keep a fresh sufficiently large buffer for each GET.
    original_query_log = connection.queries_log
    connection.queries_log = deque(maxlen=200000)
    try:
        with CaptureQueriesContext(connection) as captured:
            response = PlanWorkflowView.as_view()(request)
            rendered = JSONRenderer().render(response.data)
        queries = list(captured.captured_queries)
    finally:
        connection.queries_log = original_query_log
    elapsed = time.perf_counter() - begin
    if response.status_code != 200:
        raise AssertionError(f'GET returned {response.status_code}: {response.data}')
    sql = [item['sql'] for item in queries]
    writes = [query for query in sql if re.match(r'^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b', query, re.I)]
    canonical = json.dumps(response.data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return {'data': response.data, 'query_count': len(sql), 'write_queries': writes,
        'elapsed_seconds': elapsed, 'response_bytes': len(rendered),
        'response_sha256': hashlib.sha256(canonical).hexdigest(), 'sql': sql}


def workflow_state_digest():
    """Includes existing execution and every identity/history/request field."""
    models = (ProductionPlan, ProductionExecution, PlanWorkIdentity, PlanWorkRevision,
        PlanMaterialApproval, PlanMaterialDefault, PlanWorkOrder, PlanMesRequest, PlanMesRequestEvent)
    encoded = json.dumps({model.__name__: list(model.objects.order_by('pk').values()) for model in models},
                         cls=DjangoJSONEncoder, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(encoded).hexdigest()
