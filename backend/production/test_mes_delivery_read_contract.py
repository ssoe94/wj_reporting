"""Document-shaped synthetic reads only; no network, tokens or Django needed."""
from copy import deepcopy
from dataclasses import replace
from decimal import Decimal
import unittest

from production.mes_delivery_read_contract import (
    READ_ROUTES, DeliveryReadBinding, ValidatedReadEnums,
    build_work_order_detail_read, build_task_list_read, build_task_detail_read,
    build_report_records_read, build_warehouse_inventory_read,
    build_inventory_changes_read, build_report_receipts_read, build_inbound_records_read,
    build_production_inventory_status_read, decode_work_order_detail, decode_task_list,
    decode_task_detail, decode_report_records, decode_warehouse_inventory,
    decode_inventory_changes, decode_report_receipts, decode_inbound_records,
    decode_production_inventory_status, report_inventory_causality,
)
from production.mes_execution_contract import MesExecutionContractError


BASE = 9007199254740993
START = 2000000000000


def binding(**changes):
    values = dict(tenant='SYNTHETIC-TENANT', work_order_code='SYNTHETIC-WO',
        work_order_id=BASE, task_id=BASE + 2, material_id=BASE + 4, resource_id=BASE + 6,
        unit_id=BASE + 8, unit_precision=3, warehouse_id=BASE + 10,
        storage_location_id=BASE + 12, actor_id=BASE + 14,
        line_id=BASE + 16, report_process_id=BASE + 18, task_code='SYNTHETIC-TASK',
        window_start_ms=START, window_end_ms=START + 3600000)
    values.update(changes)
    return DeliveryReadBinding(**values)


def amount(value=Decimal('1.125')):
    return {'amount': value, 'unit': {'id': BASE + 8, 'precisionFigure': 3}}


def ack(data):
    return {'code': 200, 'needCheck': 0, 'message': 'SYNTHETIC-PRIVATE-MESSAGE', 'data': data}


def page(row=None, *, total=None):
    rows = [] if row is None else [row]
    return ack({'page': 1, 'total': len(rows) if total is None else total, 'list': rows})


def task_row():
    return {'workOrderId': BASE, 'workOrderCode': 'SYNTHETIC-WO', 'taskId': BASE + 2,
        'taskCode': 'SYNTHETIC-TASK', 'taskStatus': {'code': 2, 'message': 'pretend completed'},
        'progressReportOpenVO': {'materialInfo': {'baseInfo': {'id': BASE + 4}},
            'lineId': BASE + 16, 'plannedAmount': amount(), 'autoWarehousingFlag': False}}


def task_detail():
    return {'relatedWorkOrderId': BASE, 'relatedWorkOrderCode': 'SYNTHETIC-WO',
        'taskId': BASE + 2, 'taskCode': 'SYNTHETIC-TASK', 'taskStatus': {'code': 2},
        'equipments': [{'id': BASE + 6}], 'workOrderMainOutputMaterial': {'id': BASE + 4}}


def report():
    return {'workOrderId': BASE, 'workOrderCode': 'SYNTHETIC-WO', 'taskId': BASE + 2,
        'reportRecordId': BASE + 20, 'id': BASE + 22, 'lineId': BASE + 16,
        'materialInfo': {'baseInfo': {'id': BASE + 4}}, 'reportTime': START + 10,
        'reportBaseAmount': amount(Decimal('0.125')), 'reporter': {'id': BASE + 14}, 'qcStatus': {'code': 3}}


def stock():
    return {'id': BASE + 24, 'material': {'id': BASE + 4}, 'amount': amount(Decimal('2.125')),
        'storageLocationId': BASE + 12, 'storageLocationDetail': {
            'warehouse': {'id': BASE + 10}, 'location': {'id': BASE + 12}},
        'workOrderSimpleInfos': [{'id': BASE, 'code': 'SYNTHETIC-WO'}], 'qcStatus': {'code': 1}}


def receipt(*, direct=True):
    row = {'reportRecordIds': [BASE + 20], 'storageLocation': {
        'storage': {'id': BASE + 12}, 'warehouse': {'id': BASE + 10}},
        'amount': {'amount': amount('0.125')}, 'operator': {'id': BASE + 14},
        'operateTime': START + 20, 'qcStatus': {'code': 1}}
    if direct:
        row.update(inboundOrderRecordId=BASE + 26, inventoryElementId=BASE + 24, materialId=BASE + 4)
    else:
        row.update(inboundOrderOperateId=BASE + 26, inboundInventoryElementId=BASE + 24, material={'id': BASE + 4})
    return row


class ReadBuilderTests(unittest.TestCase):
    def test_code_only_work_order_read_has_no_inventory_or_global_list(self):
        scoped = DeliveryReadBinding('SYNTHETIC-TENANT', 'SYNTHETIC-WO')
        self.assertEqual(build_work_order_detail_read(scoped), {'workOrderCode': 'SYNTHETIC-WO', 'warehouseFlag': False})
        self.assertEqual(build_work_order_detail_read(binding())['workOrderId'], BASE)

    def test_task_list_is_one_work_order_and_known_filters_only(self):
        scoped = DeliveryReadBinding('SYNTHETIC-TENANT', 'SYNTHETIC-WO', work_order_id=BASE)
        self.assertEqual(build_task_list_read(scoped), {'workOrderIdList': [BASE], 'page': 1, 'size': 25})
        body = build_task_list_read(binding())
        self.assertEqual(body['equipmentIdList'], [BASE + 6])
        self.assertEqual(body['materialIdList'], [BASE + 4])
        self.assertEqual(build_task_detail_read(binding()), {'taskId': BASE + 2})

    def test_reports_scope_to_work_order_task_time_and_optional_exact_ids(self):
        body = build_report_records_read(binding(), report_ids=(BASE + 20,))
        self.assertEqual(body['taskIds'], [BASE + 2])
        self.assertEqual(body['workOrderIdList'], [BASE])
        self.assertEqual(body['progressReportRecordIds'], [BASE + 20])
        self.assertEqual(body['reportTimeTo'] - body['reportTimeFrom'], 3600000)

    def test_one_report_request_covers_only_explicit_observed_tasks(self):
        scoped = binding(task_id=None)
        body = build_report_records_read(scoped, task_ids=(BASE + 2, BASE + 32))
        self.assertEqual(body['taskIds'], [BASE + 2, BASE + 32])
        with self.assertRaises(MesExecutionContractError): build_report_records_read(scoped)

    def test_inventory_and_change_log_need_exact_location_and_actor_window(self):
        body = build_warehouse_inventory_read(binding())
        self.assertEqual(body['storageLocationIds'], [BASE + 12])
        self.assertEqual(body['workOrderIds'], [BASE])
        changes = build_inventory_changes_read(binding())
        self.assertEqual(changes['operatorId'], BASE + 14)
        self.assertEqual((changes['action'], changes['direction']), ('in', True))
        self.assertNotIn('warehousePrivilege', changes)
        for missing in ('material_id', 'warehouse_id', 'storage_location_id', 'actor_id', 'window_start_ms'):
            values = {missing: None}
            if missing == 'window_start_ms': values['window_end_ms'] = None
            with self.subTest(missing=missing), self.assertRaises(MesExecutionContractError):
                build_inventory_changes_read(binding(**values))

    def test_report_receipt_and_inbound_read_exact_ids_are_required(self):
        self.assertEqual(build_report_receipts_read(binding(), [BASE + 20]), {'ids': [BASE + 20]})
        self.assertEqual(build_inbound_records_read(binding(), [BASE + 26])['inboundOrderOperateRecordIds'], [BASE + 26])
        for values in ([], [1, 1], ['UN000'], [True], list(range(1, 27))):
            with self.subTest(values=values), self.assertRaises(MesExecutionContractError):
                build_report_receipts_read(binding(), values)

    def test_page_time_and_identity_bounds_do_not_coerce(self):
        for options in ({'page': 3}, {'size': 26}, {'page': True}):
            with self.assertRaises(MesExecutionContractError): build_task_list_read(binding(), **options)
        for changes in ({'window_end_ms': START}, {'window_end_ms': START + 86400001},
                        {'window_start_ms': 1.0}, {'work_order_id': True}, {'unit_precision': 11}):
            with self.subTest(changes=changes), self.assertRaises(MesExecutionContractError): binding(**changes)

    def test_read_routes_are_fixed_and_contain_no_write_path(self):
        self.assertEqual(READ_ROUTES['report_receipts'], '/mfg/open/v2/progress_report/_list_inbound_record')
        self.assertTrue(all(not any(word in route for word in ('_start', '_dispatch', '_doImport', '_bulk_to_warehouse'))
                            for route in READ_ROUTES.values()))
        with self.assertRaises(TypeError): READ_ROUTES['task_detail'] = '/unsafe'


class ReadDecoderTests(unittest.TestCase):
    def test_work_order_header_preserves_exact_identity_without_inventing_output(self):
        row = {'id': BASE, 'code': 'SYNTHETIC-WO', 'status': {'code': 9, 'message': 'completed'},
               'resource': {'id': BASE + 6}, 'createdAt': START}
        result = decode_work_order_detail(ack(row), binding())
        self.assertEqual(result.fields['work_order_id'], BASE)
        self.assertIsNone(result.fields['state'])
        self.assertNotIn('quantity', result.fields)
        self.assertNotIn('message', repr(result))
        row['code'] = 'OTHER'
        with self.assertRaises(MesExecutionContractError): decode_work_order_detail(ack(row), binding())

    def test_explicit_server_enum_mapping_is_required_for_state_meaning(self):
        enums = ValidatedReadEnums({'task_status': {1: 'pending', 2: 'running', 3: 'paused', 4: 'completed', 5: 'cancelled'}})
        row = task_row()
        self.assertIsNone(decode_task_list(page(row), binding()).records[0].fields['state'])
        observed = decode_task_list(page(row), binding(), enums=enums)
        self.assertEqual(observed.records[0].fields['state'], 'running')
        row['taskStatus']['code'] = 99
        self.assertIsNone(decode_task_list(page(row), binding(), enums=enums).records[0].fields['state'])

    def test_task_list_observes_quantity_and_missing_amount_is_explicit(self):
        observed = decode_task_list(page(task_row()), binding())
        self.assertTrue(observed.complete)
        self.assertEqual(observed.records[0].fields['planned_quantity'].amount, Decimal('1.125'))
        row = task_row()
        del row['progressReportOpenVO']['plannedAmount']['unit']
        self.assertIsNone(decode_task_list(page(row), binding()).records[0].fields['planned_quantity'])
        row['progressReportOpenVO'] = {'plannedAmount': None, 'lineId': None, 'materialInfo': None}
        fields = decode_task_list(page(row), binding()).records[0].fields
        self.assertEqual(fields['status_code'], 2)
        self.assertNotIn('line_id', fields)
        self.assertNotIn('material_id', fields)

    def test_task_detail_binds_work_order_task_material_and_resource(self):
        observed = decode_task_detail(ack(task_detail()), binding())
        self.assertEqual(observed.fields['resource_ids'], (BASE + 6,))
        self.assertNotIn('planned_quantity', observed.fields)
        for field, value in (('relatedWorkOrderId', BASE + 100), ('relatedWorkOrderCode', 'OTHER'), ('taskId', BASE + 100)):
            row = task_detail(); row[field] = value
            with self.subTest(field=field), self.assertRaises(MesExecutionContractError): decode_task_detail(ack(row), binding())
        row = task_detail(); row['equipments'] = [{'id': BASE + 100}]
        with self.assertRaises(MesExecutionContractError): decode_task_detail(ack(row), binding())

    def test_read_quantity_is_observed_not_forced_to_planned_or_pass(self):
        observed = decode_report_records(page(report()), binding()).records[0]
        self.assertEqual(observed.fields['quantity'].amount, Decimal('0.125'))
        self.assertEqual(observed.fields['qc_status'], 3)
        self.assertEqual(observed.fields['actor_id'], BASE + 14)

    def test_report_display_numeric_quantity_and_missing_precision_remain_exact(self):
        row = report()
        row['reportBaseAmountDisplay'] = {'amount': Decimal('0.125'), 'amountDisplay': 'display text unused',
                                        'unitId': BASE + 8, 'unitCode': 'UN-SYNTHETIC', 'unitName': 'synthetic units'}
        observed = decode_report_records(page(row), binding()).records[0].fields
        self.assertEqual(observed['quantity'].amount, Decimal('0.125'))
        self.assertEqual(observed['unit_name'], 'synthetic units')
        observed = decode_report_records(page(row), binding(unit_precision=None)).records[0].fields
        self.assertIsNone(observed['quantity'])
        self.assertEqual(observed['report_record_id'], BASE + 20)

    def test_distinct_report_details_can_share_header_and_span_observed_tasks(self):
        first, second = report(), report()
        second.update(id=BASE + 34, taskId=BASE + 32)
        observed = decode_report_records(ack({'page': 1, 'total': 2, 'list': [first, second]}),
            binding(task_id=None), task_ids=(BASE + 2, BASE + 32))
        self.assertEqual([row.fields['report_record_id'] for row in observed.records], [BASE + 20, BASE + 20])
        self.assertEqual(len({row.fields['report_detail_id'] for row in observed.records}), 2)
        with self.assertRaises(MesExecutionContractError):
            decode_report_records(ack({'page': 1, 'total': 2, 'list': [first, second]}),
                                  binding(task_id=None), task_ids=(BASE + 2,))

    def test_report_float_unit_mismatch_foreign_task_and_outside_window_fail(self):
        for change in ('float', 'string-number', 'unit', 'task', 'time', 'record'):
            row = report()
            if change == 'float': row['reportBaseAmount']['amount'] = 0.125
            elif change == 'string-number': row['reportBaseAmount']['amount'] = '0.125'
            elif change == 'unit': row['reportBaseAmount']['unit']['id'] += 100
            elif change == 'task': row['taskId'] += 100
            elif change == 'time': row['reportTime'] = START + 3600000
            else: row['reportRecordId'] += 100
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError):
                decode_report_records(page(row), binding(), report_ids=(BASE + 20,))

    def test_duplicate_entities_and_partial_pagination_do_not_claim_complete(self):
        row = task_row()
        response = ack({'page': 1, 'total': 2, 'list': [row, deepcopy(row)]})
        with self.assertRaises(MesExecutionContractError): decode_task_list(response, binding())
        self.assertFalse(decode_task_list(page(task_row(), total=26), binding()).complete)

    def test_warehouse_stock_requires_returned_material_location_warehouse_work_order(self):
        observed = decode_warehouse_inventory(page(stock()), binding()).records[0]
        self.assertEqual(observed.fields['quantity'].amount, Decimal('2.125'))
        self.assertEqual(observed.fields['inventory_id'], BASE + 24)
        for change in ('material', 'location', 'warehouse', 'work-order'):
            row = stock()
            if change == 'material': row['material']['id'] += 100
            elif change == 'location': row['storageLocationDetail']['location']['id'] += 100
            elif change == 'warehouse': row['storageLocationDetail']['warehouse']['id'] += 100
            else: row['workOrderSimpleInfos'] = [{'id': BASE + 100, 'code': 'OTHER'}]
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError): decode_warehouse_inventory(page(row), binding())

    def test_direct_documented_report_receipt_link_is_observed_not_physical_completion(self):
        response = ack([{'progressReportId': BASE + 20, 'inboundRecord': receipt()}])
        observed = decode_report_receipts(response, binding(), [BASE + 20])
        self.assertEqual((observed.status, observed.reason), ('observed', 'report_linked_receipt_observed'))
        record = observed.records[0]
        self.assertEqual(record.fields['receipt_id'], BASE + 26)
        self.assertEqual(record.fields['report_record_ids'], (BASE + 20,))
        self.assertEqual(record.fields['quantity'].amount, Decimal('0.125'))
        self.assertNotIn('completed', record.fields)
        self.assertNotIn('net_movement', record.fields)

    def test_report_scoped_receipt_read_needs_no_fabricated_task_and_missing_quantity_stays_unknown(self):
        scoped = binding(task_id=None, unit_id=None, unit_precision=None)
        self.assertEqual(build_report_receipts_read(scoped, [BASE + 20]), {'ids': [BASE + 20]})
        row = receipt()
        del row['amount']
        observed = decode_report_receipts(ack([{'progressReportId': BASE + 20, 'inboundRecord': row}]), scoped, [BASE + 20])
        self.assertEqual(observed.status, 'observed')
        self.assertEqual(observed.records[0].fields['receipt_id'], BASE + 26)
        self.assertIsNone(observed.records[0].fields['quantity'])
        with self.assertRaises(MesExecutionContractError): build_report_receipts_read(scoped, [])
        with self.assertRaises(MesExecutionContractError):
            build_report_receipts_read(replace(scoped, work_order_id=None), [BASE + 20])

    def test_absent_receipt_or_missing_requested_report_is_insufficient(self):
        for rows in ([], [{'progressReportId': BASE + 20, 'inboundRecord': None}]):
            observed = decode_report_receipts(ack(rows), binding(), [BASE + 20])
            self.assertEqual(observed.status, 'insufficient')
            self.assertEqual(observed.records, ())

    def test_direct_receipt_wrong_link_or_destination_does_not_normalize(self):
        for change in ('report', 'record', 'material', 'location', 'warehouse', 'duplicate'):
            row = {'progressReportId': BASE + 20, 'inboundRecord': receipt()}
            if change == 'report': row['progressReportId'] += 100
            elif change == 'record': row['inboundRecord']['reportRecordIds'] = [BASE + 100]
            elif change == 'material': row['inboundRecord']['materialId'] += 100
            elif change == 'location': row['inboundRecord']['storageLocation']['storage']['id'] += 100
            elif change == 'warehouse': row['inboundRecord']['storageLocation']['warehouse']['id'] += 100
            rows = [row, deepcopy(row)] if change == 'duplicate' else [row]
            with self.subTest(change=change), self.assertRaises(MesExecutionContractError):
                decode_report_receipts(ack(rows), binding(), [BASE + 20])

    def test_receipt_may_be_later_than_report_window_and_keeps_actual_execute_type(self):
        row = receipt()
        row.update(operateTime=START + 86400000, executeType={'code': 3, 'message': 'production inbound'})
        observed = decode_report_receipts(ack([{'progressReportId': BASE + 20, 'inboundRecord': row}]), binding(), [BASE + 20])
        self.assertEqual(observed.records[0].fields['operated_at_ms'], START + 86400000)
        self.assertEqual(observed.records[0].fields['execute_type'], 3)

    def test_inbound_operate_record_preserves_distinct_documented_ids(self):
        observed = decode_inbound_records(page(receipt(direct=False)), binding(), [BASE + 26], report_ids=[BASE + 20])
        self.assertEqual(observed.records[0].fields['inventory_id'], BASE + 24)
        self.assertNotIn('change_log_id', observed.records[0].fields)

    def test_change_log_does_not_invent_actor_location_or_receipt_id_links(self):
        row = {'id': BASE + 28, 'createdAt': START + 30, 'material': {'id': BASE + 4},
            'action': {'action': 'in', 'desc': 'SYNTHETIC-PRIVATE'}, 'amount': {
                'direction': True, 'amount': amount('0.125'), 'afterAmount': amount('2.125')}}
        # This endpoint documents JSON numbers rather than text amounts.
        row['amount']['amount']['amount'] = Decimal('0.125')
        row['amount']['afterAmount']['amount'] = Decimal('2.125')
        observed = decode_inventory_changes(page(row), binding())
        self.assertEqual(observed.status, 'insufficient')
        self.assertEqual(observed.records[0].fields['change_log_id'], BASE + 28)
        self.assertNotIn('actor_id', observed.records[0].fields)
        self.assertNotIn('receipt_id', observed.records[0].fields)

    def test_report_and_production_stock_correlation_never_becomes_direct_causality(self):
        observed = report_inventory_causality([report()], [stock()])
        self.assertEqual(observed.status, 'insufficient')
        self.assertEqual(observed.reason, 'report_to_production_inventory_direct_link_not_documented')

    def test_existing_production_inventory_decoder_keeps_exact_scoped_quantity(self):
        body = build_production_inventory_status_read(binding())
        self.assertIs(body['amountFilterFlag'], False)
        row = {'id': BASE + 30, 'lineId': BASE + 16, 'materialVO': {'baseInfo': {'id': BASE + 4}},
            'amount': {'amount': Decimal('0.125'), 'unitId': BASE + 8}, 'qcStatus': {'code': 3}, 'virtualMaterialFlag': False}
        observed = decode_production_inventory_status(page(row), binding())
        self.assertEqual(observed.rows[0].quantity.amount, Decimal('0.125'))

    def test_response_envelope_and_boolean_enum_do_not_coerce(self):
        row = task_detail()
        for changes in ({'code': True}, {'needCheck': None}, {'needCheck': 1}):
            response = ack(row); response.update(changes)
            with self.assertRaises(MesExecutionContractError): decode_task_detail(response, binding())
        row['taskStatus']['code'] = True
        with self.assertRaises(MesExecutionContractError): decode_task_detail(ack(row), binding())


if __name__ == '__main__':
    unittest.main()
