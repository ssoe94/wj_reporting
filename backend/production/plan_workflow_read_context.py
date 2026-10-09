"""Request-local bulk reads only; no cached authority, writes or MES access."""
from collections import defaultdict

from django.db import connection
from django.db.models import F, Q

from .models import (ProductionPlan, ProductionExecution, PlanWorkIdentity,
                     PlanWorkRevision, PlanMaterialApproval, PlanMaterialDefault,
                     PlanWorkOrder, PlanMesRequest)


def chunks(values, size=400):
    values = list(values)
    for offset in range(0, len(values), size):
        yield values[offset:offset + size]


class PlanWorkflowReadContext:
    """Preserve the full bounded campaign horizon, sharing reads with UI rows.

    SQL subqueries keep the 5,000-row scope independent of IN parameter limits.
    The context is created anew inside each GET/locked prepare, never reused
    after a writer or across requests.
    """
    def __init__(self, start, end, plan_type):
        self.plan_type = plan_type
        selected = ProductionPlan.objects.filter(plan_type=plan_type, plan_date__range=(start, end))
        history = ProductionPlan.objects.filter(plan_type=plan_type,
            machine_name__in=selected.order_by().values('machine_name').distinct()
        ).order_by('machine_name', 'plan_date', 'sequence', 'id')
        self.rows = list(selected)
        horizon = list(history[:5001])
        self.truncated = len(horizon) > 5000
        self.plans = horizon[:5000]
        # Include display rows beyond the truncated preview without making
        # those rows eligible for transmission.
        work_scope = PlanWorkIdentity.objects.filter(
            Q(uid__in=history.values('work_uid')[:5000]) |
            Q(uid__in=selected.order_by().values('work_uid')))
        self.works = {row.uid: row for row in work_scope}
        self.approvals = {}
        self.approvals_by_work = defaultdict(list)
        for approval in PlanMaterialApproval.objects.filter(revision__work_id__in=work_scope.values('uid'))\
                .select_related('revision', 'actor').order_by('-id'):
            key = (approval.revision.work_id, approval.revision.version)
            self.approvals.setdefault(key, approval)
            self.approvals_by_work[key[0]].append(approval)
        self._display_loaded = False
        self.defaults = defaultdict(list)
        self.candidate_details = {}

    def approval(self, plan):
        return self.approvals.get((plan.work_uid, plan.work_version))

    def load_display(self):
        if self._display_loaded:
            return
        self._display_loaded = True
        parts = {row.part_no for row in self.rows if row.part_no is not None}
        for batch in chunks(parts):
            for item in PlanMaterialDefault.objects.filter(plan_type=self.plan_type, part_no__in=batch)\
                    .order_by('-effective_from', '-version'):
                self.defaults[item.part_no].append(item)
        candidates = {uid for plan in self.rows for uid in
                      (self.works[plan.work_uid].candidates if plan.work_uid in self.works else [])}
        for batch in chunks(candidates):
            identities = list(PlanWorkIdentity.objects.filter(uid__in=batch))
            revisions = {row.work_id: row.snapshot for row in PlanWorkRevision.objects.filter(
                work_id__in=batch, version=F('work__current_version'))}
            for work in identities:
                if work.uid not in revisions:
                    # A broken candidate's history must not silently disappear.
                    raise PlanWorkRevision.DoesNotExist('Candidate current revision is missing.')
                self.candidate_details[str(work.uid)] = {'uid': str(work.uid), 'snapshot': revisions[work.uid]}


EXECUTION_FIELDS = ('plan_date', 'plan_type', 'machine_name', 'part_no', 'lot_no', 'sequence')


def execution_key(row):
    """Only part None normalizes to ''; NULL and empty LOT stay distinct."""
    return (str(row['plan_date']), row['plan_type'], row['machine_name'], row['part_no'] or '',
            row['lot_no'], row['sequence'])


def group_execution_records(plan_groups, snapshot):
    """Read history only for returned groups, match exact keys and dedupe by PK.

    Broad, indexed candidates avoid thousands of OR terms. Optional filters
    fit the backend parameter budget; omitting a filter broadens the read, not
    the exact matching rule. Never truncate actual records or treat them as MES
    production/inbound totals.
    """
    records = [{} for _ in plan_groups]
    targets = defaultdict(set)
    work_groups = defaultdict(set)
    for index, plans in enumerate(plan_groups):
        for plan in plans:
            targets[execution_key(snapshot(plan))].add(index)
            if plan.work_uid:
                work_groups[plan.work_uid].add(index)
    for batch in chunks(work_groups):
        for uid, row in PlanWorkRevision.objects.filter(work_id__in=batch).values_list('work_id', 'snapshot'):
            targets[execution_key(row)].update(work_groups[uid])
    if not targets:
        return records
    dates = [key[0] for key in targets]
    filters = Q(plan_date__range=(min(dates), max(dates)))
    budget = min(connection.features.max_query_params or 900, 900) - 2
    # Types are also optional if corrupt/legacy history has an enormous set;
    # exact tuple matching below is always authoritative.
    for field, position in (('plan_type', 1), ('machine_name', 2), ('part_no', 3), ('lot_no', 4), ('sequence', 5)):
        values = {key[position] for key in targets}
        nonnull = values - {None}
        if len(nonnull) > budget:
            continue
        condition = Q(**{field + '__in': nonnull})
        if None in values:
            condition |= Q(**{field + '__isnull': True})
        filters &= condition
        budget -= len(nonnull)
    candidates = ProductionExecution.objects.filter(filters).order_by().values_list('pk', 'actual_qty', *EXECUTION_FIELDS)
    for values in candidates.iterator(chunk_size=2000):
        pk, quantity, *fields = values
        key = (str(fields[0]), fields[1], fields[2], fields[3] or '', fields[4], fields[5])
        for index in targets.get(key, ()):
            records[index][pk] = quantity
    return records


def order_read_context(plan_type):
    orders = list(PlanWorkOrder.objects.filter(plan_type=plan_type))
    by_member = defaultdict(list)
    for order in orders:
        for uid in set(order.members):
            by_member[uid].append(order)
    unresolved, disabled = set(), {}
    if orders:
        scope = PlanWorkOrder.objects.filter(plan_type=plan_type).values('uid')
        for request in PlanMesRequest.objects.filter(work_order_id__in=scope,
                state__in=['sending', 'uncertain', 'readback_pending', 'review', 'disabled']).order_by('-created_at'):
            if request.state == 'disabled':
                disabled.setdefault(request.work_order_id, request)
            else:
                unresolved.add(request.work_order_id)
    return by_member, unresolved, disabled
