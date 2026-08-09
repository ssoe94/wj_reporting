"""Persistent, reusable model-pair decisions for the mould dashboard.

The rules live in a dedicated ``MouldDataSnapshot`` document so the feature can
be deployed without changing the database schema.  BLACKLAKE board/detail
refreshes use different exact snapshot keys and never overwrite this document.
"""

from __future__ import annotations

import copy
import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
from hashlib import sha256
from typing import Any

from django.db import transaction
from django.utils import timezone

from .models import MouldDataSnapshot
from .mould_snapshots import BOARD_SNAPSHOT_KEY


VALIDATION_RULES_SNAPSHOT_KEY = 'mould-machine-validation-rules:v1'
VALIDATION_DOCUMENT_TYPE = 'machine_model_validation_rules'
VALIDATION_SCHEMA_VERSION = 1
VALIDATION_ALGORITHM_VERSION = 'model-relation-v2'
VALIDATION_DECISIONS = {'match', 'mismatch'}
MAX_HISTORY_ITEMS = 1_000

_STRUCTURED_MODEL_RE = re.compile(r'^[A-Z0-9][A-Z0-9._/-]*$')
_MODEL_SEPARATOR_RE = re.compile(r'[._/-]')


class MouldMachineValidationError(ValueError):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def normalize_model_value(value: Any) -> str:
    normalized = unicodedata.normalize('NFKC', str(value or '')).strip().upper()
    return ''.join(normalized.split())


def model_rule_token(value: Any) -> tuple[str, bool]:
    normalized = normalize_model_value(value)
    structured = bool(
        normalized
        and _STRUCTURED_MODEL_RE.fullmatch(normalized)
        and re.search(r'[A-Z]', normalized)
        and re.search(r'\d', normalized)
    )
    if structured:
        return _MODEL_SEPARATOR_RE.split(normalized, maxsplit=1)[0], True
    return normalized, False


def _string_list(value: Any, *, max_items: int, max_length: int) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    result: list[str] = []
    for item in value[:max_items]:
        normalized = str(item or '').strip()[:max_length]
        if normalized and normalized not in result:
            result.append(normalized)
    return result


def build_validation_lookup(
    *,
    mould_instance_id: str,
    mould_model: Any,
    production_models: Sequence[Any],
    drawing_no: Any = '',
    asset_code: Any = '',
) -> dict[str, str]:
    instance_id = str(mould_instance_id or '').strip()
    mould_key, mould_structured = model_rule_token(mould_model)
    production_tokens = sorted({
        token
        for value in production_models
        for token, _structured in [model_rule_token(value)]
        if token
    })
    production_structured = all(
        structured
        for value in production_models
        for token, structured in [model_rule_token(value)]
        if token
    )
    if not instance_id:
        raise MouldMachineValidationError('mould_instance_id is required.')
    if not mould_key:
        raise MouldMachineValidationError('MES 금형 모델 정보가 없어 판정 규칙을 저장할 수 없습니다.', status_code=409)
    if not production_tokens:
        raise MouldMachineValidationError('생산 모델 정보가 없어 판정 규칙을 저장할 수 없습니다.', status_code=409)

    if mould_structured and production_structured:
        scope = 'model_pair'
        stored_mould_key = mould_key
    else:
        scope = 'instance_pair'
        evidence_key = normalize_model_value(drawing_no) or normalize_model_value(asset_code) or mould_key
        stored_mould_key = f'{instance_id}:{evidence_key}'
    production_key = '+'.join(production_tokens)
    lookup_key = json.dumps(
        [scope, stored_mould_key, production_key],
        ensure_ascii=False,
        separators=(',', ':'),
    )
    rule_key = sha256(
        f'{VALIDATION_ALGORITHM_VERSION}|{lookup_key}'.encode('utf-8')
    ).hexdigest()
    return {
        'rule_key': rule_key,
        'lookup_key': lookup_key,
        'scope': scope,
        'mould_model_key': stored_mould_key,
        'production_model_key': production_key,
    }


def _empty_document() -> dict[str, Any]:
    return {
        'document_type': VALIDATION_DOCUMENT_TYPE,
        'schema_version': VALIDATION_SCHEMA_VERSION,
        'algorithm_version': VALIDATION_ALGORITHM_VERSION,
        'rules': {},
        'history': [],
    }


def _valid_document(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and value.get('document_type') == VALIDATION_DOCUMENT_TYPE
        and value.get('schema_version') == VALIDATION_SCHEMA_VERSION
        and isinstance(value.get('rules'), Mapping)
    )


def _public_rule(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    if value.get('algorithm_version') != VALIDATION_ALGORITHM_VERSION:
        return None
    decision = str(value.get('decision') or '')
    if decision not in VALIDATION_DECISIONS:
        return None
    required = ('rule_key', 'lookup_key', 'scope', 'mould_model_key', 'production_model_key')
    if any(not value.get(field) for field in required):
        return None
    return {
        'rule_key': str(value['rule_key']),
        'lookup_key': str(value['lookup_key']),
        'scope': str(value['scope']),
        'mould_model_key': str(value['mould_model_key']),
        'production_model_key': str(value['production_model_key']),
        'decision': decision,
        'confirmed_at': str(value.get('confirmed_at') or ''),
        'revision': max(1, int(value.get('revision') or 1)),
    }


def list_validation_rules() -> list[dict[str, Any]]:
    snapshot = MouldDataSnapshot.objects.filter(
        snapshot_key=VALIDATION_RULES_SNAPSHOT_KEY,
    ).only('payload').first()
    if snapshot is None or not _valid_document(snapshot.payload):
        return []
    rules = snapshot.payload.get('rules', {})
    public_rules = [
        public_rule
        for value in rules.values()
        for public_rule in [_public_rule(value)]
        if public_rule is not None
    ]
    return sorted(
        public_rules,
        key=lambda item: (item.get('confirmed_at') or '', item['rule_key']),
        reverse=True,
    )


def _mounted_board_mould(instance_id: str) -> Mapping[str, Any]:
    board = MouldDataSnapshot.objects.filter(
        snapshot_key=BOARD_SNAPSHOT_KEY,
    ).only('payload').first()
    if board is None:
        raise MouldMachineValidationError(
            '금형 현황 스냅샷을 먼저 불러와 주세요.',
            status_code=409,
        )
    moulds = board.payload.get('moulds') if isinstance(board.payload, Mapping) else None
    if not isinstance(moulds, Sequence) or isinstance(moulds, (str, bytes, bytearray)):
        raise MouldMachineValidationError('금형 현황 데이터가 올바르지 않습니다.', status_code=409)
    mould = next((
        row for row in moulds
        if isinstance(row, Mapping) and str(row.get('instance_id') or '') == instance_id
    ), None)
    if mould is None:
        raise MouldMachineValidationError('현재 MES 금형 현황에서 장착 금형을 찾지 못했습니다.', status_code=409)
    location = mould.get('location')
    if not isinstance(location, Mapping) or location.get('kind') != 'machine':
        raise MouldMachineValidationError(
            'MES에 사출기 장착 금형으로 등록된 경우에만 판정할 수 있습니다.',
            status_code=409,
        )
    return mould


def _load_locked_document() -> tuple[MouldDataSnapshot, dict[str, Any]]:
    snapshot, created = MouldDataSnapshot.objects.get_or_create(
        snapshot_key=VALIDATION_RULES_SNAPSHOT_KEY,
        defaults={
            'kind': MouldDataSnapshot.KIND_BOARD,
            'instance_id': '',
            'payload': _empty_document(),
            'last_error': '',
        },
    )
    if not created:
        snapshot = MouldDataSnapshot.objects.select_for_update().get(pk=snapshot.pk)
    document = copy.deepcopy(snapshot.payload)
    if not _valid_document(document):
        raise MouldMachineValidationError('판정 규칙 저장 문서 형식이 올바르지 않습니다.', status_code=409)
    document['algorithm_version'] = VALIDATION_ALGORITHM_VERSION
    return snapshot, document


def _validation_context(payload: Mapping[str, Any]) -> tuple[Mapping[str, Any], list[str], dict[str, str]]:
    instance_id = str(payload.get('mould_instance_id') or '').strip()
    if not instance_id.isdigit():
        raise MouldMachineValidationError('Invalid mould_instance_id.')
    production_models = _string_list(
        payload.get('production_models'),
        max_items=8,
        max_length=160,
    )
    mould = _mounted_board_mould(instance_id)
    lookup = build_validation_lookup(
        mould_instance_id=instance_id,
        mould_model=mould.get('model'),
        production_models=production_models,
        drawing_no=mould.get('drawing_no'),
        asset_code=mould.get('asset_code'),
    )
    return mould, production_models, lookup


def save_validation_rule(payload: Mapping[str, Any], *, user) -> dict[str, Any]:
    decision = str(payload.get('decision') or '').strip().lower()
    if decision not in VALIDATION_DECISIONS:
        raise MouldMachineValidationError('decision must be match or mismatch.')
    mould, production_models, lookup = _validation_context(payload)
    part_nos = _string_list(payload.get('part_nos'), max_items=24, max_length=120)
    location = mould.get('location') if isinstance(mould.get('location'), Mapping) else {}
    now = timezone.now().isoformat()

    with transaction.atomic():
        snapshot, document = _load_locked_document()
        rules = dict(document.get('rules', {}))
        existing = rules.get(lookup['rule_key'])
        existing = existing if isinstance(existing, Mapping) else {}
        revision = max(0, int(existing.get('revision') or 0)) + 1
        rule = {
            **lookup,
            'decision': decision,
            'algorithm_version': VALIDATION_ALGORITHM_VERSION,
            'mould_instance_id': str(mould.get('instance_id') or ''),
            'mould_model': str(mould.get('model') or ''),
            'production_models': production_models,
            'evidence': {
                'mould_code': str(mould.get('mould_code') or ''),
                'drawing_no': str(mould.get('drawing_no') or ''),
                'asset_code': str(mould.get('asset_code') or ''),
                'machine_number': location.get('machine_number'),
                'part_nos': part_nos,
                'production_mode': str(payload.get('production_mode') or '')[:32],
                'cavity_pattern': str(payload.get('cavity_pattern') or '')[:80],
                'business_date': str(payload.get('business_date') or '')[:10],
            },
            'created_at': str(existing.get('created_at') or now),
            'confirmed_at': now,
            'confirmed_by_id': getattr(user, 'pk', None),
            'confirmed_by': user.get_username() if user else '',
            'revision': revision,
        }
        rules[lookup['rule_key']] = rule
        history = list(document.get('history', []))
        history.append({
            'action': 'confirm',
            'rule_key': lookup['rule_key'],
            'decision': decision,
            'previous_decision': existing.get('decision'),
            'at': now,
            'by_id': getattr(user, 'pk', None),
            'by': user.get_username() if user else '',
            'revision': revision,
        })
        document['rules'] = rules
        document['history'] = history[-MAX_HISTORY_ITEMS:]
        snapshot.payload = document
        snapshot.kind = MouldDataSnapshot.KIND_BOARD
        snapshot.instance_id = ''
        snapshot.last_error = ''
        snapshot.save(update_fields=['payload', 'kind', 'instance_id', 'last_error', 'refreshed_at'])

    public_rule = _public_rule(rule)
    if public_rule is None:  # Defensive: saved rules must always be public-safe.
        raise MouldMachineValidationError('저장된 판정 규칙을 확인할 수 없습니다.', status_code=500)
    return public_rule


def delete_validation_rule(payload: Mapping[str, Any], *, user) -> tuple[str, bool]:
    _mould, _production_models, lookup = _validation_context(payload)
    with transaction.atomic():
        snapshot, document = _load_locked_document()
        rules = dict(document.get('rules', {}))
        existing = rules.pop(lookup['rule_key'], None)
        if existing is None:
            return lookup['rule_key'], False
        now = timezone.now().isoformat()
        history = list(document.get('history', []))
        history.append({
            'action': 'reset',
            'rule_key': lookup['rule_key'],
            'previous_decision': existing.get('decision') if isinstance(existing, Mapping) else None,
            'at': now,
            'by_id': getattr(user, 'pk', None),
            'by': user.get_username() if user else '',
        })
        document['rules'] = rules
        document['history'] = history[-MAX_HISTORY_ITEMS:]
        snapshot.payload = document
        snapshot.save(update_fields=['payload', 'refreshed_at'])
    return lookup['rule_key'], True
