import assert from 'node:assert/strict';
import test from 'node:test';
import { createInspectionKey, inspectionError, inspectionMutationAttempt, inspectionRecoveryKey, inspectionRequiresMesConnection, parseInspectionRecovery, safeInspectionEvidenceUrl } from '../src/pages/quality/inspection-requests/workflow.ts';
import { inspectionCreatePayload, inspectionDraftPayload } from '../src/pages/quality/inspection-requests/model.ts';
import { inspectionBusinessDate, inspectionDisplayPlans, inspectionElapsedMinutes, inspectionPlanAlignment, inspectionRequestKind, inspectionRequestStage, inspectionStageCounts, validateInspectionKanban } from '../src/pages/quality/inspection-requests/kanban.ts';
import type { InspectionKanban, InspectionPlan } from '../src/pages/quality/inspection-requests/kanban.ts';
import { injectionReadinessLabels, inspectionDataSourceCopy, inspectionMesObservationCopy, mesCompletionLabels, mesQcLabels } from '../src/pages/quality/inspection-requests/copy.ts';

test('data provenance distinguishes WJ beta, synthetic plans and requests, and unconfirmed responses', () => {
  const beta = inspectionDataSourceCopy('ko', 'wj_local_beta');
  assert.match(beta.notice, /WJ/);
  assert.doesNotMatch(beta.notice, /MES 미연결/);
  assert.match(beta.hint, /MES 반영 상태는 카드에서 확인/);
  assert.equal(beta.plans, 'WJ 생산계획');
  assert.equal(beta.requests, 'WJ 수동입력');
  for (const lang of ['ko', 'zh'] as const) {
    const preview = inspectionDataSourceCopy(lang, 'synthetic_preview');
    assert.notEqual(preview.plans, inspectionDataSourceCopy(lang, 'wj_local_beta').plans);
    assert.match(preview.plans, /합성|合成/);
    assert.match(preview.requests, /합성|合成/);
    assert.match(preview.notice, /MES 미연결|MES 未连接/);
    const pending = inspectionDataSourceCopy(lang);
    assert.match(pending.plans, /확인|确认/);
    assert.match(pending.requests, /확인|确认/);
  }
});

test('a retained completed/pass/ready observation never becomes current proof while reconciliation is locked', () => {
  const observed = {
    sync_status: 'succeeded', mes_completion_status: 'completed', injection_receipt_readiness: 'ready' as const,
    mes_checked_at: '2026-09-30T01:00:00Z',
    mes_state: { task_status: 2, qc_status: 1, state_version: 'prior-state', receipt_allowed: true },
  };
  const original = JSON.stringify(observed);
  // A local recovery latch can require reconciliation even when all retained server fields still look successful.
  for (const lang of ['ko', 'zh'] as const) {
    for (const request of [observed, { ...observed, sync_status: 'pending' }, { ...observed, mes_completion_status: 'unknown' }]) {
      const display = inspectionMesObservationCopy(lang, request, true);
      assert.notEqual(display.completion, mesCompletionLabels[lang].completed);
      assert.match(display.completion, /이전 관측|此前观测/);
      assert.ok(display.completion.includes(mesCompletionLabels[lang][request.mes_completion_status]));
      assert.notEqual(display.qc, mesQcLabels[lang][1]);
      assert.ok(String(display.qc).includes(mesQcLabels[lang][1]), 'preserve the old verdict as an explicitly previous observation');
      assert.equal(display.readiness, injectionReadinessLabels[lang].not_verified);
      assert.ok(display.priorReadiness?.includes(injectionReadinessLabels[lang].ready));
      assert.ok(display.hint.includes(display.checkedAt));
      assert.match(display.hint, /현재.*확인|当前.*确认/);
    }
    const missingTime = inspectionMesObservationCopy(lang, { ...observed, mes_checked_at: null }, true);
    assert.equal(missingTime.checkedAt, '—');
    assert.match(missingTime.completion, /대조 필요|需核对/);
    const resolved = inspectionMesObservationCopy(lang, observed, false);
    assert.equal(resolved.completion, mesCompletionLabels[lang].completed);
    assert.equal(resolved.qc, mesQcLabels[lang][1]);
    assert.equal(resolved.priorReadiness, null);
    for (const cause of [new Error('timeout'), { response: { status: 202, data: { code: 'operation_pending' } } }]) {
      const failure = inspectionError(cause, 'failed', 1);
      assert.equal(failure.uncertain, true);
      assert.equal(failure.reconciliation_required, false, 'unrecorded attempts retain the client retry lock rather than a durable operation latch');
      const uncertainDisplay = inspectionMesObservationCopy(lang, observed, failure.uncertain || failure.reconciliation_required);
      assert.match(uncertainDisplay.completion, /대조 필요|需核对/);
      assert.equal(uncertainDisplay.readiness, injectionReadinessLabels[lang].not_verified);
    }
  }
  assert.equal(JSON.stringify(observed), original, 'display qualification must not overwrite the source snapshot');
});

test('an observed pending QC verdict does not itself establish a receipt block or permission', () => {
  const observed = { sync_status: 'not_synced', mes_completion_status: 'not_completed', injection_receipt_readiness: 'not_verified' as const,
    mes_checked_at: '2026-09-30T01:00:00Z', mes_state: { task_status: 2, qc_status: 3, state_version: null, receipt_allowed: null } };
  for (const lang of ['ko', 'zh'] as const) {
    const display = inspectionMesObservationCopy(lang, observed, false);
    assert.equal(display.qc, mesQcLabels[lang][3]);
    assert.equal(display.readiness, injectionReadinessLabels[lang].not_verified);
  }
});

test('evidence excludes insecure and credential-bearing URLs', () => {
  assert.equal(safeInspectionEvidenceUrl('https://files.example.test/quality/result.pdf'), 'https://files.example.test/quality/result.pdf');
  for (const value of ['http://example.test/result', 'javascript:alert(1)', '//example.test/result', 'https://user:secret@example.test/result', 'https://example.test/result?token=secret', 'https://example.test/result#secret', 'https://localhost/result', 'https://127.0.0.1/result', ' https://example.test/result', 'invalid']) {
    assert.equal(safeInspectionEvidenceUrl(value), null, value);
  }
});

test('duplicate click or retry keeps the same idempotency key and immutable body', () => {
  let created = 0;
  const payload = { version: 4, results: [{ item_id: 'dimension', measurement: '1.2', verdict: 'pass' }] };
  const first = inspectionMutationAttempt(null, 'submit', payload, () => `key-${++created}`);
  payload.results[0].measurement = 'edited afterwards';
  assert.equal((first.payload.results as typeof payload.results)[0].measurement, '1.2');
  const retry = inspectionMutationAttempt(first, 'submit', { results: [{ verdict: 'pass', measurement: '1.2', item_id: 'dimension' }], version: 4 }, () => `key-${++created}`);
  assert.equal(retry, first);
  assert.equal(created, 1);
  const changed = inspectionMutationAttempt(first, 'submit', payload, () => `key-${++created}`);
  assert.notEqual(changed.key, first.key);
  assert.notEqual(inspectionMutationAttempt(first, 'save', first.payload, () => `key-${++created}`).key, first.key);
});

test('whole-snapshot stages retain the original digest or operation and never turn a changed stage into a retry', () => {
  let keys = 0;
  for (const action of ['mes-full-save', 'mes-full-finish', 'mes-full-reconcile'] as const) {
    const payload: Record<string, unknown> = action === 'mes-full-reconcile' ? { operation_id: 301 } : { source_digest: 'a'.repeat(64) };
    const first = inspectionMutationAttempt(null, action, payload, () => `SYNTHETIC-${++keys}`);
    const original = structuredClone(first.payload);
    payload[action === 'mes-full-reconcile' ? 'operation_id' : 'source_digest'] = action === 'mes-full-reconcile' ? 302 : 'b'.repeat(64);
    assert.deepEqual(first.payload, original, 'external caller edits cannot alter a reserved full-snapshot stage');
    assert.equal(inspectionMutationAttempt(first, action, original, () => `SYNTHETIC-${++keys}`), first);
    assert.notEqual(inspectionMutationAttempt(first, action, payload, () => `SYNTHETIC-${++keys}`).key, first.key);
    const otherAction = action === 'mes-full-save' ? 'mes-full-finish' : 'mes-full-save';
    assert.notEqual(inspectionMutationAttempt(first, otherAction, original, () => `SYNTHETIC-${++keys}`).key, first.key);
    const recovery = { schema: 1, user_id: 8, request_id: 5, version: 3, saved_at: 10_000, draft: { note: 'SYNTHETIC' }, attempt: { ...first, key: '11111111-1111-4111-8111-111111111111' } };
    const restored = parseInspectionRecovery(JSON.stringify(recovery), 8, 5, 90_000_000);
    assert.deepEqual(restored?.attempt, recovery.attempt, 'an unresolved full action survives draft expiry with its exact key and body');
    assert.equal(parseInspectionRecovery(JSON.stringify(recovery), 9, 5, 90_000_000), null);
  }
});

test('unreviewed whole-snapshot policy is a known pre-dispatch failure while an unrecorded 503 stays uncertain', () => {
  for (const code of ['whole_connection_review_required', 'remote_concurrency_unverified']) {
    assert.deepEqual(inspectionError({ response: { status: 503, data: { code, detail: 'SYNTHETIC policy unavailable' } } }, 'failed', 42), {
      conflict: false, uncertain: false, reconciliation_required: false, message: 'SYNTHETIC policy unavailable',
    });
  }
  assert.equal(inspectionError({ response: { status: 503, data: { code: 'SYNTHETIC unrecorded failure' } } }, 'failed', 42).uncertain, true);
});

test('UUID v4 generation supports browsers with getRandomValues and no randomUUID', () => {
  const key = createInspectionKey((bytes) => bytes.fill(0));
  assert.equal(key, '00000000-0000-4000-8000-000000000000');
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('network and server failures remain uncertain; conflict is explicit and draft is preserved', () => {
  const draft = { version: 2, measurement: 'unsaved' };
  const snapshot = JSON.stringify(draft);
  assert.deepEqual(inspectionError({ response: { status: 409, data: { detail: 'Version changed.' } } }, 'failed'), { conflict: true, uncertain: false, reconciliation_required: false, message: 'Version changed.' });
  assert.equal(inspectionError(new Error('timeout'), 'failed').uncertain, true);
  assert.equal(inspectionError({ response: { status: 502, data: '<html>proxy</html>' } }, 'failed').uncertain, true);
  assert.equal(inspectionError({ response: { status: 400, data: { evidence: ['HTTPS required'], credentials: 'never show' } } }, 'failed').message, 'evidence: HTTPS required');
  assert.equal(inspectionError({ response: { status: 400, data: { measurements: [{ value: ['Required'] }], work_order_ref: ['Required'] } } }, 'failed').message, 'measurements[1].value: Required\nwork_order_ref: Required');
  assert.equal(inspectionError({ response: { status: 503, data: { code: 'mes_contract_unverified' } } }, 'blocked').uncertain, false);
  const recordedUnknown = { response: { status: 503, data: { code: 'mes_outcome_unknown', operation_id: 42, request: { id: 1, sync_status: 'unknown' } } } };
  assert.equal(inspectionError(recordedUnknown, 'reconcile', 1).uncertain, false, 'a durable server unknown state requires reconciliation, not repeating an external write');
  assert.equal(inspectionError(recordedUnknown, 'reconcile', 1).reconciliation_required, true);
  assert.equal(inspectionError(recordedUnknown, 'reconcile', 2).uncertain, true, 'a different request cannot resolve this operation');
  assert.equal(JSON.stringify(draft), snapshot);
});

test('only a matching recorded pre-dispatch credential failure opens MES reconnect', () => {
  for (const [action, phase, sync] of [['mes-save', 'ready', 'not_synced'], ['mes-finish', 'saved', 'succeeded']] as const) {
    const current = { id: 1, version: 4, sync_status: sync, mes_completion_status: 'not_completed', mes_workflow: { phase } };
    const pending = inspectionMutationAttempt(null, action, { version: 4, reason: 'keep-local-reason' }, () => 'original-key');
    const updated = { ...current, version: 6, last_error_code: 'mes_connection_required' };
    const data = { code: 'mes_connection_required', operation_id: 42, request: updated };
    const response = { status: 503, data };
    assert.equal(inspectionRequiresMesConnection({ response }, pending, current), true);
    assert.equal(inspectionRequiresMesConnection({ response }, pending, { ...current, version: 6 }), true, 'a recovered attempt may replay the already-current blocked operation');
    assert.equal(inspectionRequiresMesConnection({ response }, pending, { ...current, version: 7 }), false, 'never roll back a newer request');
    for (const patch of [{ id: 2 }, { version: 4 }, { version: 6.5 }, { sync_status: 'unknown' }, { sync_status: 'pending' },
      { mes_completion_status: 'unknown' }, { mes_completion_status: 'completed' },
      { mes_workflow: { phase: 'save_unknown' } }, { mes_workflow: { phase: 'finish_pending' } }, { last_error_code: 'mes_outcome_unknown' }]) {
      assert.equal(inspectionRequiresMesConnection({ response: { ...response, data: { ...data, request: { ...updated, ...patch } } } }, pending, current), false);
    }
    for (const patch of [{ code: 'mes_outcome_unknown' }, { operation_id: 0 }, { operation_id: '42' }, { request: null }]) {
      assert.equal(inspectionRequiresMesConnection({ response: { ...response, data: { ...data, ...patch } } }, pending, current), false);
    }
    assert.equal(inspectionRequiresMesConnection({ response: { ...response, status: 502 } }, pending, current), false);
    assert.equal(inspectionRequiresMesConnection({ response }, { ...pending, action: 'mes-reconcile' }, current), false);
    const unknown = { response: { status: 503, data: { ...data, code: 'mes_outcome_unknown', request: { ...updated, sync_status: 'unknown' } } } };
    assert.equal(inspectionRequiresMesConnection(unknown, pending, current), false);
    const failure = inspectionError(unknown, 'failure', current.id);
    assert.equal(failure.uncertain, false, 'do not show the generic write-retry action for a recorded unknown result');
    assert.equal(failure.reconciliation_required, true);
    assert.equal(pending.key, 'original-key');
    assert.equal(pending.payload.reason, 'keep-local-reason');
  }
});

test('per-account per-request recovery keeps its original version and pending key', () => {
  const recovery = { schema: 1, user_id: 8, request_id: 5, version: 3, saved_at: 10_000, draft: { version: 3, note: 'local' }, attempt: { action: 'submit', payload: { version: 3 }, key: '11111111-1111-4111-8111-111111111111' } };
  const parsed = parseInspectionRecovery<typeof recovery.draft>(JSON.stringify(recovery), 8, 5, 11_000);
  assert.equal(parsed?.version, 3);
  assert.equal(parsed?.attempt?.key, recovery.attempt.key);
  assert.equal(parseInspectionRecovery(JSON.stringify(recovery), 9, 5, 11_000), null);
  assert.equal(parseInspectionRecovery(JSON.stringify(recovery), 8, 6, 11_000), null);
  assert.equal(parseInspectionRecovery(JSON.stringify({ ...recovery, attempt: null }), 8, 5, 90_000_000), null);
  assert.equal(parseInspectionRecovery(JSON.stringify(recovery), 8, 5, 90_000_000)?.attempt?.key, recovery.attempt.key, 'an unresolved request must retain its key even after the draft expiry');
  assert.notEqual(inspectionRecoveryKey(8, 5), inspectionRecoveryKey(9, 5));
});

test('HTTP 202 remains pending and only a matching durable server operation releases the client retry lock', () => {
  const pending = { response: { status: 202, data: { code: 'operation_pending', detail: 'Still pending; refresh state.', operation_id: 42, request: { id: 1, version: 8, sync_status: 'pending' } } } };
  assert.deepEqual(inspectionError(pending, 'failed', 1), { conflict: false, uncertain: false, reconciliation_required: true, message: 'Still pending; refresh state.' });
  assert.equal(inspectionError(pending, 'failed', 2).uncertain, true);
  assert.equal(inspectionError({ response: { status: 202, data: { code: 'operation_pending' } } }, 'failed', 1).uncertain, true);
});

test('a durable refresh failure keeps reconciliation required even when prior request state looks completed', () => {
  for (const [status, code] of [[202, 'operation_pending'], [503, 'mes_outcome_unknown']] as const) {
    const prior = { id: 1, sync_status: 'succeeded', mes_completion_status: 'completed' };
    const failure = inspectionError({ response: { status, data: { code, operation_id: 42, request: prior } } }, 'reconcile', 1);
    assert.equal(failure.uncertain, false, 'the matching durable operation replaces a client retransmission attempt');
    assert.equal(failure.reconciliation_required, true, 'its outcome still requires a scoped MES observation');
    for (const operationId of [0, -1, 1.5, '42', Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = inspectionError({ response: { status, data: { code, operation_id: operationId, request: prior } } }, 'failed', 1);
      assert.equal(invalid.uncertain, true);
      assert.equal(invalid.reconciliation_required, false);
    }
    assert.equal(inspectionError({ response: { status, data: { code, operation_id: 42, request: prior } } }, 'failed', 2).reconciliation_required, false);
  }
});

test('reconciliation recovery survives expiry, is account scoped, and rejects an untyped latch', () => {
  const durable = { schema: 1, user_id: 8, request_id: 5, version: 3, saved_at: 10_000, draft: { note: 'local' }, attempt: null, reconciliation_required: true };
  assert.equal(parseInspectionRecovery(JSON.stringify(durable), 8, 5, 90_000_000)?.reconciliation_required, true);
  assert.equal(parseInspectionRecovery(JSON.stringify(durable), 9, 5, 90_000_000), null);
  assert.equal(parseInspectionRecovery(JSON.stringify(durable), 8, 6, 90_000_000), null);
  assert.equal(parseInspectionRecovery(JSON.stringify({ ...durable, reconciliation_required: 'true' }), 8, 5, 11_000), null);
  assert.equal(parseInspectionRecovery(JSON.stringify({ ...durable, reconciliation_required: false }), 8, 5, 90_000_000), null);
});

test('creation and draft payloads exclude actors, state, operation keys and immutable fields', () => {
  const create = { work_order_ref: ' WO ', task_ref: 'T', part_no: 'P', equipment_ref: 'E', inspection_type: 'first' as const, target_quantity: '10.000', uom: 'PCS', warehouse_ref: 'W', lot_ref: 'L', work_started_at: '2026-09-01T00:00:00Z', inspection_items: [{ id: 'a', label: ' Appearance ', kind: 'text' as const, unit: '', required: false, evidence_required: false, actor: 'spoofed' }], require_evidence: false, quantity_mode: 'not_recorded' as const, judgement_policy: 'independent' as const, status: 'approved', submitted_by: 100 };
  const payload = inspectionCreatePayload(create);
  assert.equal(payload.work_order_ref, 'WO');
  assert.equal('status' in payload, false);
  assert.equal('submitted_by' in payload, false);
  assert.deepEqual(payload.inspection_items, [{ id: 'a', label: 'Appearance', kind: 'text', unit: '', required: false, evidence_required: false }]);
  assert.equal(payload.require_evidence, false);
  assert.equal(payload.quantity_mode, 'not_recorded');
  assert.equal(payload.judgement_policy, 'independent');
  const choice = inspectionCreatePayload({ ...create, inspection_items: [{ id: 'c', label: 'Surface', kind: 'choice', options: [' smooth ', ' rough '], unit: '', required: false, evidence_required: false, minimum: '10' }] });
  assert.deepEqual(choice.inspection_items, [{ id: 'c', label: 'Surface', kind: 'choice', options: ['smooth', 'rough'], unit: '', required: false, evidence_required: false }]);
  const draft = { measurements: [{ item_id: 'a', value: ' smooth ', judgement: 'pass' as const, evidence_url: '', actor: 'spoofed' }], evidence: [{ label: ' photo ', url: 'https://example.test/photo', token: 'secret' }], inspected_quantity: '1.000', accepted_quantity: '1.000', rejected_quantity: '0.000', judgement: 'pass' as const, notes: ' done ', work_order_ref: 'cannot change', actor: 'cannot spoof' };
  const changed = inspectionDraftPayload(draft, 7);
  assert.equal(changed.version, 7);
  assert.equal('work_order_ref' in changed, false);
  assert.equal('actor' in changed, false);
  assert.deepEqual(changed.measurements, [{ item_id: 'a', value: 'smooth', judgement: 'pass', evidence_url: '' }]);
  assert.deepEqual(changed.evidence, [{ label: 'photo', url: 'https://example.test/photo' }]);
  const unrecorded = inspectionDraftPayload(draft, 7, 'not_recorded');
  assert.deepEqual([unrecorded.inspected_quantity, unrecorded.accepted_quantity, unrecorded.rejected_quantity], ['0', '0', '0']);
});

const waitingRequest: Parameters<typeof inspectionRequestStage>[0] = {
  status: 'draft', sync_status: 'not_synced', mes_completion_status: 'not_completed', mes_checked_at: null,
  judgement: '', notes: '', measurements: [], evidence: [],
};
const completedRequest: Parameters<typeof inspectionRequestStage>[0] = {
  ...waitingRequest, status: 'approved', sync_status: 'succeeded', mes_completion_status: 'completed',
  mes_checked_at: '2026-09-30T01:00:00Z', mes_state: { qc_status: 1 },
};

test('Shanghai production date rolls over at 08:00 and survives month/year boundaries', () => {
  assert.equal(inspectionBusinessDate(new Date('2026-09-29T23:59:59Z')), '2026-09-29');
  assert.equal(inspectionBusinessDate(new Date('2026-09-30T00:00:00Z')), '2026-09-30');
  assert.equal(inspectionBusinessDate(new Date('2026-09-30T07:59:59+08:00')), '2026-09-29');
  assert.equal(inspectionBusinessDate(new Date('2026-09-30T08:00:00+08:00')), '2026-09-30');
  assert.equal(inspectionBusinessDate(new Date('2027-01-01T07:00:00+08:00')), '2026-12-31');
  assert.equal(inspectionBusinessDate(new Date('2028-03-01T07:00:00+08:00')), '2028-02-29');
});

test('request elapsed time retains previous-day waits and handles bad/future timestamps', () => {
  const now = new Date('2026-09-30T02:45:00Z');
  assert.equal(inspectionElapsedMinutes('2026-09-29T02:44:30Z', now), 1440);
  assert.equal(inspectionElapsedMinutes('2026-09-30T10:00:00+08:00', now), 45);
  assert.equal(inspectionElapsedMinutes('2026-09-30T03:00:00Z', now), 0);
  assert.equal(inspectionElapsedMinutes('not a time', now), null);
});

test('WJ draft content and submission are in progress; local approval never establishes MES completion', () => {
  assert.equal(inspectionRequestStage(waitingRequest), 'waiting');
  assert.equal(inspectionRequestStage({ ...waitingRequest, mes_state: { qc_status: 3 } }), 'waiting', 'normal MES 待检 remains actionable waiting, not an error');
  assert.equal(inspectionRequestStage({ ...waitingRequest, notes: 'checked' }), 'in_progress');
  assert.equal(inspectionRequestStage({ ...waitingRequest, inspected_quantity: '2.000' }), 'in_progress');
  assert.equal(inspectionRequestStage({ ...waitingRequest, inspected_quantity: '0.000' }), 'waiting');
  assert.equal(inspectionRequestStage({ ...waitingRequest, measurements: [{ item_id: 'a', value: '1.2', judgement: '' }] }), 'in_progress');
  assert.equal(inspectionRequestStage({ ...waitingRequest, status: 'submitted' }), 'in_progress');
  assert.equal(inspectionRequestStage({ ...waitingRequest, status: 'approved' }), 'in_progress');
  assert.equal(inspectionRequestStage(completedRequest), 'completed');
});

test('completed stage requires resolved observed MES pass; NG, concession, conflicts and unknowns remain distinct', () => {
  for (const status of ['failed', 'rejected'] as const) assert.equal(inspectionRequestStage({ ...completedRequest, status }), 'blocked');
  for (const sync_status of ['unknown', 'stale', 'blocked', 'failed', 'not_synced']) assert.equal(inspectionRequestStage({ ...completedRequest, sync_status }), 'blocked');
  assert.equal(inspectionRequestStage({ ...completedRequest, sync_status: 'pending' }), 'in_progress');
  assert.equal(inspectionRequestStage({ ...completedRequest, mes_checked_at: null }), 'blocked');
  assert.equal(inspectionRequestStage({ ...completedRequest, mes_checked_at: 'invalid' }), 'blocked');
  for (const qc_status of [null, 2, 3, 4]) assert.equal(inspectionRequestStage({ ...completedRequest, mes_state: { qc_status } }), 'blocked');
  assert.equal(inspectionRequestStage({ ...completedRequest, mes_state: undefined }), 'blocked');
  for (const mes_completion_status of ['unknown', 'blocked', 'cancelled', 'rejected']) assert.equal(inspectionRequestStage({ ...waitingRequest, mes_completion_status }), 'blocked');
});

test('machine summary counts every first/process/final/reinspection request, including older blocked parents', () => {
  assert.deepEqual(inspectionStageCounts([waitingRequest, waitingRequest, { ...waitingRequest, status: 'submitted' }, completedRequest, { ...waitingRequest, status: 'failed' }]), { waiting: 2, in_progress: 1, completed: 1, blocked: 1 });
  assert.equal(inspectionRequestKind({ parent: null, inspection_type: 'first' }), 'first');
  assert.equal(inspectionRequestKind({ parent: null, inspection_type: 'process' }), 'process');
  assert.equal(inspectionRequestKind({ parent: null, inspection_type: 'final' }), 'final');
  assert.equal(inspectionRequestKind({ parent: 7, inspection_type: 'first' }), 'reinspection');
});

test('newer unknown or stale MES errors invalidate old completed card and summary fields', () => {
  for (const last_error_code of ['mes_outcome_unknown', 'stale_remote_observation']) {
    const staleCompletion = { ...completedRequest, last_error_code };
    assert.equal(inspectionRequestStage(staleCompletion), 'blocked');
    assert.deepEqual(inspectionStageCounts([staleCompletion]), { waiting: 0, in_progress: 0, completed: 0, blocked: 1 });
  }
});

test('display alignment remains unknown without server evidence and never verifies task binding', () => {
  assert.equal(inspectionPlanAlignment({}), 'unknown');
  for (const status of ['part_listed', 'part_not_listed', 'unknown'] as const) {
    const request = { plan_alignment: { status, matching_plan_ids: [13], task_binding_verified: false as const } };
    assert.equal(inspectionPlanAlignment(request), status);
    assert.equal(request.plan_alignment.task_binding_verified, false);
  }
});

test('plan display puts recorded running work first, retains every scheduled plan and does not alter source order', () => {
  const plan = (id: number, sequence: number, execution_status: string | null): InspectionPlan => ({ id, sequence, execution_status, machine_name: 'imm02', part_no: `P${id}`, lot_no: '', planned_quantity: '10', updated_at: '2026-09-30T00:00:00Z' });
  const source = [plan(1, 1, null), plan(2, 3, 'running'), plan(3, 2, 'paused')];
  assert.deepEqual(inspectionDisplayPlans(source).map((row) => row.id), [2, 1, 3]);
  assert.deepEqual(source.map((row) => row.id), [1, 2, 3]);
});

test('multiple old running records on one machine are retained alongside its other plans', () => {
  const plans: InspectionPlan[] = [
    { id: 1, sequence: 1, execution_status: 'running', machine_name: 'imm02', part_no: 'OLD-1', lot_no: 'L1', planned_quantity: '10', updated_at: '2026-01-01T00:00:00Z' },
    { id: 2, sequence: 2, execution_status: 'running', machine_name: 'imm02', part_no: 'OLD-2', lot_no: 'L2', planned_quantity: '20', updated_at: '2026-02-01T00:00:00Z' },
    { id: 3, sequence: 3, execution_status: null, machine_name: 'imm02', part_no: 'SCHEDULED', lot_no: 'L3', planned_quantity: '30', updated_at: '2026-10-03T00:00:00Z' },
  ];
  const original = JSON.stringify(plans);
  const displayed = inspectionDisplayPlans(plans);
  assert.deepEqual(displayed.map((row) => row.id).sort(), [1, 2, 3]);
  assert.equal(displayed.filter((row) => row.execution_status === 'running').length, 2, 'a running record does not select a single current physical task');
  assert.equal(JSON.stringify(plans), original);
});

test('kanban rejects the wrong day and incomplete or duplicated machine identities without a fabricated fallback', () => {
  const response = { schema_version: 'inspection-kanban.v1', business_date: '2026-09-30', machines: Array.from({ length: 17 }, (_, index) => ({ machine_number: index + 1 })) } as InspectionKanban;
  assert.equal(validateInspectionKanban(response, '2026-09-30'), response);
  assert.throws(() => validateInspectionKanban(response, '2026-09-29'), /identity mismatch/);
  assert.throws(() => validateInspectionKanban({ ...response, machines: response.machines.slice(1) }, '2026-09-30'), /identity mismatch/);
  assert.throws(() => validateInspectionKanban({ ...response, machines: response.machines.map((row) => ({ ...row, machine_number: 1 })) }, '2026-09-30'), /identity mismatch/);
});
