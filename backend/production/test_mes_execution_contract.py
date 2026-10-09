"""Synthetic exact-value boundaries; this suite performs no I/O or MES writes."""
from dataclasses import replace
from decimal import Decimal
import copy
import unittest

from production.mes_execution_contract import (
    ACTION_ROUTES, DispatchApproval, ExactQuantity, MesExecutionContractError,
    MesExecutionTarget, ValidatedMesEnums, WorkOrderCreateApproval,
    build_dispatch, build_manual_inbound, build_production_inventory_read,
    build_progress_report, build_progress_report_materials_read, build_task_start,
    build_work_order_create, decode_dispatch_business_receipt,
    decode_production_inventory, decode_progress_report_receipt,
    decode_reportable_output, decode_work_order_create_receipt,
    encode_exact_json, mes_id, parse_json_exact,
)


def target():
    return MesExecutionTarget('9007199254740993', 'WJ-SYNTHETIC-ONLY',
                              '9007199254740995', '9007199254740997',
                              '9007199254740999', '9007199254741001')


def quantity(amount='1.25', *, unit_id='9007199254741003', precision=2):
    return ExactQuantity(amount, unit_id, precision)


def ack(data):
    return {'code': 200, 'needCheck': 0, 'message': '成功', 'data': data}


def work_order_approval():
    return WorkOrderCreateApproval(
        'WJ-SYNTHETIC-ONLY', 'EXT-SYNTHETIC-ONLY', 'SYNTHETIC-PART', 'V1',
        'synthetic unit', quantity(), '10', 'SYNTHETIC-ROUTE',
        frozenset({'inputMaterialControlOpenCOs', 'inputMaterialOpenCOs',
                   'processPlanNodeRelationOpenCOs', 'workInProgressOpenCOs'}),
    )


def enums():
    # Fixture values are explicit synthetic capabilities, not real tenant enums.
    return ValidatedMesEnums({
        'processPlanOpenCOs.reportFlag': frozenset({'synthetic-report-enabled'}),
        'resourceGroupList.bizType': frozenset({7}),
        'resourceGroupList.groupType': frozenset({8}),
        'bizOpenCOList.bizType': frozenset({9}),
        'inputMaterialControlOpenCOs.inputQcState': frozenset({'synthetic-qualified'}),
        'inputMaterialControlOpenCOs.limit': frozenset({'synthetic-fixed-bound'}),
    })


def work_order_payload():
    return {
        'code': 'WJ-SYNTHETIC-ONLY', 'externalOrderCode': 'EXT-SYNTHETIC-ONLY',
        'planStartTime': '2026-10-07 08:00:00', 'planFinishTime': '2026-10-07 09:00:00',
        'enableSopInt': 0, 'specifiedMaterialInt': 1, 'useBomFlag': 1,
        'useProcessRouteFlag': 1, 'status': '新建',
        'inputMaterialControlOpenCOs': [], 'inputMaterialOpenCOs': [],
        'outputMaterialOpenCOs': [{
            'workOrderCode': 'WJ-SYNTHETIC-ONLY', 'lineSeq': '10', 'mainFlagInt': 1,
            'materialCode': 'SYNTHETIC-PART', 'plannedAmount': '1.25',
            'unitName': 'synthetic unit', 'version': 'V1', 'outputProcessCode': '10',
            'processRouteCode': 'SYNTHETIC-ROUTE', 'autoWarehousingFlag': '否', 'warehousing': '是',
        }],
        'processPlanNodeRelationOpenCOs': [],
        'processPlanOpenCOs': [{'workOrderCode': 'WJ-SYNTHETIC-ONLY', 'code': 'SYNTHETIC-PROCESS',
                              'processNum': '10', 'reportFlag': 'synthetic-report-enabled'}],
        'workInProgressOpenCOs': [],
    }


def dispatch_approval():
    return DispatchApproval(target().work_order_id, 'WJ-SYNTHETIC-ONLY', '10',
                            'SYNTHETIC-TASK', 'SYNTHETIC-TASK-ID', quantity(),
                            ((9007199254741005, 'SYNTHETIC-RESOURCE'),))


def dispatch_payload():
    return {'dispatchRequests': [{
        'workOrderId': target().work_order_id, 'workOrderCode': 'WJ-SYNTHETIC-ONLY',
        'processNum': '10', 'produceTaskCode': 'SYNTHETIC-TASK',
        'taskIdentifier': 'SYNTHETIC-TASK-ID', 'plannedAmount': Decimal('1.25'),
        'plannedStartTime': 1791324000000, 'plannedFinishTime': 1791327600000,
        'remark': 'SYNTHETIC ONLY',
        'resourceGroupList': [{'bizType': 7, 'groupType': 8, 'lineNo': 10,
            'name': 'synthetic resource group', 'bizOpenCOList': [{
                'bizType': 9, 'bizId': 9007199254741005, 'bizCode': 'SYNTHETIC-RESOURCE',
            }]}],
    }]}


def reportable_response():
    selected = target()
    return ack({'outputMaterials': [{
        'progressReportKey': {'materialId': selected.material_id, 'lineId': selected.line_id,
                              'reportProcessId': selected.report_process_id},
        'warehousingFlag': True, 'autoWarehousingFlag': False,
        'virtualMaterialFlag': False, 'mainFlag': True,
        'outputMaterialUnit': {'id': quantity().unit_id, 'enableFlag': {'code': 1},
                               'enablePrecision': {'code': 1}, 'precisionFigure': 2},
        'reportType': [{'code': 6, 'message': 'synthetic mode'}],
    }]})


def inventory_response(amount=Decimal('2.50')):
    selected = target()
    return ack({'page': 1, 'total': 1, 'list': [{
        'id': 9007199254741007, 'lineId': selected.line_id,
        'materialVO': {'baseInfo': {'id': selected.material_id}},
        'amount': {'amount': amount, 'unitId': quantity().unit_id,
                   'unitCode': 'SYNTHETIC-CODE', 'amountDisplay': 'irrelevant display'},
        'virtualMaterialFlag': False, 'qcStatus': {'code': 1},
    }]})


class ExactQuantityTests(unittest.TestCase):
    def test_large_ids_keep_every_digit(self):
        value = quantity()
        decoded = parse_json_exact(encode_exact_json({'unit': value.unit_id, 'amount': value.amount}))
        self.assertEqual(decoded['unit'], 9007199254741003)
        self.assertEqual(decoded['amount'], Decimal('1.25'))

    def test_float_bool_missing_and_code_are_never_ids(self):
        for invalid in (1.0, True, None, 'UN000', '0', '-1', '01', 9223372036854775808):
            with self.subTest(invalid=invalid), self.assertRaises(MesExecutionContractError):
                mes_id(invalid)

    def test_quantity_does_not_round_or_coerce(self):
        for invalid in (1.25, True, None, ' 1', '-1', '1e0', 'NaN', Decimal('Infinity'), Decimal('1.251')):
            with self.subTest(invalid=str(invalid)), self.assertRaises(MesExecutionContractError):
                quantity(invalid)

    def test_trailing_zeroes_are_exact_not_extra_precision(self):
        self.assertEqual(encode_exact_json({'amount': quantity('1.25000').amount}), b'{"amount":1.25}')
        self.assertEqual(quantity('0').amount, Decimal(0))

    def test_extreme_exponent_is_bounded_before_rendering(self):
        with self.assertRaises(MesExecutionContractError):
            quantity(Decimal('1e-10000000'))
        self.assertEqual(encode_exact_json({'amount': Decimal('0e-10000000')}), b'{"amount":0}')

    def test_unit_precision_is_explicit_and_integer(self):
        for invalid in (None, True, -1, 11, 2.0):
            with self.subTest(invalid=invalid), self.assertRaises(MesExecutionContractError):
                quantity(precision=invalid)

    def test_json_rejects_float_nested_nonfinite_and_duplicate_fields(self):
        for invalid in ({'nested': [1.25]}, {1: 'not a string key'}):
            with self.assertRaises(MesExecutionContractError):
                encode_exact_json(invalid)
        for invalid in ('{"id":1,"id":2}', '{"amount":NaN}', '{"amount":Infinity}'):
            with self.assertRaises(MesExecutionContractError):
                parse_json_exact(invalid)


class WorkOrderContractTests(unittest.TestCase):
    def test_explicit_one_output_and_verified_empty_capabilities(self):
        original = work_order_payload()
        compiled = build_work_order_create(original, approval=work_order_approval(), enums=enums())
        self.assertEqual(compiled['outputMaterialOpenCOs'][0]['autoWarehousingFlag'], '否')
        self.assertEqual(compiled['outputMaterialOpenCOs'][0]['plannedAmount'], '1.25')
        compiled['code'] = 'modified copy'
        self.assertEqual(original['code'], 'WJ-SYNTHETIC-ONLY')

    def test_required_empty_array_is_not_assumed_supported(self):
        no_capabilities = replace(work_order_approval(), verified_empty_arrays=frozenset())
        with self.assertRaises(MesExecutionContractError):
            build_work_order_create(work_order_payload(), approval=no_capabilities, enums=enums())

    def test_output_autoentry_omission_or_true_is_rejected(self):
        for change in ('missing', '是', '1', True):
            payload = work_order_payload()
            if change == 'missing':
                del payload['outputMaterialOpenCOs'][0]['autoWarehousingFlag']
            else:
                payload['outputMaterialOpenCOs'][0]['autoWarehousingFlag'] = change
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError):
                build_work_order_create(payload, approval=work_order_approval(), enums=enums())

    def test_bound_output_identity_amount_unit_and_route_cannot_change(self):
        for field, value in (('workOrderCode', 'OTHER'), ('materialCode', 'OTHER'), ('version', 'OTHER'),
                             ('unitName', 'UN000'), ('plannedAmount', '1.26'), ('plannedAmount', 1.25),
                             ('outputProcessCode', '20'), ('processRouteCode', 'OTHER'), ('mainFlagInt', True)):
            payload = work_order_payload()
            payload['outputMaterialOpenCOs'][0][field] = value
            with self.subTest(field=field), self.assertRaises(MesExecutionContractError):
                build_work_order_create(payload, approval=work_order_approval(), enums=enums())

    def test_unverified_enum_is_not_guessed(self):
        payload = work_order_payload()
        payload['processPlanOpenCOs'][0]['reportFlag'] = '是'
        with self.assertRaises(MesExecutionContractError):
            build_work_order_create(payload, approval=work_order_approval(), enums=enums())

    def test_no_additional_output_sop_or_weak_control_skip(self):
        for extra in ('second-output', 'sop', 'skipWeakControlRule'):
            payload = work_order_payload()
            if extra == 'second-output':
                payload['outputMaterialOpenCOs'].append(copy.deepcopy(payload['outputMaterialOpenCOs'][0]))
            elif extra == 'sop':
                payload['enableSopInt'] = 1
            else:
                payload[extra] = ['synthetic skip']
            with self.subTest(extra=extra), self.assertRaises(MesExecutionContractError):
                build_work_order_create(payload, approval=work_order_approval(), enums=enums())

    def test_time_order_and_duplicate_process_are_rejected(self):
        for change in ('time', 'duplicate'):
            payload = work_order_payload()
            if change == 'time':
                payload['planFinishTime'] = payload['planStartTime']
            else:
                payload['processPlanOpenCOs'].append(copy.deepcopy(payload['processPlanOpenCOs'][0]))
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError):
                build_work_order_create(payload, approval=work_order_approval(), enums=enums())

    def test_self_relation_does_not_fake_nonempty_arrays(self):
        payload = work_order_payload()
        payload['processPlanNodeRelationOpenCOs'] = [{'workOrderCode': 'WJ-SYNTHETIC-ONLY',
                                                     'prevProcessNum': '10', 'nextProcessNum': '10'}]
        with self.assertRaises(MesExecutionContractError):
            build_work_order_create(payload, approval=work_order_approval(), enums=enums())

    def test_controls_match_real_input_ratio_and_parent(self):
        payload = work_order_payload()
        payload['inputMaterialOpenCOs'] = [{
            'workOrderCode': 'WJ-SYNTHETIC-ONLY', 'seq': '10', 'materialCode': 'SYNTHETIC-INPUT',
            'materialName': 'synthetic input', 'version': 'V1', 'unitName': 'synthetic input unit',
            'specificProcessInputInt': 1, 'splitSopControlInputInt': 0, 'inputProcessNum': '10',
            'subInputAmountDenominator': '1', 'subInputAmountNumerator': '0.5',
        }]
        payload['inputMaterialControlOpenCOs'] = [{
            'workOrderCode': 'WJ-SYNTHETIC-ONLY', 'seq': '10', 'lineSeq': '10',
            'materialCode': 'SYNTHETIC-INPUT', 'materialName': 'synthetic input',
            'inputAmountDenominator': '1', 'inputAmountNumerator': '0.5',
            'inputQcState': 'synthetic-qualified', 'limit': 'synthetic-fixed-bound',
            'lowerLimit': '0', 'upperLimit': '1',
        }]
        build_work_order_create(payload, approval=work_order_approval(), enums=enums())
        for field, value in (('materialCode', 'OTHER'), ('inputAmountNumerator', '0.6'),
                             ('inputAmountDenominator', '2'), ('lowerLimit', '2')):
            invalid = copy.deepcopy(payload)
            invalid['inputMaterialControlOpenCOs'][0][field] = value
            with self.subTest(field=field), self.assertRaises(MesExecutionContractError):
                build_work_order_create(invalid, approval=work_order_approval(), enums=enums())

        split = copy.deepcopy(payload)
        first = split['inputMaterialControlOpenCOs'][0]
        first['inputAmountNumerator'] = '0.2'
        second = copy.deepcopy(first)
        second.update(lineSeq='20', inputAmountNumerator='0.3')
        split['inputMaterialControlOpenCOs'].append(second)
        compiled = build_work_order_create(split, approval=work_order_approval(), enums=enums())
        self.assertEqual(len(compiled['inputMaterialControlOpenCOs']), 2)
        split['inputMaterialControlOpenCOs'][1]['lineSeq'] = '10'
        with self.assertRaises(MesExecutionContractError):
            build_work_order_create(split, approval=work_order_approval(), enums=enums())

    def test_enum_wire_types_follow_documented_fields_even_if_allowed_set_is_wrong(self):
        payload = work_order_payload()
        payload['processPlanOpenCOs'][0]['reportFlag'] = 1
        wrong_types = ValidatedMesEnums({'processPlanOpenCOs.reportFlag': {1}})
        with self.assertRaises(MesExecutionContractError):
            build_work_order_create(payload, approval=work_order_approval(), enums=wrong_types)


class DispatchContractTests(unittest.TestCase):
    def test_dispatch_has_exact_amount_and_resources(self):
        compiled = build_dispatch(dispatch_payload(), approval=dispatch_approval(), enums=enums())
        decoded = parse_json_exact(encode_exact_json(compiled))
        row = decoded['dispatchRequests'][0]
        self.assertEqual(row['plannedAmount'], Decimal('1.25'))
        self.assertEqual(row['resourceGroupList'][0]['bizOpenCOList'][0]['bizId'], 9007199254741005)

    def test_dispatch_mismatch_and_float_are_rejected(self):
        for field, value in (('workOrderId', '9007199254741011'), ('workOrderCode', 'OTHER'),
                             ('processNum', '20'), ('produceTaskCode', 'OTHER'),
                             ('taskIdentifier', 'OTHER'), ('plannedAmount', '1.26'), ('plannedAmount', 1.25)):
            payload = dispatch_payload()
            payload['dispatchRequests'][0][field] = value
            with self.subTest(field=field), self.assertRaises(MesExecutionContractError):
                build_dispatch(payload, approval=dispatch_approval(), enums=enums())

    def test_dispatch_cannot_silently_add_or_replace_equipment(self):
        payload = dispatch_payload()
        payload['dispatchRequests'][0]['resourceGroupList'][0]['bizOpenCOList'][0]['bizId'] += 2
        with self.assertRaises(MesExecutionContractError):
            build_dispatch(payload, approval=dispatch_approval(), enums=enums())

    def test_unknown_resource_enums_and_empty_or_duplicate_resources_block(self):
        for change in ('enum', 'empty', 'duplicate'):
            payload = dispatch_payload()
            group = payload['dispatchRequests'][0]['resourceGroupList'][0]
            if change == 'enum':
                group['bizType'] = 1
            elif change == 'empty':
                group['bizOpenCOList'] = []
            else:
                group['bizOpenCOList'] *= 2
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError):
                build_dispatch(payload, approval=dispatch_approval(), enums=enums())

    def test_resource_enum_is_integer_even_when_server_set_contains_string(self):
        payload = dispatch_payload()
        payload['dispatchRequests'][0]['resourceGroupList'][0]['bizType'] = '7'
        wrong_types = ValidatedMesEnums({
            'resourceGroupList.bizType': {'7'}, 'resourceGroupList.groupType': {8},
            'bizOpenCOList.bizType': {9},
        })
        with self.assertRaises(MesExecutionContractError):
            build_dispatch(payload, approval=dispatch_approval(), enums=wrong_types)

    def test_start_explicitly_leaves_sop_start_false(self):
        self.assertEqual(build_task_start(target().task_id),
                         {'taskId': 9007199254740995, 'alsoStartSopTaskFlag': False})


class ReportAndInboundTests(unittest.TestCase):
    def report(self, **changes):
        values = dict(quantity=quantity(), executor_ids=[9007199254741009],
                      report_type=6, allowed_report_types=(6,), qc_status=1, remark='SYNTHETIC ONLY')
        values.update(changes)
        return build_progress_report(target(), **values)

    def inbound(self, **changes):
        values = dict(production_inventory_id=9007199254741007, quantity=quantity(),
                      available_quantity=quantity('2.5'), storage_location_id=9007199254741011,
                      approved_storage_location_id=9007199254741011, qc_status=1, remark='SYNTHETIC ONLY')
        values.update(changes)
        return build_manual_inbound(target(), **values)

    def test_report_bound_ids_exact_amount_and_no_auto_feed_or_entry(self):
        body = self.report()
        self.assertEqual(body['feedAndReportFlag'], 0)
        self.assertNotIn('storageLocationId', body)
        self.assertNotIn('skipWeakControlRule', body)
        decoded = parse_json_exact(encode_exact_json(body))
        row = decoded['progressReportItems'][0]['progressReportMaterialItems'][0]
        self.assertEqual(row['reportAmount'], Decimal('1.25'))
        self.assertEqual(row['reportUnitId'], 9007199254741003)
        self.assertEqual(body['progressReportMaterial']['reportProcessId'], 9007199254741001)

    def test_report_mode_must_be_read_from_selected_output(self):
        for changes in ({'report_type': 1}, {'allowed_report_types': ()}, {'report_type': True},
                        {'allowed_report_types': (True,)}, {'allowed_report_types': (6.0,)}):
            with self.subTest(changes=changes), self.assertRaises(MesExecutionContractError):
                self.report(**changes)

    def test_report_rejects_pending_failed_concession_and_duplicate_executors(self):
        for changes in ({'qc_status': 2}, {'qc_status': 3}, {'qc_status': 4}, {'qc_status': True},
                        {'executor_ids': []}, {'executor_ids': [1, 1]}, {'quantity': quantity('0')}):
            with self.subTest(changes=str(changes)), self.assertRaises(MesExecutionContractError):
                self.report(**changes)

    def test_manual_inbound_exact_destination_quantity_unit_and_inventory(self):
        body = self.inbound()
        row = parse_json_exact(encode_exact_json(body))['productionInventoryMaterialList'][0]
        self.assertEqual(row['warehouseIntoAmount'], Decimal('1.25'))
        self.assertEqual(row['productionInventoryId'], 9007199254741007)
        self.assertEqual(body['storageLocationId'], 9007199254741011)
        self.assertNotIn('skipWeakControlRule', body)

    def test_inbound_cannot_replace_location_unit_or_exceed_balance(self):
        for changes in ({'storage_location_id': 9007199254741013},
                        {'available_quantity': quantity('1.24')},
                        {'available_quantity': quantity('2.5', unit_id=9007199254741015)},
                        {'available_quantity': quantity('2.5', precision=3)},
                        {'quantity': quantity('0')}, {'qc_status': 3}, {'qc_status': True},
                        {'production_inventory_id': 'UN000'}):
            with self.subTest(changes=str(changes)), self.assertRaises(MesExecutionContractError):
                self.inbound(**changes)

    def test_inventory_read_keeps_zero_balance_for_reconciliation(self):
        body = build_production_inventory_read(target())
        self.assertIs(body['amountFilterFlag'], False)
        self.assertEqual((body['taskId'], body['materialId'], body['lineId']),
                         (target().task_id, target().material_id, target().line_id))
        self.assertEqual(build_progress_report_materials_read(target().task_id), {'taskId': target().task_id})
        for changes in ({'page': 3}, {'size': 26}, {'page': True}):
            with self.subTest(changes=changes), self.assertRaises(MesExecutionContractError):
                build_production_inventory_read(target(), **changes)


class ResponseContractTests(unittest.TestCase):
    def test_response_ids_are_exact_and_dispatch_id_is_not_a_task_id(self):
        created = decode_work_order_create_receipt(ack({'workOrderId': 9007199254740993}))
        dispatched = decode_dispatch_business_receipt(ack({'id': 9007199254741017}))
        self.assertEqual(created.work_order_id, 9007199254740993)
        self.assertEqual(dispatched.business_id, 9007199254741017)
        self.assertFalse(hasattr(dispatched, 'task_id'))

    def test_missing_null_or_weak_confirmation_does_not_acknowledge_write(self):
        for need_check in ('missing', None, 1, True, 0.0):
            response = ack({'workOrderId': 9007199254740993})
            if need_check == 'missing':
                del response['needCheck']
            else:
                response['needCheck'] = need_check
            with self.subTest(need_check=need_check), self.assertRaises(MesExecutionContractError):
                decode_work_order_create_receipt(response)

    def test_report_receipt_is_not_inventory_or_inbound_evidence(self):
        receipt = decode_progress_report_receipt(ack({
            'messageTraceId': 9007199254741021, 'progressReportRecordIds': [9007199254741023],
            'queryInventoryResult': True,
        }))
        self.assertEqual(receipt.progress_report_record_ids, (9007199254741023,))
        self.assertTrue(receipt.query_inventory_result)
        self.assertFalse(hasattr(receipt, 'production_inventory_id'))
        self.assertFalse(hasattr(receipt, 'inbound_completed'))

    def test_report_receipt_duplicate_ids_or_nonboolean_polling_block(self):
        for changes in ({'progressReportRecordIds': [1, 1]}, {'queryInventoryResult': 1}):
            data = {'messageTraceId': 1, 'progressReportRecordIds': [2], 'queryInventoryResult': False}
            data.update(changes)
            with self.subTest(changes=changes), self.assertRaises(MesExecutionContractError):
                decode_progress_report_receipt(ack(data))

    def test_actual_output_contract_is_required_for_report(self):
        observed = decode_reportable_output(reportable_response(), target=target(), quantity=quantity())
        self.assertEqual(observed.report_types, (6,))
        self.assertEqual(observed.unit_id, quantity().unit_id)
        self.assertEqual(observed.unit_precision, 2)

    def test_nullable_or_ambiguous_output_keys_cannot_be_inferred(self):
        for change in ('line-null', 'process-null', 'duplicate'):
            response = reportable_response()
            rows = response['data']['outputMaterials']
            if change == 'duplicate':
                rows *= 2
            else:
                rows[0]['progressReportKey']['lineId' if change == 'line-null' else 'reportProcessId'] = None
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError):
                decode_reportable_output(response, target=target(), quantity=quantity())

    def test_actual_autoentry_virtual_unit_precision_and_enabled_state_gate(self):
        for change in ('auto-entry', 'virtual', 'wrong-unit', 'precision', 'disabled', 'boolean-enum'):
            response = reportable_response()
            row = response['data']['outputMaterials'][0]
            if change == 'auto-entry':
                row['autoWarehousingFlag'] = True
            elif change == 'virtual':
                row['virtualMaterialFlag'] = True
            elif change == 'wrong-unit':
                row['outputMaterialUnit']['id'] = 9007199254741027
            elif change == 'precision':
                row['outputMaterialUnit']['precisionFigure'] = 3
            else:
                row['outputMaterialUnit']['enableFlag']['code'] = 0 if change == 'disabled' else True
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError):
                decode_reportable_output(response, target=target(), quantity=quantity())

    def test_inventory_exact_id_and_zero_balance_are_retained(self):
        observed = decode_production_inventory(inventory_response(0), target=target(), quantity=quantity())
        row = observed.rows[0]
        self.assertEqual(row.production_inventory_id, 9007199254741007)
        self.assertEqual(row.quantity.amount, Decimal(0))
        self.assertEqual(row.material_id, target().material_id)
        self.assertFalse(hasattr(row, 'task_id'))

    def test_inventory_display_string_is_never_quantity_fallback(self):
        for change in ('missing', 'float'):
            response = inventory_response()
            if change == 'missing':
                del response['data']['list'][0]['amount']['amount']
            else:
                response['data']['list'][0]['amount']['amount'] = 2.5
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError):
                decode_production_inventory(response, target=target(), quantity=quantity())

    def test_inventory_foreign_material_line_or_unit_and_duplicate_block(self):
        for change in ('material', 'line', 'unit', 'duplicate'):
            response = inventory_response()
            row = response['data']['list'][0]
            if change == 'material':
                row['materialVO']['baseInfo']['id'] += 2
            elif change == 'line':
                row['lineId'] += 2
            elif change == 'unit':
                row['amount']['unitId'] += 2
            else:
                response['data']['list'] *= 2
                response['data']['total'] = 2
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError):
                decode_production_inventory(response, target=target(), quantity=quantity())

    def test_inventory_pagination_cannot_claim_complete_or_change_scope(self):
        for change in ('wrong-page', 'impossible-total'):
            response = inventory_response()
            response['data']['page' if change == 'wrong-page' else 'total'] = 2 if change == 'wrong-page' else 0
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError):
                decode_production_inventory(response, target=target(), quantity=quantity())

    def test_action_route_map_is_fixed_and_separates_reads_and_writes(self):
        self.assertEqual(ACTION_ROUTES['manual_inbound'], '/mfg/open/v1/production_inventory/_bulk_to_warehouse')
        self.assertEqual(len(ACTION_ROUTES), 7)
        with self.assertRaises(TypeError):
            ACTION_ROUTES['manual_inbound'] = '/some/other/route'


if __name__ == '__main__':
    unittest.main()
