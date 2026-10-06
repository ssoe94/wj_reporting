"""Scoped Blacklake HTTP boundary; live integration is separately gated.

Existing Render authentication is resolved only when an approved runtime caller
actually performs a request. Constructors/imports never inspect credentials.
Fixtures inject both the HTTP sender and token provider. Initial token resolution
uses the existing runtime helper, which may obtain a token. No request retry or
failure-triggered refresh, production control, inventory receipt or guessed endpoint.
The reviewed live stage adapter supplies only an explicit verified user token;
it never uses the legacy inventory-token default.
"""
import hashlib
import json
import math
import re
import time
from dataclasses import dataclass, field
from decimal import Decimal
from urllib.parse import urlsplit

from .inspection_adapter import MesContractUnavailable, MesOutcomeUnknown, MesRejected
from .inspection_blacklake_contract import (
    DocumentedStage, ITEM_RECORD, PLAN_BY_WORK_ORDER, ROUTE_BASE,
    TASK_DETAIL, TASK_FINISH, TASK_LIST, encode_payload, mes_id, result_and_finish_plan,
)


class MesAccessDenied(MesRejected):
    code = 'mes_access_denied'


class MesAuthenticationMissing(MesAccessDenied):
    code = 'mes_authentication_missing'


class MesAuthenticationExpired(MesAccessDenied):
    code = 'mes_authentication_expired'


class MesAuthenticationRejected(MesAccessDenied):
    # 401 does not, by itself, establish that a token expired.
    code = 'mes_authentication_rejected'


@dataclass(frozen=True)
class InspectionAccessToken:
    """Optional known expiry; never include credential bytes in repr/output."""
    value: str = field(repr=False)
    expires_at: float | None = None

    def __post_init__(self):
        if self.expires_at is not None and (
                type(self.expires_at) not in {int, float} or not math.isfinite(self.expires_at)):
            raise ValueError('Use a finite observed token expiry.')


@dataclass(frozen=True)
class InspectionUserAccessToken(InspectionAccessToken):
    """Caller-verified user credential; this object does not perform verification."""
    expires_at: float = field()
    user_id: int = field(kw_only=True)

    def __post_init__(self):
        super().__post_init__()
        if (self.expires_at is None or type(self.user_id) is not int
                or not 1 <= self.user_id <= 2**63 - 1):
            raise ValueError('A verified user identity and known expiry are required.')


def existing_runtime_token(origin):
    # Normal existing server authentication; never called by local fixture tests.
    from inventory.mes import MES_BASE_URL, get_access_token
    if MES_BASE_URL.rstrip('/') != origin:
        raise MesContractUnavailable()
    return get_access_token()


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON field.')
        result[key] = value
    return result


def _decode(text):
    return json.loads(text, parse_float=Decimal, object_pairs_hook=_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Nonfinite JSON.')))


def stages_digest(stages):
    return hashlib.sha256(encode_payload([
        {'endpoint': stage.endpoint, 'body': stage.json_body} for stage in stages
    ]).encode()).hexdigest()


@dataclass(frozen=True)
class ReviewedWriteAuthorization:
    """Explicit target/bytes review, not a substitute for runtime actor authority.

No API/setting creates this object. Only a future verified adapter or an approved
target test can provide it. Its digest binds exactly the reviewed two stages.
"""
    qc_task_id: str
    payload_digest: str
    verification_reference: str


@dataclass(frozen=True)
class ReviewedFinishAuthorization:
    """Adapter-attested saved readback, bound to the exact reviewed stages.

    The adapter must establish the source evidence and actual executor authority;
    a digest or user ID alone is not proof of either. ``observed_at`` is UTC Unix
    epoch seconds. The transport never creates this authorization from an ack.
    """
    qc_task_id: str
    payload_digest: str
    verification_reference: str
    phase: str
    actor_user_id: int
    credential_user_id: int
    source_evidence_digest: str
    observed_at: float

    def __post_init__(self):
        mes_id(self.qc_task_id)
        if (type(self.phase) is not str or self.phase != 'saved'
                or any(type(value) is not int or not 1 <= value <= 2**63 - 1
                       for value in (self.actor_user_id, self.credential_user_id))
                or self.actor_user_id != self.credential_user_id
                or any(type(value) is not str or re.fullmatch(r'[0-9a-f]{64}', value) is None
                       for value in (self.payload_digest, self.source_evidence_digest))
                or type(self.verification_reference) is not str
                or not self.verification_reference.strip() or len(self.verification_reference) > 500
                or type(self.observed_at) not in (int, float)
                or not math.isfinite(self.observed_at)):
            raise ValueError('A reviewed saved readback and matching user authority are required.')


@dataclass(frozen=True)
class InspectionWriteAcknowledgement:
    accepted_stages: int
    completion_confirmed: bool = False

    @property
    def readback_required(self):
        return not self.completion_confirmed


class BlacklakeInspectionTransport:
    def __init__(self, work_order_id, *, qc_task_id=None, origin='https://v3-ali.blacklake.cn',
                 token_provider=None, sender=None, write_authorization=None, eligibility_user_id=None,
                 standalone_test=False):
        if type(standalone_test) is not bool or (standalone_test and (work_order_id is not None or qc_task_id is None)):
            raise ValueError('Standalone transport requires one QC and no production work order.')
        self._standalone_test = standalone_test
        self.work_order_id = None if standalone_test else mes_id(work_order_id)
        self.qc_task_id = mes_id(qc_task_id) if qc_task_id is not None else None
        self._eligibility_user_id = mes_id(eligibility_user_id) if eligibility_user_id is not None else None
        if self._eligibility_user_id is not None and (self.qc_task_id is None or write_authorization is not None):
            raise ValueError('Eligibility comparison requires one QC and a read-only transport.')
        parsed = urlsplit(origin)
        if (parsed.scheme != 'https' or parsed.netloc not in {'v3-ali.blacklake.cn', 'v3-hw.blacklake.cn'}
                or parsed.path not in {'', '/'} or parsed.query or parsed.fragment):
            raise ValueError('Use a reviewed Blacklake origin.')
        self.origin = origin.rstrip('/')
        self._explicit_token_provider = callable(token_provider)
        self._token_provider = token_provider if token_provider is not None else lambda: existing_runtime_token(self.origin)
        self._sender = sender
        self._write_authorization = write_authorization
        self._write_attempted = False
        self._finish_attempted = False

    def _read_body(self, route, text):
        if self._standalone_test and route != ROUTE_BASE + TASK_DETAIL:
            raise ValueError('Standalone trials only read their exact QC detail.')
        if self._eligibility_user_id is not None and route != ROUTE_BASE + TASK_DETAIL:
            raise ValueError('Eligibility comparison only reads the bound QC detail.')
        if not isinstance(text, str) or len(text.encode()) > 131072:
            raise ValueError('Request body is out of bounds.')
        body = _decode(text)
        if not isinstance(body, dict):
            raise ValueError('Use an explicit scoped object.')
        if route == ROUTE_BASE + TASK_LIST:
            if (set(body) != {'workOrderIds', 'checkType', 'page', 'size'}
                    or not isinstance(body['workOrderIds'], list) or len(body['workOrderIds']) != 1
                    or type(body['workOrderIds'][0]) is not int
                    or body['workOrderIds'] != [self.work_order_id]
                    or type(body['checkType']) is not int or body['checkType'] not in {3, 4, 5}
                    or type(body['page']) is not int or not 1 <= body['page'] <= 2
                    or type(body['size']) is not int or not 1 <= body['size'] <= 25):
                raise ValueError('Read only one work order in two bounded pages.')
        elif route == ROUTE_BASE + TASK_DETAIL:
            keys = {'id', 'receiveUserId'} if 'receiveUserId' in body else {'id'}
            if (set(body) != keys or type(body.get('id')) is not int or body['id'] != self.qc_task_id
                    or ('receiveUserId' in body and (self._eligibility_user_id is None
                        or type(body['receiveUserId']) is not int
                        or body['receiveUserId'] != self._eligibility_user_id))):
                raise ValueError('Detail must match the explicitly selected QC task.')
        elif route == ROUTE_BASE + PLAN_BY_WORK_ORDER:
            if (set(body) != {'workOrderId', 'checkType'} or type(body['workOrderId']) is not int
                    or body['workOrderId'] != self.work_order_id
                    or type(body['checkType']) is not int or body['checkType'] not in {3, 4, 5}):
                raise ValueError('Plan must match the explicitly selected work order.')
        else:
            raise ValueError('Unsupported inspection read route.')

    def _post(self, route, text, *, stage, finish_authorization=None):
        try:
            if stage == 'finish':
                if (not self._explicit_token_provider
                        or type(finish_authorization) is not ReviewedFinishAuthorization):
                    raise MesContractUnavailable()
                self._check_finish_freshness(finish_authorization)
            token = self._token_provider()
            if stage == 'finish':
                if (type(token) is not InspectionUserAccessToken
                        or token.user_id != finish_authorization.actor_user_id
                        or token.user_id != finish_authorization.credential_user_id):
                    raise MesAuthenticationRejected()
                # Token resolution can take time. Recheck the readback immediately
                # before using this same credential; never resolve a second token.
                self._check_finish_freshness(finish_authorization)
            if isinstance(token, InspectionAccessToken):
                if token.expires_at is not None and token.expires_at <= time.time():
                    raise MesAuthenticationExpired()
                token = token.value
            if not isinstance(token, str) or not token.strip():
                raise MesAuthenticationMissing()
            if self._sender is None:
                import requests
                sender = requests.post
            else:
                sender = self._sender
            response = sender(self.origin + route, params={'access_token': token},
                              data=text.encode('utf-8'), headers={'Content-Type': 'application/json'},
                              timeout=(5, 20), allow_redirects=False)
            status = response.status_code
            if status == 401:
                raise MesAuthenticationRejected()
            if status == 403:
                raise MesAccessDenied()
            if status == 202 or status >= 500 or 300 <= status < 400:
                raise MesOutcomeUnknown()
            if status not in {200, 201}:
                raise MesRejected()
            content = response.content
            if not isinstance(content, bytes) or not content or len(content) > 524288:
                raise MesOutcomeUnknown()
            body = _decode(content.decode('utf-8'))
            if not isinstance(body, dict) or type(body.get('code')) is not int:
                raise MesOutcomeUnknown()
            if body['code'] == 401:
                raise MesAuthenticationRejected()
            if body['code'] == 403:
                raise MesAccessDenied()
            if body['code'] != 200:
                raise MesRejected()
            # Documented needCheck=1 requires human confirmations. No automatic
            # confirmation/weak-control bypass or follow-up write is permitted.
            # The scoped actual detail read on 2026-10-03 returned null.
            # This evidence applies to reads only; write confirmations remain strict.
            read_without_confirmation = stage == 'read' and body.get('needCheck') is None
            if ('needCheck' in body and not read_without_confirmation
                    and (type(body['needCheck']) is not int or body['needCheck'] != 0)):
                raise MesOutcomeUnknown()
            if stage == 'read' and not isinstance(body.get('data'), (dict, list)):
                raise MesOutcomeUnknown()
            if stage == 'record' and body.get('data') is not True:
                # The public record example is code=200,data=false. A transport
                # acknowledgement alone cannot justify proceeding to finish.
                raise MesOutcomeUnknown()
            if stage == 'finish':
                # Finish has no documented business data contract. Even an
                # accepted envelope requires a fresh detail reconciliation.
                return {'code': 200}
            # No raw message/request URL/exception is returned or logged.
            return {'code': 200, 'data': body['data']}
        except (MesAccessDenied, MesRejected, MesOutcomeUnknown, MesContractUnavailable):
            raise
        except Exception:
            raise MesOutcomeUnknown() from None

    def post_json(self, route, exact_json_text):
        self._read_body(route, exact_json_text)
        return self._post(route, exact_json_text, stage='read')

    def _validate_write_bodies(self, stages):
        bodies = []
        for stage, key in zip(stages, ('taskId', 'id')):
            if not isinstance(stage.json_body, str) or len(stage.json_body.encode()) > 131072:
                raise ValueError('Reviewed stage is out of bounds.')
            body = _decode(stage.json_body)
            if not isinstance(body, dict) or type(body.get(key)) is not int or body[key] != self.qc_task_id:
                raise ValueError('Stage task differs from reviewed QC identity.')
            bodies.append(body)
        record, finish = bodies
        if (set(record) != {'taskId', 'checkItems'} or set(finish) != {'id', 'status'}
                or type(finish['status']) is not int or finish['status'] not in {1, 2, 3, 4}
                or not isinstance(record['checkItems'], list)):
            raise ValueError('Only documented record and explicit QC conclusion fields are allowed.')
        items = []
        for item in record['checkItems']:
            if not isinstance(item, dict):
                raise ValueError('Use explicit reviewed record objects.')
            normalized = dict(item)
            for bound in ('min', 'max'):
                if bound in normalized:
                    if type(normalized[bound]) not in {int, Decimal}:
                        raise ValueError('Use exact numeric bounds.')
                    normalized[bound] = Decimal(normalized[bound])
            items.append(normalized)
        verdict = {1: 'pass', 2: 'concession', 3: 'pending', 4: 'fail'}[finish['status']]
        compiled = result_and_finish_plan(self.qc_task_id, items, verdict=verdict)
        if [_decode(stage.json_body) for stage in compiled] != bodies:
            raise ValueError('Reviewed bytes must follow the documented record-only contract.')

    def send_reviewed_stages(self, stages):
        """Combined save/finish is unavailable until durable readback is reviewed.

        A reviewed request digest and data=true acknowledge neither persisted
        values nor a permanent test label. Never finish from that acknowledgement.
        Existing callers fail before authentication or any item write.
        """
        raise MesContractUnavailable()

    def send_reviewed_record(self, stages):
        """Send only the reviewed item stage, once per transport instance.

        The paired finish bytes remain part of the reviewed intent, but are
        never sent here. A future durable coordinator must independently verify
        fresh scoped values and the source test label before enabling finish.
        This process-local fence does not provide crash-safe idempotency.
        """
        authorization = self._write_authorization
        if authorization is None or self._eligibility_user_id is not None:
            raise MesContractUnavailable()
        if (not isinstance(authorization, ReviewedWriteAuthorization)
                or not isinstance(authorization.verification_reference, str)
                or not authorization.verification_reference.strip()
                or len(authorization.verification_reference) > 500
                or not isinstance(stages, (list, tuple)) or len(stages) != 2
                or any(not isinstance(stage, DocumentedStage) for stage in stages)
                or [stage.endpoint for stage in stages] != [ITEM_RECORD, TASK_FINISH]
                or authorization.payload_digest != stages_digest(stages)
                or mes_id(authorization.qc_task_id) != self.qc_task_id):
            raise ValueError('Target and exact record/finish bytes must be reviewed.')
        self._validate_write_bodies(stages)
        if self._write_attempted:
            # This process-local fence complements the existing durable outbox;
            # it does not claim that MES implements an idempotency key.
            raise MesOutcomeUnknown()
        self._write_attempted = True
        stage = stages[0]
        self._post(ROUTE_BASE + stage.endpoint, stage.json_body, stage='record')
        # An acknowledgement proves neither saved values nor QC completion.
        return InspectionWriteAcknowledgement(accepted_stages=1)

    @staticmethod
    def _check_finish_freshness(authorization):
        now = time.time()
        if (type(now) not in (int, float) or not math.isfinite(now)
                or not 0 <= now - authorization.observed_at <= 60):
            raise MesContractUnavailable()

    def send_reviewed_finish(self, stages, *, authorization):
        """Send the individual finish once after adapter-verified saved readback.

        Requires an explicit, user-bound credential provider. The independent
        process-local guard is not durable idempotency. Acceptance is only an
        acknowledgement: the adapter must obtain a fresh exact-target detail
        readback and verify the final lifecycle/verdict before reporting success.
        """
        if (self._eligibility_user_id is not None or not self._explicit_token_provider
                or type(authorization) is not ReviewedFinishAuthorization):
            raise MesContractUnavailable()
        authorization.__post_init__()
        if (not isinstance(stages, (list, tuple)) or len(stages) != 2
                or any(type(stage) is not DocumentedStage for stage in stages)
                or [stage.endpoint for stage in stages] != [ITEM_RECORD, TASK_FINISH]
                or authorization.payload_digest != stages_digest(stages)
                or mes_id(authorization.qc_task_id) != self.qc_task_id):
            raise ValueError('Target and exact record/finish bytes must match the saved readback review.')
        self._validate_write_bodies(stages)
        self._check_finish_freshness(authorization)
        if self._finish_attempted:
            raise MesOutcomeUnknown()
        self._finish_attempted = True
        stage = stages[1]
        self._post(ROUTE_BASE + stage.endpoint, stage.json_body, stage='finish',
                   finish_authorization=authorization)
        return InspectionWriteAcknowledgement(accepted_stages=1)
