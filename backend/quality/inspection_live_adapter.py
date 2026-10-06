"""One reviewed inspection, using its verified user's server-side credential.

No setting is inferred from a browser, a role, claim eligibility or an API
acknowledgement. The time-bounded server contract is an explicit operational
approval, not a claim that Blacklake exposes a save/finish permission flag.
Blacklake enforces that user's authority on each operation. An uncertain write
is reconciled through the existing durable stage coordinator, never retried.
"""
from dataclasses import dataclass
from datetime import date, datetime, timedelta
import json
import re

from django.conf import settings
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from .inspection_adapter import MesContractUnavailable, MesOutcomeUnknown
from .inspection_blacklake_contract import ScopedInspectionReadClient, mes_id, result_and_finish_plan
from .inspection_transport import (BlacklakeInspectionTransport, InspectionUserAccessToken,
    ReviewedFinishAuthorization, ReviewedWriteAuthorization, stages_digest)
from .inspection_validation import digest


class InspectionAppCredentialUnavailable(MesContractUnavailable):
    """Server app supply failed before this operation's provider callback."""


class InspectionIdentityUnavailable(MesContractUnavailable):
    """User identity could not be rechecked; no write callback was invoked."""


class InspectionConnectionRequired(MesContractUnavailable):
    """No write was attempted; reconnect without losing the ready/saved phase."""


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def _reference(value):
    return type(value) is str and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', value))


def _hex(value):
    return type(value) is str and bool(re.fullmatch(r'[0-9a-f]{64}', value))


def binding_digest(binding):
    """Only immutable reviewed intent; mutable phase/evidence are not signed."""
    return digest({'request_id': str(binding.request_id), 'tenant': binding.tenant,
        'qc_id': binding.qc_id, 'work_order_id': binding.work_order_id,
        'test_label': binding.test_label, 'test_only': binding.test_only,
        'reviewed_result_digest': binding.reviewed_result_digest, 'contract': binding.contract})


def records_digest(records):
    return digest(sorted(records, key=lambda row: (row['group'], row['config_row_id'], row['seq'])))


def _board_binding(value, expires_at):
    if value is None:
        return
    if (type(value) is not dict or set(value) != {'business_date', 'machine_number',
            'current_plan_id', 'plan_version', 'generation', 'reference', 'valid_from',
            'valid_until', 'stale_after_seconds'}
            or type(value['machine_number']) is not int or not 1 <= value['machine_number'] <= 17
            or type(value['current_plan_id']) is not int or value['current_plan_id'] < 1
            or type(value['generation']) is not int or value['generation'] < 1
            or not _hex(value['plan_version']) or not _reference(value['reference'])
            or type(value['stale_after_seconds']) is not int or not 1 <= value['stale_after_seconds'] <= 300
            or date.fromisoformat(value['business_date']).isoformat() != value['business_date']):
        raise ValueError()
    start, end = (datetime.fromisoformat(value[key]) for key in ('valid_from', 'valid_until'))
    if (start.utcoffset() is None or end.utcoffset() is None
            or not start <= timezone.now() < end <= expires_at):
        raise ValueError()


@dataclass(frozen=True)
class InspectionProviderPolicy:
    data: dict
    fingerprint: str
    expires_at: datetime

    def current(self):
        try:
            return load_policy().fingerprint == self.fingerprint
        except (MesContractUnavailable, ValueError, TypeError):
            return False

    def matches(self, binding):
        try:
            return (self.current() and binding.test_only is True
                and str(binding.request_id) == self.data['request_id']
                and binding.tenant == self.data['tenant']
                and binding.qc_id == self.data['qc_id']
                and binding.work_order_id == self.data['work_order_id']
                and str(binding.contract['actor_id']) == self.data['mes_user_id']
                and binding_digest(binding) == self.data['binding_digest'])
        except (AttributeError, KeyError, ValueError, TypeError):
            return False


def load_policy():
    if getattr(settings, 'MES_INSPECTION_ENABLED', False) is not True:
        raise MesContractUnavailable()
    return parse_policy(getattr(settings, 'MES_INSPECTION_CONTRACT', ''))


def parse_policy(raw):
    """Validate a proposed server contract without enabling or contacting MES."""
    try:
        if type(raw) is not str or not 1 <= len(raw.encode()) <= 32768:
            raise ValueError()
        value = json.loads(raw, object_pairs_hook=_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        if type(value) is not dict or set(value) - {'board_binding', 'single_actor_test_reference'} != {
            'reference', 'authority_reference', 'expires_at', 'actor_id', 'mes_user_id',
            'tenant', 'origin', 'request_id', 'qc_id', 'work_order_id', 'binding_digest',
            'initial_records_digest', 'detail_contract'}:
            raise ValueError()
        if ('single_actor_test_reference' in value
                and not _reference(value['single_actor_test_reference'])):
            raise ValueError()
        if (not all(_reference(value[key]) for key in ('reference', 'authority_reference', 'tenant'))
                or type(value['actor_id']) is not int or value['actor_id'] < 1
                or value['origin'] not in {'https://v3-ali.blacklake.cn', 'https://v3-hw.blacklake.cn'}
                or value['origin'] != getattr(settings, 'MES_USER_OAUTH_PROVIDER_ORIGIN', '')
                or value['tenant'] != getattr(settings, 'MES_USER_TOKEN_TENANT_REFERENCE', '')
                or not _hex(value['binding_digest']) or not _hex(value['initial_records_digest'])):
            raise ValueError()
        for key in ('mes_user_id', 'qc_id', 'work_order_id', 'request_id'):
            if type(value[key]) is not str:
                raise ValueError()
            mes_id(value[key])
        expiry = datetime.fromisoformat(value['expires_at'])
        if expiry.utcoffset() is None or not timezone.now() < expiry <= timezone.now() + timedelta(hours=1):
            raise ValueError()
        _board_binding(value.get('board_binding'), expiry)
        detail = value['detail_contract']
        if (type(detail) is not dict or set(detail) != {'reference', 'lifecycle_codes',
                'verdict_codes', 'executor_path', 'label_path', 'check_type', 'source_checks'}
                or not _reference(detail['reference'])
                or detail['executor_path'] != ['executor', 'id']
                or detail['label_path'] != ['remark']
                or type(detail['check_type']) is not int or detail['check_type'] not in {3, 4, 5}
                or type(detail['source_checks']) is not list or not 1 <= len(detail['source_checks']) <= 32):
            raise ValueError()
        states = detail['lifecycle_codes']
        if type(states) is not dict or set(states) != {'open', 'completed', 'approval_pending', 'cancelled', 'rejected'}:
            raise ValueError()
        all_codes = []
        for codes in states.values():
            if type(codes) is not list or len(codes) > 16 or any(type(code) is not int or not 0 <= code <= 10000 for code in codes):
                raise ValueError()
            all_codes.extend(codes)
        verdicts = detail['verdict_codes']
        if (not states['open'] or not states['completed'] or len(set(all_codes)) != len(all_codes)
                or type(verdicts) is not dict or set(verdicts) != {'pass', 'fail'}
                or any(type(code) is not int or not 0 <= code <= 10000 for code in verdicts.values())
                or len(set(verdicts.values())) != 2):
            raise ValueError()
        return InspectionProviderPolicy(value, digest(value), expiry)
    except Exception:
        raise MesContractUnavailable() from None


@dataclass
class _Response:
    status_code: int
    content: bytes


@sensitive_variables()
def _user_sender(url, *, params, data, headers, timeout, allow_redirects):
    """Use the documented access_token header, never a credential-bearing URL.

    An isolated requests session ignores environment proxy/netrc credentials and
    bounds streamed provider data before passing it to the scoped transport.
    """
    import requests
    if type(params) is not dict or set(params) != {'access_token'}:
        raise MesContractUnavailable()
    with requests.Session() as session:
        session.trust_env = False
        with session.post(url, data=data,
                headers={**headers, 'access_token': params['access_token'], 'Accept': 'application/json'},
                timeout=timeout, allow_redirects=False, stream=True) as response:
            if response.history:
                raise MesOutcomeUnknown()
            content = bytearray()
            for chunk in response.iter_content(8192):
                content.extend(chunk)
                if len(content) > 524288:
                    raise MesOutcomeUnknown()
            return _Response(response.status_code, bytes(content))


class LiveInspectionStageAdapter:
    def __init__(self, policy, *, user, session=None, sender=None, identity_provider=None):
        self.policy, self.user, self.session = policy, user, session
        self.sender = sender or _user_sender
        self.identity_provider = identity_provider
        self.enabled = bool(user and user.pk == policy.data['actor_id'] and policy.current())
        self._latest = None

    def binding_ready(self, binding, request):
        return self.enabled and self.policy.matches(binding) and str(request.pk) == self.policy.data['request_id']

    def _require(self, binding):
        if (not self.enabled or self.session is None or self.session.actor_id != self.policy.data['actor_id']
                or not self.policy.matches(binding)):
            raise MesContractUnavailable()

    def _call(self, binding, operation, callback):
        from mes_oauth import vault
        from mes_oauth.inspection_credentials import APP_CREDENTIAL, READ_AUTH, TEMPORARY, call_with_user_credential
        self._require(binding)
        try:
            return call_with_user_credential(self.session,
                mes_user_id=int(self.policy.data['mes_user_id']), tenant=self.policy.data['tenant'],
                contract_reference=self.policy.data['reference'],
                policy_check=lambda: self.policy.matches(binding), operation=operation,
                callback=callback, provider=self.identity_provider)
        except vault.VaultBlocked as error:
            if str(error) == APP_CREDENTIAL:
                raise InspectionAppCredentialUnavailable() from None
            if str(error) == TEMPORARY:
                raise InspectionIdentityUnavailable() from None
            # Only pre-dispatch credential failures allow reconnection to resume
            # the existing phase. Callback failures may follow a remote write.
            if str(error) in {'inspection_credential_unavailable', 'inspection_identity_recheck_failed', READ_AUTH}:
                raise InspectionConnectionRequired() from None
            raise MesOutcomeUnknown() from None

    def _transport(self, binding, token, stages=None):
        if type(token) is not InspectionUserAccessToken or token.user_id != int(self.policy.data['mes_user_id']):
            raise MesContractUnavailable()
        authorization = None if stages is None else ReviewedWriteAuthorization(
            binding.qc_id, stages_digest(stages), self.policy.data['authority_reference'])
        return BlacklakeInspectionTransport(binding.work_order_id, qc_task_id=binding.qc_id,
            origin=self.policy.data['origin'], token_provider=lambda: token, sender=self.sender,
            write_authorization=authorization)

    def read(self, binding):
        from .inspection_live_readback import decode_live_detail
        def perform(token):
            response = ScopedInspectionReadClient(self._transport(binding, token).post_json).detail(binding.qc_id)
            value = decode_live_detail(response, binding=binding,
                detail_contract=self.policy.data['detail_contract'], observed_at=timezone.now())
            self._latest = {'value': value, 'binding': binding_digest(binding), 'actor': token.user_id}
            return value
        return self._call(binding, 'read', perform)

    def _fresh_open(self, binding):
        latest = self._latest
        if (not latest or latest['binding'] != binding_digest(binding)
                or latest['actor'] != int(self.policy.data['mes_user_id'])
                or latest['value']['state'] != 'open'
                or not timedelta(0) <= timezone.now() - latest['value']['observed_at'] <= timedelta(seconds=60)):
            raise MesContractUnavailable()
        return latest['value']

    def board_observation(self, binding, observed, evidence_digest):
        """A verified single-QC observation, never whole-plan completeness."""
        self._require(binding)
        plan = self.policy.data.get('board_binding')
        if plan is None:
            return None
        checked = observed.get('completed_at')
        return {'schema': 'inspection-stage-observation.v1', 'identity': observed['identity'],
            'state': observed['state'], 'judgement': observed['inspectionResult'],
            'observed_at': observed['observed_at'].isoformat(),
            'checked_at': checked.isoformat() if checked is not None else None,
            'kind': {3: 'first', 4: 'production', 5: 'periodic'}[self.policy.data['detail_contract']['check_type']],
            'evidence_digest': evidence_digest, 'policy_fingerprint': self.policy.fingerprint,
            'plan_binding': dict(plan)}

    def _plan(self, binding):
        from .inspection_mes_stages import binding_contract
        request = binding.request
        records = binding_contract(binding, request)
        return result_and_finish_plan(binding.qc_id, records, verdict=request.judgement), records

    def save(self, binding, records, test_label, operation_id):
        self._require(binding)
        stages, expected = self._plan(binding)
        if records != expected or test_label != binding.test_label or type(operation_id) is not int:
            raise MesContractUnavailable()
        def perform(token):
            before = self._fresh_open(binding)
            if records_digest(before['records']) != self.policy.data['initial_records_digest']:
                raise MesContractUnavailable()
            self._latest = None
            return self._transport(binding, token, stages).send_reviewed_record(stages)
        return self._call(binding, 'save', perform)

    def finish_inspection(self, binding, verdict, operation_id):
        self._require(binding)
        stages, records = self._plan(binding)
        if verdict != binding.request.judgement or type(operation_id) is not int:
            raise MesContractUnavailable()
        def perform(token):
            before = self._fresh_open(binding)
            mapping = {(str(row['write_item_id']), row['group'], row['seq']): row for row in binding.contract['items']}
            expected = [{'config_row_id': str(mapping[(row['checkItemId'], row['groupName'], row['seq'])]['config_row_id']),
                'group': row['groupName'], 'seq': row['seq'], 'value': row['result']} for row in records]
            evidence_digest = records_digest(before['records'])
            if evidence_digest != records_digest(expected):
                raise MesContractUnavailable()
            authorization = ReviewedFinishAuthorization(binding.qc_id, stages_digest(stages),
                self.policy.data['authority_reference'], 'saved', int(self.policy.data['mes_user_id']),
                token.user_id, evidence_digest, before['observed_at'].timestamp())
            self._latest = None
            return self._transport(binding, token, stages).send_reviewed_finish(stages, authorization=authorization)
        return self._call(binding, 'finish', perform)
