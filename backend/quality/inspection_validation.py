"""Bounded local input contract; deliberately separate from any MES schema."""
import hashlib
import json
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

from django.utils import timezone
from rest_framework import serializers


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def quantity(value, field='quantity', positive=False):
    try:
        if isinstance(value, bool):
            raise ValueError()
        result = Decimal(str(value))
        if not result.is_finite() or result < 0 or result >= Decimal('1000000000000000') or result.as_tuple().exponent < -3:
            raise ValueError()
        if positive and result <= 0:
            raise ValueError()
    except (InvalidOperation, ValueError, TypeError):
        raise serializers.ValidationError({field: 'Use a finite nonnegative quantity with at most 3 decimal places.'})
    return result


def safe_evidence_url(value):
    if not isinstance(value, str):
        raise serializers.ValidationError('Evidence URL must be text.')
    try:
        parsed = urlsplit(value)
        if (len(value) > 500 or any(char.isspace() for char in value) or parsed.scheme != 'https' or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.hostname in {'localhost', '127.0.0.1', '::1'}):
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise serializers.ValidationError('Use an HTTPS evidence link without credentials, query or fragment.')
    # Links are references; the server never fetches them or treats them as verified attachments.
    return value


def validate_items(items):
    if not isinstance(items, list) or not 1 <= len(items) <= 50:
        raise serializers.ValidationError('Define 1 to 50 inspection items.')
    ids = set()
    normalized = []
    for item in items:
        if not isinstance(item, dict) or set(item) - {'id', 'label', 'kind', 'unit', 'minimum', 'maximum', 'required', 'evidence_required', 'options'}:
            raise serializers.ValidationError('Invalid inspection item fields.')
        item_id, label = item.get('id'), item.get('label')
        if not isinstance(item_id, str) or not item_id or len(item_id) > 64 or item_id in ids:
            raise serializers.ValidationError('Item ids must be unique, nonempty strings.')
        if not isinstance(label, str) or not label.strip() or len(label) > 128:
            raise serializers.ValidationError('Item label is required (up to 128 characters).')
        kind = item.get('kind', 'text')
        if (kind not in {'text', 'number', 'choice'} or not isinstance(item.get('evidence_required', False), bool)
                or not isinstance(item.get('required', True), bool)):
            raise serializers.ValidationError('Invalid item type or evidence requirement.')
        unit = item.get('unit', '')
        if not isinstance(unit, str) or len(unit) > 32:
            raise serializers.ValidationError('Invalid unit.')
        result = {'id': item_id, 'label': label.strip(), 'kind': kind, 'unit': unit,
                  'required': item.get('required', True), 'evidence_required': item.get('evidence_required', False)}
        if kind == 'choice':
            options = item.get('options')
            if (not isinstance(options, list) or not 2 <= len(options) <= 20
                    or any(not isinstance(v, str) or not v.strip() or len(v) > 128 for v in options)
                    or len(set(options)) != len(options)):
                raise serializers.ValidationError('Choice items require 2 to 20 unique nonempty options.')
            result['options'] = options
        for key in ('minimum', 'maximum'):
            value = item.get(key)
            if value is not None and value != '':
                try:
                    number = Decimal(str(value))
                    if kind != 'number' or not number.is_finite() or abs(number) > Decimal('1e12'):
                        raise ValueError()
                    result[key] = str(number)
                except (InvalidOperation, ValueError):
                    raise serializers.ValidationError('Invalid numeric specification.')
        if 'minimum' in result and 'maximum' in result and Decimal(result['minimum']) > Decimal(result['maximum']):
            raise serializers.ValidationError('Minimum cannot exceed maximum.')
        ids.add(item_id)
        normalized.append(result)
    return normalized


class StrictSerializer(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, dict) or set(data) - set(self.fields):
            raise serializers.ValidationError({'non_field_errors': ['Unknown or server-controlled fields are not allowed.']})
        return super().to_internal_value(data)


class CreateInspectionSerializer(StrictSerializer):
    work_order_ref = serializers.CharField(max_length=128)
    task_ref = serializers.CharField(max_length=128)
    part_no = serializers.CharField(max_length=128)
    equipment_ref = serializers.CharField(max_length=128)
    inspection_type = serializers.ChoiceField(choices=['first', 'process', 'final'], default='first')
    target_quantity = serializers.DecimalField(max_digits=18, decimal_places=3, min_value=Decimal('0.001'))
    uom = serializers.CharField(max_length=32)
    warehouse_ref = serializers.CharField(max_length=128)
    lot_ref = serializers.CharField(max_length=128)
    work_started_at = serializers.DateTimeField()
    inspection_items = serializers.JSONField()
    require_evidence = serializers.BooleanField(default=False)
    quantity_mode = serializers.ChoiceField(choices=['recorded', 'not_recorded'], default='recorded')
    judgement_policy = serializers.ChoiceField(choices=['strict_items', 'independent'], default='strict_items')
    role_workflow = serializers.BooleanField(default=False)

    def validate_inspection_items(self, value):
        return validate_items(value)

    def validate(self, attrs):
        if attrs.get('role_workflow') and len(attrs.get('inspection_items', [])) < 2:
            raise serializers.ValidationError({'inspection_items': 'A role inspection needs at least one item in each of the two areas.'})
        return attrs

    def validate_work_started_at(self, value):
        if value > timezone.now():
            raise serializers.ValidationError('Work start cannot be in the future; this is self-reported local evidence.')
        return value

    def validate_part_no(self, value):
        return value.upper()


class DraftInspectionSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=1)
    measurements = serializers.JSONField()
    evidence = serializers.JSONField()
    inspected_quantity = serializers.DecimalField(max_digits=18, decimal_places=3, min_value=0)
    accepted_quantity = serializers.DecimalField(max_digits=18, decimal_places=3, min_value=0)
    rejected_quantity = serializers.DecimalField(max_digits=18, decimal_places=3, min_value=0)
    judgement = serializers.ChoiceField(choices=['', 'pass', 'fail'])
    notes = serializers.CharField(max_length=2000, allow_blank=True, default='')

    def validate_evidence(self, evidence):
        if not isinstance(evidence, list) or len(evidence) > 10:
            raise serializers.ValidationError('At most 10 evidence references.')
        for entry in evidence:
            if not isinstance(entry, dict) or set(entry) != {'label', 'url'}:
                raise serializers.ValidationError('Evidence needs label and url only.')
            if not isinstance(entry['label'], str) or not entry['label'].strip() or len(entry['label']) > 128:
                raise serializers.ValidationError('Evidence label is required.')
            safe_evidence_url(entry['url'])
        return evidence

    def validate_measurements(self, measurements):
        if not isinstance(measurements, list) or len(measurements) > 50:
            raise serializers.ValidationError('At most 50 measurements.')
        ids = set()
        for entry in measurements:
            if not isinstance(entry, dict) or set(entry) - {'item_id', 'value', 'judgement', 'evidence_url'}:
                raise serializers.ValidationError('Invalid measurement fields.')
            item_id = entry.get('item_id')
            if not isinstance(item_id, str) or item_id in ids or not item_id or len(item_id) > 64:
                raise serializers.ValidationError('Measurement item ids must be unique.')
            if not isinstance(entry.get('value'), str) or len(entry['value']) > 500:
                raise serializers.ValidationError('Value must be text, up to 500 characters.')
            if entry.get('judgement', '') not in {'', 'pass', 'fail'}:
                raise serializers.ValidationError('Invalid judgement.')
            if entry.get('evidence_url'):
                safe_evidence_url(entry['evidence_url'])
            ids.add(item_id)
        return measurements


class CreateIntegrationTrialSerializer(StrictSerializer):
    code = serializers.CharField(max_length=54)
    inspection_items = serializers.JSONField()

    def validate_code(self, value):
        from .inspection_integration_trial import trial_code
        try:
            return trial_code(value)
        except ValueError:
            raise serializers.ValidationError('Use a WJ-IT- integration trial code.') from None

    def validate_inspection_items(self, value):
        return validate_items(value)


class ActionSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=1)
    reason = serializers.CharField(max_length=500, allow_blank=True, default='')


class SubmitInspectionSerializer(ActionSerializer):
    # Optional for older clients; the owner selects this only after saved input.
    judgement = serializers.ChoiceField(choices=['pass', 'fail', 'concession'], required=False)


def validate_result(request, *, submit=False):
    if request.inspected_quantity > request.target_quantity:
        raise serializers.ValidationError({'inspected_quantity': 'Cannot exceed request quantity.'})
    if request.accepted_quantity + request.rejected_quantity != request.inspected_quantity:
        raise serializers.ValidationError('Accepted + rejected must equal inspected quantity.')
    if request.quantity_mode == 'not_recorded' and any([request.inspected_quantity, request.accepted_quantity, request.rejected_quantity]):
        raise serializers.ValidationError('This snapshot does not record quantities; leave them at zero.')
    definitions = {item['id']: item for item in request.inspection_items}
    measured = {entry['item_id']: entry for entry in request.measurements}
    if set(measured) - set(definitions):
        raise serializers.ValidationError('Measurement references an unknown item.')
    if not submit:
        return
    required = {item_id for item_id, item in definitions.items() if item.get('required', True)}
    if not required.issubset(measured) or (request.quantity_mode == 'recorded' and request.inspected_quantity <= 0):
        raise serializers.ValidationError('Required items and configured inspection quantity are needed.')
    if request.require_evidence and not request.evidence:
        raise serializers.ValidationError('This snapshot requires evidence.')
    failures = False
    for item_id, item in definitions.items():
        entry = measured.get(item_id)
        if not item.get('required', True) and (not entry or not entry.get('value', '').strip()):
            continue
        if not entry['value'].strip() or entry.get('judgement') not in {'pass', 'fail'}:
            raise serializers.ValidationError('Every item requires a value and judgement.')
        if item['evidence_required'] and not entry.get('evidence_url'):
            raise serializers.ValidationError('Item evidence is required.')
        if item['kind'] == 'number':
            try:
                number = Decimal(entry['value'])
                if not number.is_finite() or abs(number) > Decimal('1e12'):
                    raise ValueError()
            except (InvalidOperation, ValueError):
                raise serializers.ValidationError('Numeric measurement must be finite.')
            outside = (('minimum' in item and number < Decimal(item['minimum']))
                       or ('maximum' in item and number > Decimal(item['maximum'])))
            if outside and entry['judgement'] != 'fail':
                raise serializers.ValidationError('Out-of-spec measurement cannot pass.')
        if item['kind'] == 'choice' and entry['value'] not in item['options']:
            raise serializers.ValidationError('Choose one configured option.')
        failures = failures or entry['judgement'] == 'fail'
    if request.judgement not in {'pass', 'fail', 'concession'} or (request.judgement_policy == 'strict_items' and failures and request.judgement not in {'fail', 'concession'}):
        raise serializers.ValidationError('Overall judgement must match item results.')
    if request.judgement == 'pass' and request.rejected_quantity != 0:
        raise serializers.ValidationError('Passed inspection cannot contain rejected quantity.')
    if request.quantity_mode == 'recorded' and request.judgement == 'fail' and request.rejected_quantity <= 0:
        raise serializers.ValidationError('Failed inspection requires rejected quantity.')
