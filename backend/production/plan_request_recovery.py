"""Local request fences; no MES calls or historical-event rewriting."""
from django.db.models import Min

from .models import PlanMesRequestEvent


def latest_request(order):
    # The first audit event is immutable and breaks equal timestamps without
    # treating random UUID order or a later recheck event as a new generation.
    return order.requests.annotate(_first_event=Min('events__id')).order_by(
        '-created_at', '-_first_event', '-uid').first()


def payload_was_attempted(order, contract):
    # Approval IDs and local contract metadata do not change the provider bytes.
    from .plan_workflow import digest
    payload = contract.get('payload')
    return isinstance(payload, dict) and any(
        digest(previous.contract.get('payload')) == digest(payload)
        for previous in order.requests.filter(operation='create', attempt__gt=0))


def has_other_unresolved_attempt(req):
    return req.work_order.requests.filter(operation='create', attempt__gt=0).exclude(
        pk=req.pk).exclude(state='rejected').exists()


def observed_identity(order):
    return bool(order.mes_id) or any(
        event.get('mes_id') for event in PlanMesRequestEvent.objects.filter(
            request__work_order=order).values_list('evidence', flat=True))


def known_quality_rejection(req):
    return req.attempt == 1 and any(
        event.get('blockers') == ['input_quality_state_invalid']
        for event in req.events.filter(state='failed').values_list('evidence', flat=True))
