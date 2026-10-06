import assert from 'node:assert/strict';
import test from 'node:test';
import { canReadMesDetailPreview, mesDetailPreviewDownload, parseMesDetailPreview, previewLifecycle } from '../src/pages/quality/inspection-requests/mesDetailPreviewModel.ts';
import { previewFixture } from './fixtures/mes-detail-preview.ts';

test('preview eligibility is exact actor18 without coercion or alternate roles', () => {
  assert.equal(canReadMesDetailPreview(18), true);
  for (const actor of [12, 19, '18', null, undefined, true, { id: 18 }]) assert.equal(canReadMesDetailPreview(actor), false);
});
test('metadata keeps exact IDs and decimal precision and drops unapproved fields at every level', () => {
  const raw: any = previewFixture();
  raw.token = raw.results = raw.items[0].measurements = raw.items[0].unit.secret = 'SYNTHETIC-EXCLUDED';
  const parsed = parseMesDetailPreview(raw);
  assert.deepEqual(parsed, previewFixture());
  assert.equal(parsed.items[0].minimum, '1.00');
  assert.equal(JSON.stringify(parsed).includes('SYNTHETIC-EXCLUDED'), false);
});
test('scope, read-only marker and metadata schema fail closed without exposing rejected values', () => {
  const mutations: ((data: any) => void)[] = [
    (v) => { v.qc_id = '90099'; }, (v) => { v.qc_code = 'SYNTHETIC-OTHER'; },
    (v) => { v.read_only = false; }, (v) => { v.expected_item_count = 17; },
    (v) => { v.observed_at = 'SYNTHETIC-invalid'; }, (v) => { v.get_able = true; },
    (v) => { v.executor_matches_lee = 'true'; }, (v) => { v.items[0].id = 91000; },
    (v) => { v.executor_id = '90099'; }, (v) => { v.executor_present = 'true'; },
    (v) => { v.items[0].id = '9223372036854775808'; },
    (v) => { v.items[1].id = v.items[0].id; }, (v) => { v.items[0].scale = 19; },
    (v) => { v.items[0].minimum = '1000000000000000.000000000000000001'; },
    (v) => { v.items[0].maximum = 2; }, (v) => { v.items[0].base = '1e2'; },
    (v) => { v.items[0].name = 'S'.repeat(257); }, (v) => { v.item_count = 15; },
    (v) => { v.items[0].options = ['S'.repeat(501)]; }, (v) => { v.items[0].options = Array(51).fill('S'); },
    (v) => { v.items[0].options = [true]; },
    (v) => { v.items[0].options = [' ']; }, (v) => { v.items[0].missing_fields = ['SYNTHETIC']; },
    (v) => { v.item_count_matches_expected = false; }, (v) => { v.items = Array(101).fill(v.items[0]); },
    (v) => { v.missing_fields = ['SYNTHETIC-SECRET']; },
    (v) => { v.inventory_metadata.check_material_count = 1001; },
    (v) => { v.approval = { id: null, code: null, status: { code: 2, message: null }, status_meaning: 'approved' }; },
  ];
  for (const mutate of mutations) {
    const raw = previewFixture(); mutate(raw);
    assert.throws(() => parseMesDetailPreview(raw), { message: 'Invalid MES detail preview response' });
  }
});
test('missing and mismatched item counts remain unknown or false instead of assuming sixteen', () => {
  const missing = previewFixture(); missing.items = []; missing.item_count = null; missing.item_count_matches_expected = null;
  missing.missing_fields.push('items');
  assert.equal(parseMesDetailPreview(missing).item_count, null);
  const partial = previewFixture(); partial.items.pop(); partial.item_count = 15; partial.item_count_matches_expected = false;
  assert.equal(parseMesDetailPreview(partial).item_count_matches_expected, false);
  const empty = previewFixture(); empty.items = []; empty.item_count = 0; empty.item_count_matches_expected = false;
  assert.equal(parseMesDetailPreview(empty).item_count, 0);
});
test('nullable IDs/specifications and signed64-bit maximum survive without numeric conversion', () => {
  const data = previewFixture();
  Object.assign(data.items[0], { id: '9223372036854775807', version_id: null, check_item_id: null,
    minimum: null, maximum: '1000000000000000.000', base: '-0001.5000', scale: null });
  assert.deepEqual(parseMesDetailPreview(data).items[0], { ...data.items[0], missing_fields: ['check_item_id', 'version_id'] });
});
test('task and receipt enums stay separate; unknown codes ignore source wording', () => {
  assert.equal(previewLifecycle({ code: 1, message: 'SYNTHETIC' }, 'status', 'ko'), '진행 중 (1)');
  assert.equal(previewLifecycle({ code: 1, message: 'SYNTHETIC' }, 'get_status', 'ko'), '수령됨 (1)');
  assert.equal(previewLifecycle({ code: 2, message: 'approved' }, 'get_status', 'zh'), '未确认 (2)');
  assert.equal(previewLifecycle({ code: 99, message: 'completed' }, 'status', 'ko'), '미확인 (99)');
  assert.equal(previewLifecycle({ code: null, message: null }, 'status', 'zh'), '未确认 (—)');
});
test('metadata download revalidates scope and emits only the projection with a fixed filename', () => {
  const raw: any = previewFixture(); raw.provider_payload = 'SYNTHETIC-EXCLUDED'; raw.items[0].measurements = [99];
  const file = mesDetailPreviewDownload(raw);
  assert.equal(file.filename, 'wj-qc-detail-preview-QC-26100300323.json');
  assert.deepEqual(JSON.parse(file.contents), previewFixture());
  raw.qc_id = '90099';
  assert.throws(() => mesDetailPreviewDownload(raw), /Invalid MES detail preview response/);
});

test('a different executor is represented only by presence and mismatch flags', () => {
  const data = previewFixture(); data.executor_present = true; data.executor_matches_lee = false;
  const result = parseMesDetailPreview(data);
  assert.equal(result.executor_id, null);
  assert.equal(result.executor_matches_lee, false);
  assert.equal(result.executor_present, true);
});

test('missing options remain distinguishable from an observed empty options list in downloads', () => {
  const data = previewFixture(); data.items[0].options = []; data.items[0].missing_fields = ['options']; data.items[1].options = [];
  const result = JSON.parse(mesDetailPreviewDownload(data).contents);
  assert.deepEqual(result.items[0].missing_fields, ['options']);
  assert.deepEqual(result.items[1].missing_fields, []);
});

test('nullable item and approval IDs retain consistent missing markers in the downloaded projection', () => {
  const data = previewFixture();
  Object.assign(data.items[0], { check_item_id: null, version_id: null, options: [],
    missing_fields: ['options', 'check_item_id', 'version_id', 'unit.id'] });
  data.items[0].unit.id = null;
  data.approval = { id: null, code: null, status: { code: null, message: null }, status_meaning: 'unknown', missing_fields: ['id'] };
  data.missing_fields = ['executor_id', 'approval.id'];
  assert.deepEqual(JSON.parse(mesDetailPreviewDownload(data).contents), data);
});

test('legacy optional ID markers are safely derived while source values stay null', () => {
  const data: any = previewFixture();
  data.items[0].check_item_id = data.items[0].version_id = data.items[0].unit.id = null;
  data.approval = { id: null, code: 'SYNTHETIC', status: { code: null, message: null }, status_meaning: 'unknown', private_payload: 'SYNTHETIC-EXCLUDED' };
  data.missing_fields = ['executor_id'];
  const parsed = parseMesDetailPreview(data);
  assert.deepEqual(parsed.items[0].missing_fields, ['check_item_id', 'version_id', 'unit.id']);
  assert.deepEqual(parsed.approval?.missing_fields, ['id']);
  assert.ok(parsed.missing_fields.includes('approval.id'));
  assert.equal(JSON.stringify(parsed).includes('SYNTHETIC-EXCLUDED'), false);
  assert.deepEqual(data.items[0].missing_fields, [], 'parsing does not mutate the source response');
  assert.equal(data.approval.missing_fields, undefined);
  data.approval.id = '95001';
  assert.deepEqual(parseMesDetailPreview(data).approval?.missing_fields, []);
});

test('forged missing ID markers and unnormalized zero IDs are rejected', () => {
  const withApproval = () => {
    const data = previewFixture();
    data.approval = { id: '95001', code: null, status: { code: null, message: null }, status_meaning: 'unknown', missing_fields: [] };
    data.missing_fields = ['executor_id'];
    return data;
  };
  const mutations: ((data: any) => void)[] = [
    (v) => { v.items[0].missing_fields = ['check_item_id']; },
    (v) => { v.items[0].missing_fields = ['version_id']; },
    (v) => { v.items[0].missing_fields = ['unit.id']; },
    (v) => { v.items[0].missing_fields = ['options', 'options']; },
    (v) => { v.approval.missing_fields = ['id']; },
    (v) => { v.approval.id = null; },
    (v) => { v.approval.missing_fields = ['SYNTHETIC-PRIVATE']; },
    (v) => { v.approval.missing_fields = ['id', 'id']; },
    (v) => { v.missing_fields.push('approval.id'); },
    (v) => { v.approval = null; v.missing_fields.push('approval.id'); },
    (v) => { v.missing_fields.push('approval'); },
  ];
  for (const missing of [0, '0', true]) {
    mutations.push((v) => { v.items[0].check_item_id = missing; },
      (v) => { v.items[0].version_id = missing; }, (v) => { v.items[0].unit.id = missing; },
      (v) => { v.approval.id = missing; }, (v) => { v.executor_id = missing; });
  }
  for (const mutate of mutations) {
    const data = withApproval(); mutate(data);
    assert.throws(() => parseMesDetailPreview(data), { message: 'Invalid MES detail preview response' });
  }
});
