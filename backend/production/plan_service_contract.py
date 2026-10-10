"""Factory import from the approved plan/material snapshot.

Import fields: official Blacklake HW document 1686645473258363. Inline materials
use useBomFlag=0 by the factory's selected policy; tenant precedence still needs
the separately approved live trial. No per-product server allowlist is used.
"""
from datetime import datetime
from decimal import Decimal

from .mes_execution_contract import encode_exact_json
from .plan_workflow_contract import CREATE_PATH, UPDATE_PATH

INITIAL_STATUS = 1  # CREATED; dispatch/start are separate later operations.
REPORT_FLAG = 1


def build_contract(order, intent):
    if Decimal(intent['quantity']) <= 0:
        return {}, ['positive_plan_quantity_required']
    start = int(datetime.fromisoformat(intent['planned_start']).timestamp() * 1000)
    end = int(datetime.fromisoformat(intent['planned_end']).timestamp() * 1000)
    if order.mes_id:
        return {'path': UPDATE_PATH, 'payload': {'workOrderUpdatePlanTimeList': [{
            'code': order.code, 'plannedAmount': intent['quantity'], 'planFinishTime': end}]}}, [
                'task_quantity_propagation_and_allowed_state_review']
    setup = intent['setup']
    payload = {'code': order.code, 'externalOrderCode': order.code, 'identifier': order.code,
        'planStartTime': start, 'planFinishTime': end, 'resourceCode': setup['resource_code'],
        'enableSop': 0, 'specifiedMaterial': 1, 'useBomFlag': 0, 'useProcessRouteFlag': 1,
        'status': INITIAL_STATUS,
        'inputMaterialOpenV2COs': [{'seq': str(index + 1), 'materialCode': row['material_code'],
            **({'version': row['material_version']} if row['material_version'] else {}),
            'unitName': row['unit_name'],
            'subInputAmountNumerator': row['numerator'], 'subInputAmountDenominator': row['denominator'],
            'specificProcessInput': 1, 'inputProcessNum': setup['process_num'],
            'splitSopControlInput': 0, 'lossRate': '0'} for index, row in enumerate(setup['inputs'])],
        'outputMaterialOpenCOs': [{'lineSeq': '0', 'mainFlag': 1, 'materialCode': intent['part_no'],
            'plannedAmount': intent['quantity'], 'unitName': setup['output_unit_name'],
            **({'version': setup['output_version']} if setup['output_version'] else {}),
            'outputProcessCode': setup['process_num'],
            'processRouteCode': setup['route_code']}],
        'processPlanOpenCOs': [{'code': setup['process_code'], 'processNum': setup['process_num'],
                               'reportFlag': REPORT_FLAG}]}
    encode_exact_json(payload)
    return {'path': CREATE_PATH, 'payload': payload, 'document_id': '1686645473258363',
            'authentication': 'service_app', 'readback_scope': 'base_creation'}, []
