"""Load an explicitly pinned per-request policy from its existing binding.

No GET creates authority. The envelope is server-owned reviewed metadata, never
accepted by a browser serializer. It does not issue credentials, assign people,
create bindings, extend expiry or provide a provider concurrency implementation.
"""
from copy import copy, deepcopy
from dataclasses import asdict, fields
from datetime import datetime
from decimal import Decimal

from django.conf import settings

from .inspection_full_snapshot import FullSnapshotError, binding_fingerprint, canonical
from .inspection_full_snapshot_connection import ReviewedFullSnapshotConnection
from .inspection_full_snapshot_readback import DetailPin, FullDetailReview

POLICY_KEY = 'full_snapshot_connection'


def binding_scope_digest(binding):
    """Pin all binding metadata except this envelope, avoiding a self-digest."""
    scoped = copy(binding)
    scoped.contract = deepcopy(binding.contract)
    scoped.contract.pop(POLICY_KEY, None)
    return binding_fingerprint(scoped)


def _fail():
    raise FullSnapshotError('whole_connection_review_required')


def _encode_pin(value):
    if type(value) is Decimal:
        if not value.is_finite():
            _fail()
        return {'kind': 'decimal', 'value': str(value)}
    if type(value) is dict:
        if any(type(key) is not str for key in value):
            _fail()
        return {'kind': 'object', 'value': {key: _encode_pin(item) for key, item in value.items()}}
    if type(value) is list:
        return {'kind': 'array', 'value': [_encode_pin(item) for item in value]}
    if type(value) not in (str, int, bool, type(None)):
        _fail()
    return {'kind': 'scalar', 'value': value}


def _decode_pin(value):
    if type(value) is not dict or set(value) != {'kind', 'value'}:
        _fail()
    kind, raw = value['kind'], value['value']
    if kind == 'decimal' and type(raw) is str:
        result = Decimal(raw)
        if result.is_finite():
            return result
    elif kind == 'object' and type(raw) is dict:
        return {key: _decode_pin(item) for key, item in raw.items()}
    elif kind == 'array' and type(raw) is list:
        return [_decode_pin(item) for item in raw]
    elif kind == 'scalar' and type(raw) in (str, int, bool, type(None)):
        return raw
    _fail()


def load_binding_connection(request_id):
    from .inspection_models import InspectionMesBinding
    from .inspection_full_snapshot_product import FullSnapshotProductConnection
    binding = InspectionMesBinding.objects.filter(request_id=request_id).first()
    if binding is None or type(binding.contract) is not dict:
        _fail()
    manifest = binding.contract.get(POLICY_KEY)
    if type(manifest) is not dict:
        _fail()
    try:
        canonical(manifest)  # bounded JSON; no arbitrary objects/import paths
        if set(manifest) != {'schema', 'binding_scope_digest', 'policy', 'connector'}:
            _fail()
        if (manifest['schema'] != 'wj-full-snapshot-connection.v1'
                or manifest['binding_scope_digest'] != binding_scope_digest(binding)):
            _fail()
        data = deepcopy(manifest['policy'])
        expected = {item.name for item in fields(ReviewedFullSnapshotConnection)} - {'binding_digest'}
        if type(data) is not dict or set(data) != expected:
            _fail()
        if (type(data['request_id']) is not int or data['request_id'] != request_id
                or any(type(data[key]) is not int or data[key] <= 0
                       for key in ('actor_id', 'mes_user_id', 'source_request_version'))
                or type(data['reviewer_actor_id']) is not int
                or data['reviewer_actor_id'] < 0
                or any(type(data[key]) is not bool for key in
                       ('write_authorized', 'residual_remote_race', 'preserves_existing_records'))
                or data['source_mode'] not in {'completed_areas', 'independent_approval'}):
            _fail()
        data['expires_at'] = datetime.fromisoformat(data['expires_at'])
        review = data['detail_review']
        if type(review) is not dict or set(review) != {item.name for item in fields(FullDetailReview)}:
            _fail()
        pins = []
        if type(review['pins']) is not list or not 1 <= len(review['pins']) <= 10000:
            _fail()
        for row in review['pins']:
            if type(row) is not dict or set(row) != {'path', 'expected', 'comparison'}:
                _fail()
            if type(row['path']) is not list or not 1 <= len(row['path']) <= 12:
                _fail()
            expected_value = _decode_pin(row['expected'])
            if row['comparison'] == 'number':
                if type(expected_value) not in (int, Decimal):
                    _fail()
            pins.append(DetailPin(tuple(row['path']), expected_value, row['comparison']))
        data['detail_review'] = FullDetailReview(review['qc_code'], tuple(pins),
            tuple(tuple(pair) for pair in review['lifecycle_codes']),
            tuple(tuple(pair) for pair in review['verdict_codes']), tuple(review['confirmation_policy']))
        data['binding_digest'] = binding_fingerprint(binding)
        policy = ReviewedFullSnapshotConnection(**data)
        if not policy.matches(binding.request, binding):
            _fail()
        # Only deployment-owned callables can supply actual CAS/fencing.
        # Names in this JSON are never Python import paths or credential names.
        registry = getattr(settings, 'INSPECTION_FULL_SNAPSHOT_CONNECTORS', {})
        name = manifest['connector']
        if type(name) is not str or len(name) > 128:
            _fail()
        hooks = registry.get(name) if type(registry) is dict and name else None
        if hooks is not None and (type(hooks) is not dict
                or set(hooks) - {'atomic_writer', 'external_fence'}):
            _fail()
        hooks = hooks or {}
        return FullSnapshotProductConnection(policy, hooks.get('atomic_writer'), hooks.get('external_fence'))
    except FullSnapshotError:
        raise
    except (TypeError, ValueError, KeyError, AttributeError, ArithmeticError, RecursionError):
        _fail()


def reviewed_manifest(policy, binding, *, connector=''):
    """Serialize a completed review for a controlled server-side binding update.

    This pure helper writes nothing. Callers must independently authorize and
    audit any later persistence under the common request lock.
    """
    if type(policy) is not ReviewedFullSnapshotConnection or type(policy.detail_review) is not FullDetailReview:
        _fail()
    data = asdict(policy)
    data.pop('binding_digest')
    data['expires_at'] = policy.expires_at.isoformat()
    for pin in data['detail_review']['pins']:
        pin['expected'] = _encode_pin(pin['expected'])
    import json
    return json.loads(canonical({'schema': 'wj-full-snapshot-connection.v1',
        'binding_scope_digest': binding_scope_digest(binding), 'policy': data, 'connector': connector}))
