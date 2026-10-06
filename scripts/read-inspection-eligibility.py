"""Approved server-shell probe: one app-token issuance, at most two detail reads.

Importing this module performs no I/O. The operator must provide an explicitly
approved QC/user pair and the existing server's inventory.mes module. No user
token exchange, claim, result save, finish, retry or raw-response output exists.
Keep real target IDs and observations outside this public repository.
"""
from datetime import datetime, timezone
import json
import math
import time


DETAIL_PATH = '/api/openapi/domain/web/v1/route/quality/open/v1/task/_detail'
APP_TOKEN_PATH = '/api/openapi/domain/api/v1/access_token/_get_access_token'
ORIGINS = {'https://v3-ali.blacklake.cn', 'https://v3-hw.blacklake.cn'}


def _id(value):
    return type(value) is int and 0 < value <= 2**63 - 1


def _enum(value):
    value = value.get('code') if isinstance(value, dict) else value
    return value if type(value) is int else None


def _ids(value):
    if not isinstance(value, list):
        return {'count': None, 'ids': []}
    return {'count': len(value), 'ids': [item['id'] for item in value[:25]
            if isinstance(item, dict) and _id(item.get('id'))]}


def _field_permission(value):
    if value is None or value == {}:
        return value
    if not isinstance(value, dict):
        return {'shape': 'unknown'}
    result = {'encoding_present': bool(value.get('encoding'))}
    allowed = {'id', 'getAble', 'getStatus', 'status', 'executor', 'candidates', 'candidateDeps'}
    for name in ('noAccess', 'readonly'):
        fields = value.get(name)
        result[name + '_count'] = len(fields) if isinstance(fields, list) else None
        result[name + '_known_fields'] = [field for field in fields[:50]
            if isinstance(field, str) and field in allowed] if isinstance(fields, list) else []
    return result


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON field.')
        result[key] = value
    return result


def _nonfinite(value):
    raise ValueError('Nonfinite JSON value.')


def run_comparison(qc_task_id, eligibility_user_id, *, origin, runtime, post, now=time.time):
    """Issue once through the existing app helper; stop on any uncertain result.

receiveUserId selects the eligibility subject. Neither getAble nor an app token
proves authenticated user identity or write authority. Token bytes remain in
memory and are never included in the returned, allowlisted observation.
"""
    if (not _id(qc_task_id) or not _id(eligibility_user_id) or origin not in ORIGINS
            or runtime.MES_BASE_URL.rstrip('/') != origin
            or runtime.APP_TOKEN_ENDPOINT != APP_TOKEN_PATH):
        raise ValueError('Use the approved target and existing app-token origin.')
    report = {
        'observed_at': datetime.fromtimestamp(now(), timezone.utc).isoformat(),
        'qc_task_id': qc_task_id, 'query_user_id': eligibility_user_id,
        'authenticated_user': 'unverified', 'write_authority': 'unverified',
        'issuance': 'not_attempted', 'observations': [],
    }
    try:
        token = runtime.fetch_app_token()
    except Exception:
        report['issuance'] = 'failed_or_uncertain_no_retry'
        return report
    if not isinstance(token, str) or not token.strip():
        report['issuance'] = 'token_missing_no_retry'
        return report
    report['issuance'] = 'app_token_received'
    try:
        expires_at = runtime.cache.get(runtime.TOKEN_EXPIRES_KEY)
    except Exception:
        report['issuance'] = 'expiry_unavailable_no_retry'
        return report
    if type(expires_at) not in {int, float} or not math.isfinite(expires_at):
        report['issuance'] = 'expiry_unavailable_no_retry'
        return report
    for subject in (None, eligibility_user_id):
        row = {'subject': 'default_current' if subject is None else 'explicit_user',
               'receiveUserId': subject}
        report['observations'].append(row)
        if expires_at <= now():
            row['outcome'] = 'token_expired_no_retry'
            break
        payload = {'id': qc_task_id}
        if subject is not None:
            payload['receiveUserId'] = subject
        try:
            response = post(origin + DETAIL_PATH, params={'access_token': token},
                data=json.dumps(payload, separators=(',', ':')).encode('utf-8'),
                headers={'Content-Type': 'application/json'}, timeout=(5, 20), allow_redirects=False)
            status = response.status_code
            row['http_status'] = status if type(status) is int else None
            if status in (401, 403):
                row['outcome'] = 'authentication_rejected' if status == 401 else 'access_denied'
                break
            content = response.content
            if status != 200 or not isinstance(content, bytes) or not content or len(content) > 524288:
                row['outcome'] = 'response_unknown_no_retry'
                break
            body = json.loads(content, object_pairs_hook=_object, parse_constant=_nonfinite)
            if not isinstance(body, dict) or type(body.get('code')) is not int:
                row['outcome'] = 'response_unknown_no_retry'
                break
            row['api_code'] = body['code']
            if body['code'] != 200:
                row['outcome'] = {401: 'authentication_rejected', 403: 'access_denied'}.get(
                    body['code'], 'api_rejected_no_retry')
                break
            need_check = body.get('needCheck')
            row['needCheck'] = need_check if need_check is None or type(need_check) is int else 'unknown'
            row['fieldPermission'] = _field_permission(body.get('fieldPermission'))
            data = body.get('data')
            if not isinstance(data, dict) or not _id(data.get('id')) or data['id'] != qc_task_id:
                row['outcome'] = 'target_unverified_no_retry'
                break
            if type(data.get('getAble')) is not int or data['getAble'] not in (0, 1):
                row['outcome'] = 'eligibility_unverified_no_retry'
                break
            row['getAble'] = data['getAble']
            row['status'] = _enum(data.get('status'))
            row['getStatus'] = _enum(data.get('getStatus'))
            executor = data.get('executor')
            row['executor_id'] = executor['id'] if isinstance(executor, dict) and _id(executor.get('id')) else None
            row['candidates'] = _ids(data.get('candidates'))
            row['candidateDeps'] = _ids(data.get('candidateDeps'))
            if need_check is not None and (type(need_check) is not int or need_check != 0):
                row['outcome'] = 'confirmation_unverified_no_retry'
                break
            row['outcome'] = 'observed_not_authorized'
        except Exception:
            row['outcome'] = 'response_unknown_no_retry'
            break
    return report
