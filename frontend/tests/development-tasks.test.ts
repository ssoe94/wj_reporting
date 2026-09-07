import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checklistProgress, filterDevelopmentTasks, nextDevelopmentTask, pendingHumanRequirements, safeDevelopmentTaskUrl,
  developmentTaskCompletionIssues, developmentTaskPayload, editableTaskFields, formatDevelopmentTaskError, newDevelopmentTask,
  developmentTaskRecoveryKey, parseDevelopmentTaskRecovery, type DevelopmentTask, type DevelopmentTaskRecovery,
} from '../src/pages/development/developmentTasks.ts';

function task(overrides: Partial<DevelopmentTask> = {}): DevelopmentTask {
  return {
    slug: 'evidence', title: '관측 근거 보존', title_zh: '保留观测依据', objective: '압축 전후 판정 검증',
    phase: 1, priority: 'P1', status: 'planned', owner: '품질 역할 제안', due_date: null,
    dependencies: [], requirements: [], checklist: [], locations: [], completion_note: '', verification_note: '',
    release_state: 'unreleased', sort_order: 10, version: 0, updated_at: null, completed_at: null, ...overrides,
  };
}

test('only unfinished human and decision requirements count as requests; MES requirements do not', () => {
  const item = task({ requirements: [
    { id: 'mes', kind: 'mes', text: 'MES count', status: 'needed', evidence: '' },
    { id: 'human', kind: 'human', text: '现场原件', status: 'requested', evidence: '' },
    { id: 'decision', kind: 'decision', text: '보존 기간 결정', status: 'needed', evidence: '' },
    { id: 'ready', kind: 'human', text: 'confirmed', status: 'ready', evidence: '원본 확인' },
  ] });
  assert.deepEqual(pendingHumanRequirements(item).map((requirement) => requirement.id), ['human', 'decision']);
  assert.equal(filterDevelopmentTasks([item], 'human', '').length, 1);
  assert.equal(filterDevelopmentTasks([{ ...item, status: 'done' }], 'human', '').length, 0);
  assert.equal(filterDevelopmentTasks([task({ requirements: [item.requirements[0]] })], 'human', '').length, 0);
});

test('mutation payload whitelists top-level and nested fields and distinguishes create from versioned updates', () => {
  const source = { ...task({ version: 7, locations: [{ kind: 'screen', url: '/quality/analysis', label: '분석', note: 'display only' }], checklist: [{ id: 'verify', text: '원본 확인', done: false }] }),
    actor: 'spoofed', is_superuser: true, created_at: 'not writable',
  };
  const created = developmentTaskPayload(source, true, 'unused');
  const changed = developmentTaskPayload(source, false, '  원본 대조 완료  ');
  assert.equal('slug' in created && created.slug, 'evidence');
  assert.equal('version' in created, false);
  assert.equal('change_note' in created, false);
  assert.equal('slug' in changed, false);
  assert.equal('version' in changed && changed.version, 7);
  assert.equal('change_note' in changed && changed.change_note, '원본 대조 완료');
  for (const field of ['actor', 'is_superuser', 'created_at', 'updated_at', 'completed_at']) assert.equal(field in changed, false);
  assert.deepEqual(changed.locations, [{ kind: 'screen', url: '/quality/analysis', label: '분석' }]);
  const editable = editableTaskFields(source);
  editable.checklist[0].done = true;
  editable.dependencies.push('other');
  assert.equal(source.checklist[0].done, false);
  assert.deepEqual(source.dependencies, []);
});

test('completion requires confirmed checklist, evidenced requirements, ownership, verification and finished dependencies', () => {
  const completed = task({ status: 'done', owner: '품질 담당', checklist: [{ id: 'verify', text: '확인', done: true }],
    requirements: [{ id: 'raw', kind: 'mes', text: 'MES 원본', status: 'ready', evidence: '대조 기록' }],
    completion_note: '구현 완료', verification_note: '대표 사례 검증', locations: [{ kind: 'screen', url: '/quality/analysis', label: '품질 분석' }],
    dependencies: ['basis'],
  });
  const basis = task({ slug: 'basis', status: 'done' });
  assert.deepEqual(developmentTaskCompletionIssues(completed, [basis]), []);
  assert.deepEqual(developmentTaskCompletionIssues(completed, []), ['dependencies']);
  assert.deepEqual(developmentTaskCompletionIssues({ ...completed, requirements: [{ ...completed.requirements[0], evidence: ' ' }] }, [basis]), ['requirements']);
  assert.deepEqual(developmentTaskCompletionIssues({ ...completed, checklist: [] }, [basis]), ['checklist']);
  assert.deepEqual(developmentTaskCompletionIssues({ ...completed, locations: [{ kind: 'screen', url: 'https://example.com', label: 'external screen' }] }, [basis]), ['locations']);
  assert.deepEqual(developmentTaskCompletionIssues({ ...completed, dependencies: ['evidence'] }, [{ ...completed, status: 'done' }]), ['dependencies']);
  assert.deepEqual(developmentTaskCompletionIssues(newDevelopmentTask(10010), []), ['checklist', 'owner', 'completion_note', 'verification_note', 'locations']);
  assert.equal(newDevelopmentTask(10010).sort_order, 10000);
});

test('server validation details remain visible, and conflict classification does not mutate a draft', () => {
  const draft = task({ objective: 'unsaved local work', version: 2 });
  const snapshot = JSON.stringify(draft);
  assert.deepEqual(formatDevelopmentTaskError({ response: { status: 409, data: { detail: '다른 변경이 저장되었습니다.' } } }, 'fallback'), {
    conflict: true, message: '다른 변경이 저장되었습니다.',
  });
  assert.deepEqual(formatDevelopmentTaskError({ response: { status: 400, data: { requirements: [{ evidence: ['확인 근거를 적어 주세요.'] }], title: ['필수입니다.'] } } }, 'fallback'), {
    conflict: false, message: 'requirements[1].evidence: 확인 근거를 적어 주세요.\ntitle: 필수입니다.',
  });
  assert.deepEqual(formatDevelopmentTaskError({ response: { status: 502, data: '<html>proxy error</html>' } }, '다시 시도해 주세요.'), {
    conflict: false, message: '다시 시도해 주세요.',
  });
  assert.equal(JSON.stringify(draft), snapshot);
});

test('temporary recovery is scoped to the same user, task and original server version without upgrading the version', () => {
  const original = task({ version: 7 });
  const draft = { ...original, title: '아직 저장하지 않은 제목' };
  const recovery: DevelopmentTaskRecovery = { schema: 1, user_id: 12, username: 'reviewer', slug: draft.slug,
    base_version: 7, saved_at: 100_000, original, draft, is_new: false, change_note: '원본 확인 중',
  };
  const parsed = parseDevelopmentTaskRecovery(JSON.stringify(recovery), 12, 'reviewer', 101_000);
  assert.equal(parsed?.draft.title, draft.title);
  assert.equal(parsed?.draft.version, 7, 'recovery keeps the original version so a newer server save still conflicts');
  assert.equal(parsed?.original?.title, original.title);
  assert.equal(parsed?.change_note, recovery.change_note);
  assert.notEqual(developmentTaskRecoveryKey(12, 'reviewer'), developmentTaskRecoveryKey(13, 'reviewer'));
  assert.notEqual(developmentTaskRecoveryKey(12, 'reviewer'), developmentTaskRecoveryKey(12, 'other'));
  assert.equal(parseDevelopmentTaskRecovery(JSON.stringify(recovery), 13, 'reviewer', 101_000), null);
  assert.equal(parseDevelopmentTaskRecovery(JSON.stringify(recovery), 12, 'other', 101_000), null);
  assert.equal(parseDevelopmentTaskRecovery(JSON.stringify({ ...recovery, base_version: 8 }), 12, 'reviewer', 101_000), null);
  assert.equal(parseDevelopmentTaskRecovery(JSON.stringify({ ...recovery, slug: 'another-task' }), 12, 'reviewer', 101_000), null);
});

test('temporary recovery rejects expired or malformed data and strips noneditable nested metadata', () => {
  const draft = newDevelopmentTask(10);
  const value: DevelopmentTaskRecovery = { schema: 1, user_id: 12, username: 'reviewer', slug: '', base_version: 0,
    saved_at: 100_000, original: null, draft, is_new: true, change_note: '',
  };
  assert.ok(parseDevelopmentTaskRecovery(JSON.stringify(value), 12, 'reviewer', 101_000));
  assert.equal(parseDevelopmentTaskRecovery(JSON.stringify(value), 12, 'reviewer', 100_000 + 86_400_001), null);
  assert.equal(parseDevelopmentTaskRecovery(JSON.stringify(value), 12, 'reviewer', 0), null);
  assert.equal(parseDevelopmentTaskRecovery('{not json', 12, 'reviewer', 101_000), null);
  assert.equal(parseDevelopmentTaskRecovery(JSON.stringify({ ...value, draft: { ...draft, checklist: [{ done: 'true' }] } }), 12, 'reviewer', 101_000), null);
  assert.equal(parseDevelopmentTaskRecovery(JSON.stringify({ ...value, original: task() }), 12, 'reviewer', 101_000), null);
  const unexpected = { ...value, draft: { ...draft, actor: 'forged', locations: [{ kind: 'screen', url: '/quality/analysis', label: '품질', note: { bad: 'shape' } }] } };
  const parsed = parseDevelopmentTaskRecovery(JSON.stringify(unexpected), 12, 'reviewer', 101_000);
  assert.ok(parsed);
  assert.equal('actor' in parsed.draft, false);
  assert.equal('note' in parsed.draft.locations[0], false);
});

test('status filters intersect search over bilingual titles, roles and requirement evidence', () => {
  const ready = task({ slug: 'ready', status: 'review', requirements: [{ id: 'raw', kind: 'mes', text: 'raw data', status: 'ready', evidence: 'Watermark 123' }] });
  const active = task({ slug: 'active', sort_order: 5, status: 'in_progress' });
  const blocked = task({ slug: 'blocked', sort_order: 7, status: 'blocked' });
  const finished = task({ slug: 'done', status: 'done' });
  const items = [ready, finished, active, blocked];
  assert.deepEqual(filterDevelopmentTasks(items, 'active', '품질').map((item) => item.slug), ['active', 'blocked']);
  assert.deepEqual(filterDevelopmentTasks(items, 'review', ' watermark 123 ').map((item) => item.slug), ['ready']);
  assert.equal(filterDevelopmentTasks(items, 'all', '保留观测').length, 4);
  assert.equal(filterDevelopmentTasks(items, 'done', 'missing').length, 0);
  assert.deepEqual(items.map((item) => item.slug), ['ready', 'done', 'active', 'blocked'], 'sorting must not mutate the response');
});

test('checklist progress comes from explicit confirmations, never task status or code availability', () => {
  assert.deepEqual(checklistProgress(task({ status: 'done', release_state: 'code_available' })), { done: 0, total: 0, percent: 0 });
  assert.deepEqual(checklistProgress(task({ checklist: [
    { id: 'one', text: 'verified', done: true }, { id: 'two', text: 'pending', done: false }, { id: 'three', text: 'pending', done: false },
  ] })), { done: 1, total: 3, percent: 33 });
});

test('next task honors unresolved and missing prerequisites; an independent design may proceed during review', () => {
  const reviewing = task({ slug: 'review', status: 'review' });
  const dependent = task({ slug: 'dependent', dependencies: ['review'], sort_order: 20 });
  const independent = task({ slug: 'independent', sort_order: 30 });
  assert.equal(nextDevelopmentTask([dependent, independent, reviewing])?.slug, 'independent');
  assert.equal(nextDevelopmentTask([{ ...reviewing, status: 'done' }, dependent, independent])?.slug, 'dependent');
  assert.equal(nextDevelopmentTask([task({ dependencies: ['missing'] })]), null);
  assert.equal(nextDevelopmentTask([reviewing]), null);
  assert.equal(nextDevelopmentTask([independent, task({ slug: 'working', status: 'in_progress', sort_order: 99 })])?.slug, 'working');
});

test('reference links accept internal paths and ordinary HTTPS without credential-bearing or executable URLs', () => {
  for (const url of ['/quality/analysis', '/quality/analysis?machine=IMM01#trend', 'https://github.com/ssoe94/wj_reporting/blob/main/docs/reviews.md']) {
    assert.equal(safeDevelopmentTaskUrl(url), url);
  }
  for (const url of ['', 'javascript:alert(1)', 'data:text/html,test', '//evil.example/path', 'https:///evil.example', 'https:/evil.example',
    'http://evil.example', 'https://user:password@example.com', 'https://user@example.com', 'https://@example.com',
    '/\\evil.example', 'https://good.example\\@evil.example', ' /quality', '/qua lity', '/%0aevil', '/%5cevil',
    'https://', 'https://[invalid]', 'https://example.com:invalid', 'https://example.com/with\nnewline']) {
    assert.equal(safeDevelopmentTaskUrl(url), null, url);
  }
});
