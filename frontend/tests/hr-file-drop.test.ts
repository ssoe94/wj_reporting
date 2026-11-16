import assert from 'node:assert/strict';
import test from 'node:test';
import { filterHrFiles, isHrFileDrag } from '../src/domains/hr/file-drop.ts';

const workbookPolicy = { extensions: ['.xlsx'], maxFiles: 10 };
const mappedPolicy = { extensions: ['.xlsx', '.csv', '.tsv', '.txt'], maxFiles: 1 };

test('payroll accepts ten XLSX files regardless of case and rejects the whole batch with an unsupported file', () => {
  const files = Array.from({ length: 10 }, (_, index) => ({ name: `synthetic-${index}.XLSX` }));
  assert.deepEqual(filterHrFiles(files, workbookPolicy), { status: 'accepted', files });
  assert.deepEqual(filterHrFiles([...files.slice(1), { name: 'synthetic.xlsx.txt' }], workbookPolicy), { status: 'extension' });
  assert.deepEqual(filterHrFiles([...files, { name: 'too-many.xlsx' }], workbookPolicy), { status: 'count' });
  assert.deepEqual(filterHrFiles(files, { ...workbookPolicy, existingFiles: 1 }), { status: 'count' });
});

test('single upload accepts one supported document and reference upload accepts only one XLSX', () => {
  for (const extension of mappedPolicy.extensions) {
    const file = { name: `synthetic${extension.toUpperCase()}` };
    assert.deepEqual(filterHrFiles([file], mappedPolicy), { status: 'accepted', files: [file] });
  }
  const reference = { ...workbookPolicy, maxFiles: 1 };
  assert.deepEqual(filterHrFiles([{ name: 'synthetic.csv' }], reference), { status: 'extension' });
  assert.deepEqual(filterHrFiles([{ name: 'one.xlsx' }, { name: 'two.xlsx' }], reference), { status: 'count' });
});

test('disabled selections never accept files, and non-file transfers are ignored', () => {
  const personCard = { kind: 'string', name: 'person.xlsx' };
  const disabled = { ...mappedPolicy, disabled: true };
  assert.deepEqual(filterHrFiles([personCard, null], disabled), { status: 'ignored' });
  assert.deepEqual(filterHrFiles([{ name: 'synthetic.xlsx' }], disabled), { status: 'disabled' });
  assert.deepEqual(filterHrFiles([personCard, { name: 'synthetic.xlsx' }], mappedPolicy), {
    status: 'accepted', files: [{ name: 'synthetic.xlsx' }],
  });
  const files = Object.assign([], { item: () => null });
  assert.equal(isHrFileDrag({ types: ['text/plain', 'application/x-hr-employee'], files }), false);
  assert.equal(isHrFileDrag({ types: ['Files'], files }), true);
  assert.equal(isHrFileDrag(null), false);
});
