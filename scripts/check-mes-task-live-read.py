"""Read-only MES integration probe with existing process credentials.

Uses the bounded list and task-detail endpoints only. Never loads .env files,
connects a database/preview, or submits task actions. Exit 0 means these read
checks passed; 2 means blocked/incomplete. Does not prove action grants, plan
matching, writes, closure, or inspection scheduling.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import sys
from zoneinfo import ZoneInfo


def run(sample_count: int) -> dict:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
    import decouple
    decouple.config = decouple.Config(decouple.RepositoryEmpty())
    from django.conf import settings
    settings.configure(
        CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}},
        USE_TZ=True, MES_TASK_ACTIONS_ENABLED=False,
    )
    from inventory import mes
    from production.mes_task_actions import DETAIL_PATH, _mismatch, parse_items
    from production.mes_progress import extract_machine_number, normalize_mes_part_no
    from production.mes_task_reader import fetch_task_page, normalize_tasks, read_task_pages

    evidence = {
        'checked_at': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
        'read_only': True, 'write_calls': 0, 'ready': False,
        'configured_app': bool(mes.APP_KEY and mes.APP_SECRET),
        'configured_token': bool(mes.ACCESS_TOKEN_ENV),
        'list_limit': 500, 'detail_samples': [],
    }
    if not (evidence['configured_app'] or evidence['configured_token']):
        evidence['blocker'] = 'existing_process_credentials_missing'
        return evidence
    rows, complete, warnings = read_task_pages(fetch_task_page)
    tasks, identities = normalize_tasks(rows, normalize_mes_part_no, extract_machine_number)
    evidence.update({
        'list_rows': len(rows), 'list_complete': complete,
        'warnings': warnings, 'identity_complete': identities,
        'injection_tasks': len(tasks),
        'mapped_tasks': sum(task['machine_number'] is not None for task in tasks),
        'machine_counts': dict(Counter(str(task['machine_number']) for task in tasks)),
        'status_counts': dict(Counter(str(task['status']) for task in tasks)),
    })
    # A real list response may omit equipment entirely. Still probe a bounded
    # sample of details to distinguish missing detail grants from mapping gaps.
    if evidence['mapped_tasks'] != len(tasks):
        evidence['warnings'] = warnings + ['equipment_assignment_incomplete']
    candidates = [task for task in tasks if task['identity_complete']]
    candidates.sort(key=lambda task: task['actual_start'] or '9999')
    for task in candidates[:sample_count]:
        sample = {key: task[key] for key in (
            'task_id', 'task_code', 'work_order_code', 'part_no',
            'machine_number', 'status', 'actual_start',
        )}
        sample['matches'] = False
        try:
            response = mes.requests.post(
                f'{mes.MES_BASE_URL}{mes.MES_ROUTE_BASE}{DETAIL_PATH}',
                params={'access_token': mes.get_access_token()},
                json={'taskId': int(task['task_id'])}, timeout=(3, 10),
            )
            sample['http_status'] = response.status_code
            response.raise_for_status()
            payload = response.json()
            detail = payload.get('data') if isinstance(payload, dict) else None
            if isinstance(payload, dict) and type(payload.get('code')) is int:
                sample['mes_code'] = payload['code']
            if isinstance(payload, dict) and isinstance(payload.get('subCode'), str):
                sample['mes_sub_code'] = payload['subCode']
            if sample.get('mes_code') == 200 and isinstance(detail, dict):
                if task['machine_number'] is None:
                    sample['mismatch'] = 'equipment_unmapped'
                else:
                    items, _ = parse_items({'reason': 'read-only contract validation', 'items': [{
                        **task, 'expected_status': task['status'],
                        'action': {1: 'start', 2: 'pause', 3: 'resume'}[task['status']],
                    }]})
                    sample['mismatch'] = _mismatch(items[0], detail)
                sample['matches'] = sample['mismatch'] is None and bool(task['work_order_code'])
            else:
                sample['blocker'] = 'detail_read_failed'
        except Exception as error:
            sample['blocker'] = 'detail_read_failed'
            sample['error_type'] = type(error).__name__
        evidence['detail_samples'].append(sample)
    evidence['ready'] = bool(
        complete and identities and tasks
        and evidence['mapped_tasks'] == len(tasks)
        and evidence['detail_samples']
        and all(sample['matches'] for sample in evidence['detail_samples'])
    )
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--samples', type=int, choices=range(1, 11), default=3)
    parser.add_argument('--output', type=Path, help='Save whitelisted JSON evidence locally.')
    args = parser.parse_args()
    try:
        result = run(args.samples)
    except Exception as error:
        result = {'read_only': True, 'write_calls': 0, 'ready': False,
                  'blocker': 'probe_failed', 'error_type': type(error).__name__}
    text = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print(text, end='')
    raise SystemExit(0 if result['ready'] else 2)
