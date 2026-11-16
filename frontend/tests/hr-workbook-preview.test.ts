import assert from 'node:assert/strict';
import test from 'node:test';
import { workbookPreviewBlocker } from '../src/domains/hr/workbook-preview.ts';

const ready = {
  hasFiles: true, hasSelectedMonths: true, unknownEmployment: false, parseFailed: false,
  incompleteDecision: false, issueCount: 0, referenceReady: true, disabled: false, busy: false,
};

test('workbook validation reports the first actionable blocker and retains all existing guards', () => {
  const blockers = [
    ['busy', { busy: true }],
    ['disabled', { disabled: true }],
    ['reference', { referenceReady: false }],
    ['files', { hasFiles: false }],
    ['employment', { unknownEmployment: true }],
    ['parse', { parseFailed: true }],
    ['months', { hasSelectedMonths: false }],
    ['decision', { incompleteDecision: true }],
    ['issues', { issueCount: 3 }],
  ] as const;
  for (const [index, [reason, override]] of blockers.entries()) {
    assert.equal(workbookPreviewBlocker({ ...ready, ...override }), reason);
    assert.equal(workbookPreviewBlocker(Object.assign({}, ready, ...blockers.slice(index).map(([, state]) => state))), reason);
  }
  assert.equal(workbookPreviewBlocker(ready), null);
});
