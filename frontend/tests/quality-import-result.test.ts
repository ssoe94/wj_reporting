import assert from 'node:assert/strict';
import test from 'node:test';

import { combineQualityImportResults, createQualityImportChunks } from '../src/pages/quality/importResult.ts';
import type {
  QualityExcelImportPreview,
  QualityExcelImportResult,
  QualityWorkbookManifest,
} from '../src/pages/quality/importTypes.ts';

test('September result updates are committed and counted separately from new rows', () => {
  const row = {
    row_key: 'september-row',
    sheet_name: '9月',
    source_row_number: 3,
    source_sequence: '1',
    report_id: 12,
    report_date: '2026-09-03',
    media_keys: [],
    images_found: 0,
    images_saved: 0,
  };
  const preview = {
    filename: '品质 Issue List - 9月.xlsx',
    total_rows: 1,
    new_count: 0,
    update_result_count: 1,
    unchanged_count: 0,
    changed_count: 0,
    failed_count: 0,
    images_found: 0,
    images_to_upload: 0,
    images_ignored: 0,
    warnings: [],
    rows: [{ ...row, status: 'update_result' }],
  } as unknown as QualityExcelImportPreview;
  const manifest = { media: [] } as unknown as QualityWorkbookManifest;
  assert.deepEqual(createQualityImportChunks(preview, manifest), [
    { rowKeys: ['september-row'], mediaKeys: [] },
  ]);

  const commit = {
    filename: preview.filename,
    total_rows: 1,
    created_count: 0,
    updated_count: 1,
    skipped_count: 0,
    changed_count: 0,
    failed_count: 0,
    images_found: 0,
    images_saved: 0,
    images_failed: 0,
    images_ignored: 0,
    images_skipped: 0,
    created_report_ids: [],
    updated_report_ids: [12],
    skipped_report_ids: [],
    changed_report_ids: [],
    warnings: [],
    rows: [{ ...row, status: 'updated' }],
  } as unknown as QualityExcelImportResult;
  const combined = combineQualityImportResults(preview, [commit]);

  assert.equal(combined.updated_count, 1);
  assert.equal(combined.created_count, 0);
  assert.equal(combined.rows.length, 1);
  assert.deepEqual(combined.updated_report_ids, [12]);
});
