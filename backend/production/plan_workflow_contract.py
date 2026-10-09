"""Pure v2 preparation contract, verified against Blacklake docs 2026-10-08.

1686655055663528: import; 1686655055663530: qty/finish base edit.
Tenant initial status/reportFlag/manual-warehousing values have no documented
meaning in v2 examples. Explicit reviewed server configuration is mandatory.
No transport, credentials, dispatch, inspection, auto start or close lives here.
"""
from datetime import datetime
from decimal import Decimal
from django.conf import settings
from .mes_execution_contract import encode_exact_json
from .plan_workflow_read_contract import reviewed_binding

CREATE_PATH = '/med/open/v2/work_order/_doimport'
UPDATE_PATH = '/med/open/v2/work_order/_update_work_order_base_info'


def build_contract(order, intent):
    if Decimal(intent['quantity']) <= 0:
        return {}, ['positive_plan_quantity_required']
    review = getattr(settings, 'MES_PLAN_REVIEWED_CONTRACT', None)
    required = {'reference', 'initial_status', 'report_flag', 'manual_warehousing', 'no_auto_warehousing'}
    if (not isinstance(review, dict) or not required.issubset(review)
            or not isinstance(review['reference'], str) or not review['reference']
            or type(review['initial_status']) is not int or type(review['report_flag']) is not int
            or any(not isinstance(review[key], str) or not review[key] for key in
                   ('manual_warehousing', 'no_auto_warehousing'))):
        return {}, ['tenant_contract_review_required']
    # A global enum review does not verify every product/machine/BOM mapping.
    if intent['setup_fingerprint'] not in review.get('setup_fingerprints', []):
        return {}, ['product_resource_bom_mapping_review_required']
    start = int(datetime.fromisoformat(intent['planned_start']).timestamp() * 1000)
    end = int(datetime.fromisoformat(intent['planned_end']).timestamp() * 1000)
    if order.mes_id:
        payload = {'workOrderUpdatePlanTimeList': [{'code': order.code,
                   'plannedAmount': intent['quantity'], 'planFinishTime': end}]}
        contract = {'path': UPDATE_PATH, 'payload': payload, 'document_id': '1686655055663530'}
        # No general guarantee that downstream task quantities follow a base edit.
        return contract, ['task_quantity_propagation_and_allowed_state_review']
    setup = intent['setup']
    try:
        binding, fields = reviewed_binding(review, intent)
    except (ValueError, TypeError, KeyError):
        return {}, ['tenant_readback_mapping_required']
    except Exception:
        # Includes DRF validation errors from exact IDs/text: fail closed.
        return {}, ['tenant_readback_mapping_required']
    payload = {'code': order.code, 'externalOrderCode': order.code, 'identifier': order.code,
        'customFields': fields,
        'planStartTime': start, 'planFinishTime': end, 'resourceCode': setup['resource_code'],
        'enableSop': 0, 'specifiedMaterial': 1, 'useBomFlag': 1, 'useProcessRouteFlag': 1,
        'status': review['initial_status'],
        'inputMaterialOpenV2COs': [{'seq': str(i + 1), 'materialCode': row['material_code'],
            'version': row['material_version'], 'unitName': row['unit_name'],
            'subInputAmountNumerator': row['numerator'], 'subInputAmountDenominator': row['denominator'],
            'specificProcessInput': 1, 'inputProcessNum': setup['process_num'], 'splitSopControlInput': 0, 'lossRate': '0'}
            for i, row in enumerate(setup['inputs'])],
        'outputMaterialOpenCOs': [{'lineSeq': '0', 'mainFlag': 1, 'materialCode': intent['part_no'],
            'plannedAmount': intent['quantity'], 'unitName': setup['output_unit_name'],
            'version': setup['output_version'], 'outputProcessCode': setup['process_num'],
            'processRouteCode': setup['route_code'], 'autoWarehousingFlag': review['no_auto_warehousing'],
            'warehousing': review['manual_warehousing']}],
        'processPlanOpenCOs': [{'code': setup['process_code'], 'processNum': setup['process_num'],
                               'reportFlag': review['report_flag']}],
    }
    encode_exact_json(payload)
    return {'path': CREATE_PATH, 'payload': payload, 'document_id': '1686655055663528', 'tenant': review['tenant'],
            'readback_binding': binding,
            'review_reference': review['reference']}, []
