"""Read-only comparison of saved injection-plan SPEC values and MES masters.

Candidates are display suggestions, never update instructions. No master, plan,
approval or mapping is written here, and missing provider rows are not blanks.
"""
from datetime import date

from django.utils import timezone
from rest_framework.exceptions import ValidationError

from .mes_execution_contract import mes_id
from .plan_bom import BomReader, MATERIAL_LIST, _read

MAX_PARTS = 500
BATCH_SIZE = 100

# Exact one-time user decisions from 2026-10-10; these are not SPEC rules.
# Evidence: output/mes-metadata-20261010/master-blank-fill-report.md and
# output/mes-m2-comparison-20261010/excel-and-work-order-review.md.
CONFIRMED_CATEGORIES = {
    'ACQ30776301': ('CAT-010', '后盖Assy', '成品 / 后盖Assy'),
    'ACQ30854202': ('CAT-000', '后盖板', '半成品 / 后盖板'),
    'ACQ30854207': ('CAT-010', '后盖Assy', '成品 / 后盖Assy'),
    'MAM66002511': ('CAT-137', 'base', '半成品 / base'),
}


def _text(value):
    if value is None:
        return ''
    if not isinstance(value, str):
        raise ValidationError('mes_master_text_invalid')
    return value.strip()


def _source(plan):
    if (plan.plan_type != 'injection' or type(plan.pk) is not int or plan.pk < 1
            or not isinstance(plan.plan_date, date)):
        raise ValidationError('mes_master_saved_injection_plans_required')
    return {'plan_id': plan.pk, 'uid': str(plan.work_uid) if plan.work_uid else None,
        'version': plan.work_version, 'plan_date': plan.plan_date.isoformat(),
        'machine_name': plan.machine_name, 'lot_no': plan.lot_no,
        'model_name': plan.model_name, 'part_spec': plan.part_spec}


def _row(code, sources):
    specs = sorted({_text(source['part_spec']) for source in sources} - {''})
    confirmed = CONFIRMED_CATEGORIES.get(code)
    return {'part_no': code, 'sources': sources, 'source_specs': specs,
        'source_spec_conflict': len(specs) > 1,
        'status': 'unknown', 'issue': 'material_not_returned', 'mes': None,
        'spec_state': 'unknown', 'spec_candidate': None,
        'category_state': 'unknown', 'category_candidate': None,
        'confirmed_category': ({'code': confirmed[0], 'name': confirmed[1], 'path': confirmed[2],
            'source': 'user_confirmed_2026-10-10'} if confirmed else None)}


def _master(item):
    base = item['baseInfo']
    try:
        identity = str(mes_id(base.get('id')))
    except (TypeError, ValueError):
        return None, 'material_identity_invalid'
    # Absent fields can mean a partial response; explicit null is a known blank.
    if 'specification' not in base or 'category' not in item:
        return None, 'material_fields_missing'
    spec = base['specification']
    if spec is not None and not isinstance(spec, str):
        return None, 'material_fields_invalid'
    category = item['category']
    if category is not None:
        if (not isinstance(category, dict) or not isinstance(category.get('code'), str)
                or not category['code'].strip() or not isinstance(category.get('name'), str)
                or not category['name'].strip()):
            return None, 'material_fields_invalid'
        category = {'code': category['code'], 'name': category['name']}
    elif item.get('categoryAllLevel') is not None:
        return None, 'material_category_inconsistent'
    return {'material_id': identity, 'specification': spec, 'category': category}, None


def _compare(row, master):
    row.update(status='ok', issue=None, mes=master)
    if _text(master['specification']):
        row['spec_state'] = 'existing'
    elif row['source_spec_conflict']:
        row['spec_state'] = 'source_conflict'
    elif row['source_specs']:
        row['spec_state'] = 'blank_candidate'
        row['spec_candidate'] = row['source_specs'][0]
    else:
        row['spec_state'] = 'source_missing'
    if master['category'] is not None:
        row['category_state'] = 'existing'
    elif row['confirmed_category']:
        row['category_state'] = 'blank_confirmed'
        row['category_candidate'] = dict(row['confirmed_category'])
    else:
        row['category_state'] = 'decision_required'


def read_master_gaps(plans, actor_id, reader=None):
    """Return bounded read evidence for a caller-authorized saved-plan scope.

    The caller enforces view permissions and selects the scope from the database.
    Provider/permission exceptions propagate: no failed read becomes an empty list.
    """
    if type(actor_id) is not int or actor_id < 1:
        raise ValidationError('mes_master_actor_required')
    grouped = {}
    for plan in plans:
        source = _source(plan)
        code = _text(plan.part_no)
        grouped.setdefault(code, []).append(source)
        if len(grouped) - ('' in grouped) > MAX_PARTS:
            raise ValidationError('mes_master_part_limit')
    rows = {code: _row(code, grouped[code]) for code in sorted(grouped)}
    if '' in rows:
        rows['']['issue'] = 'plan_part_missing'
    codes = [code for code in rows if code]
    if codes:
        reader = reader if reader is not None else BomReader(actor_id)
    for start in range(0, len(codes), BATCH_SIZE):
        batch = codes[start:start + BATCH_SIZE]
        data = _read(reader, MATERIAL_LIST, {'codes': batch, 'queryFieldList': [1, 4]})
        if not isinstance(data, list):
            raise ValidationError('mes_master_response_shape')
        indexed, issue = {}, None
        for item in data:
            base = item.get('baseInfo') if isinstance(item, dict) else None
            code = base.get('code') if isinstance(base, dict) else None
            if not isinstance(code, str) or code not in batch:
                issue = 'unexpected_material_code'
                break
            if code in indexed:
                issue = 'duplicate_material_code'
                break
            indexed[code] = item
        if issue:
            for code in batch:
                rows[code]['issue'] = issue
            continue
        masters = {code: _master(item) for code, item in indexed.items()}
        identities = [master['material_id'] for master, _ in masters.values() if master]
        if len(identities) != len(set(identities)):
            for code in batch:
                rows[code]['issue'] = 'duplicate_material_id'
            continue
        for code, (master, issue) in masters.items():
            if issue:
                rows[code]['issue'] = issue
            else:
                _compare(rows[code], master)
    return {'checked_at': timezone.now().isoformat(), 'rows': list(rows.values())}
