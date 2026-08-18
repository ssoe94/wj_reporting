import type {
  QualityExcelImportPreview,
  QualityExcelImportResult,
  QualityExcelImportRowResult,
  QualityExcelImportRowStatus,
  QualityWorkbookManifest,
} from './importTypes';

const MAX_ROWS_PER_COMMIT = 10;
const MAX_MEDIA_PER_COMMIT = 10;
const MAX_MEDIA_BYTES_PER_COMMIT = 20 * 1024 * 1024;

export interface QualityImportCommitChunk {
  rowKeys: string[];
  mediaKeys: string[];
}

export interface CombineQualityImportResultsOptions {
  includeUnprocessedNewAsFailed?: boolean;
  unprocessedMessage?: string;
}

export function createQualityImportChunks(
  preview: QualityExcelImportPreview,
  manifest: QualityWorkbookManifest,
): QualityImportCommitChunk[] {
  const mediaSizes = new Map(manifest.media.map((item) => [item.key, item.byte_size]));
  const chunks: QualityImportCommitChunk[] = [];
  let current: QualityImportCommitChunk = { rowKeys: [], mediaKeys: [] };
  let currentBytes = 0;

  for (const row of preview.rows.filter((item) => item.status === 'new')) {
    const rowBytes = row.media_keys.reduce((total, key) => total + (mediaSizes.get(key) || 0), 0);
    const exceedsCurrent = current.rowKeys.length > 0 && (
      current.rowKeys.length >= MAX_ROWS_PER_COMMIT
      || current.mediaKeys.length + row.media_keys.length > MAX_MEDIA_PER_COMMIT
      || currentBytes + rowBytes > MAX_MEDIA_BYTES_PER_COMMIT
    );
    if (exceedsCurrent) {
      chunks.push(current);
      current = { rowKeys: [], mediaKeys: [] };
      currentBytes = 0;
    }
    current.rowKeys.push(row.row_key);
    current.mediaKeys.push(...row.media_keys);
    currentBytes += rowBytes;
  }
  if (current.rowKeys.length > 0) chunks.push(current);
  // Even a workbook with no new rows is committed once so the server can
  // persist missing source-image fingerprints for future comparisons.
  return chunks.length > 0 ? chunks : [{ rowKeys: [], mediaKeys: [] }];
}

function uniqueIds(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

export function combineQualityImportResults(
  preview: QualityExcelImportPreview,
  commits: QualityExcelImportResult[],
  options: CombineQualityImportResultsOptions = {},
): QualityExcelImportResult {
  const existingRows: QualityExcelImportRowResult[] = preview.rows.flatMap((row) => {
    if (row.status === 'new') return [];
    const status: QualityExcelImportRowStatus = row.status === 'unchanged' ? 'skipped' : row.status;
    return [{ ...row, status }];
  });
  const committedRows = commits.flatMap((commit) => commit.rows);
  const committedRowKeys = new Set(committedRows.map((row) => row.row_key));
  const unprocessedNewRows: QualityExcelImportRowResult[] = options.includeUnprocessedNewAsFailed
    ? preview.rows
      .filter((row) => row.status === 'new' && !committedRowKeys.has(row.row_key))
      .map((row) => ({
        ...row,
        status: 'failed' as const,
        warnings: [...new Set([...row.warnings, 'commit_completion_unconfirmed'])],
        message: options.unprocessedMessage || 'Registration completion could not be confirmed. Retry safely.',
      }))
    : [];
  const rows = [
    ...existingRows,
    ...committedRows,
    ...unprocessedNewRows,
  ].sort((left, right) => (
    left.sheet_name.localeCompare(right.sheet_name)
    || left.source_row_number - right.source_row_number
  ));

  const createdReportIds = uniqueIds(commits.flatMap((commit) => commit.created_report_ids));
  const skippedReportIds = uniqueIds([
    ...existingRows
      .filter((row) => row.status === 'skipped' && row.report_id)
      .map((row) => row.report_id as number),
    ...commits.flatMap((commit) => commit.skipped_report_ids),
  ]);
  const changedReportIds = uniqueIds([
    ...existingRows
      .filter((row) => row.status === 'changed' && row.report_id)
      .map((row) => row.report_id as number),
    ...commits.flatMap((commit) => commit.changed_report_ids),
  ]);
  const baseImagesSkipped = existingRows
    .filter((row) => row.status === 'skipped' || row.status === 'changed')
    .reduce((total, row) => total + Math.min(row.images_found, 5), 0);

  return {
    filename: preview.filename,
    total_rows: preview.total_rows,
    created_count: rows.filter((row) => row.status === 'created').length,
    skipped_count: rows.filter((row) => row.status === 'skipped').length,
    changed_count: rows.filter((row) => row.status === 'changed').length,
    failed_count: rows.filter((row) => row.status === 'failed').length,
    images_found: preview.images_found,
    images_saved: commits.reduce((total, commit) => total + commit.images_saved, 0),
    images_failed: commits.reduce((total, commit) => total + commit.images_failed, 0),
    images_ignored: preview.images_ignored,
    images_skipped: baseImagesSkipped
      + commits.reduce((total, commit) => total + commit.images_skipped, 0),
    created_report_ids: createdReportIds,
    skipped_report_ids: skippedReportIds,
    changed_report_ids: changedReportIds,
    warnings: [...new Set([
      ...preview.warnings,
      ...commits.flatMap((commit) => commit.warnings),
    ])].sort(),
    rows,
  };
}
