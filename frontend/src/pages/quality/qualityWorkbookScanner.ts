import type { CellObject, WorkBook, WorkSheet } from 'xlsx';
import type { JSZipObject } from 'jszip';
import type {
  QualityWorkbookCell,
  QualityWorkbookManifest,
  QualityWorkbookMediaManifest,
  QualityWorkbookSheetManifest,
} from './importTypes';

const MAX_FILE_BYTES = 80 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 4_096;
const MAX_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const MAX_ROWS_PER_SHEET = 5_000;
const MAX_SUPPORTED_SHEETS = 16;
const MAX_TOTAL_ROWS = 10_000;
const MAX_COLUMNS = 32;
const MAX_CELL_TEXT = 20_000;
const MAX_XML_PART_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_MEDIA_ITEMS = 2_000;
const MAX_MEDIA_BYTES = 10_000_000;
const MAX_MANIFEST_MEDIA_TOTAL_BYTES = 128 * 1024 * 1024;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

const OQC_SHEET_NAME = 'OQC出库不良 返工list';
const ISSUE_SHEET_PATTERN = /^\s*\d{1,2}\s*月\s*$/;
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const DRAWINGML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

interface ZipEntrySizes {
  compressedSize?: number;
  uncompressedSize?: number;
}

interface MediaSource {
  part: string;
  sha256: string;
  contentType: string;
  byteSize: number;
}

export interface ScannedQualityWorkbook {
  manifest: QualityWorkbookManifest;
  extractMedia: (requiredKeys: readonly string[]) => Promise<Map<string, Blob>>;
}

function workbookError(message: string): Error {
  return new Error(message);
}

function isSupportedSheet(name: string): boolean {
  return name === OQC_SHEET_NAME || ISSUE_SHEET_PATTERN.test(name);
}

function issueSheetMonth(name: string): number | null {
  const match = name.match(/^\s*(\d{1,2})\s*月\s*$/);
  if (!match) return null;
  const month = Number(match[1]);
  return month >= 1 && month <= 12 ? month : null;
}

function filenameMonths(filename: string): number[] {
  return Array.from(filename.matchAll(/(^|\D)(\d{1,2})\s*月/g), (match) => Number(match[2]))
    .filter((month) => month >= 1 && month <= 12);
}

interface SheetSelection {
  selectedName: string;
  excludedNames: string[];
  reason: 'filename' | 'current_month' | 'only_monthly_sheet' | 'latest_monthly_sheet';
}

function selectMonthlyIssueSheet(sheetNames: readonly string[], filename: string): SheetSelection {
  const monthlySheets = sheetNames
    .map((name) => ({ name, month: issueSheetMonth(name) }))
    .filter((sheet): sheet is { name: string; month: number } => sheet.month != null);
  if (monthlySheets.length === 0) {
    throw workbookError('직접 업로드할 월별 품질 시트(예: 8月)를 찾지 못했습니다. OQC 이력 시트는 직접 업로드 대상이 아닙니다.');
  }

  let selected: { name: string; month: number } | undefined;
  let reason: SheetSelection['reason'] = 'latest_monthly_sheet';
  for (const month of filenameMonths(filename).reverse()) {
    selected = monthlySheets.find((sheet) => sheet.month === month);
    if (selected) {
      reason = 'filename';
      break;
    }
  }
  if (!selected) {
    const currentMonth = new Date().getMonth() + 1;
    selected = monthlySheets.find((sheet) => sheet.month === currentMonth);
    if (selected) reason = 'current_month';
  }
  if (!selected && monthlySheets.length === 1) {
    [selected] = monthlySheets;
    reason = 'only_monthly_sheet';
  }
  if (!selected) {
    selected = [...monthlySheets].sort((left, right) => right.month - left.month)[0];
  }

  const supportedNames = sheetNames.filter(isSupportedSheet);
  return {
    selectedName: selected.name,
    excludedNames: supportedNames.filter((name) => name !== selected.name),
    reason,
  };
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function preflightZipCentralDirectory(buffer: ArrayBuffer): void {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.byteLength < 22) throw workbookError('Excel ZIP 구조가 올바르지 않습니다.');

  const earliestEocd = Math.max(0, bytes.byteLength - 22 - 65_535);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= earliestEocd; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.byteLength) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw workbookError('Excel ZIP 중앙 디렉터리를 찾을 수 없습니다.');

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (
    diskNumber !== 0
    || centralDisk !== 0
    || diskEntries !== totalEntries
    || totalEntries === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
  ) {
    throw workbookError('분할 또는 ZIP64 Excel 파일은 처리할 수 없습니다.');
  }
  if (totalEntries === 0 || totalEntries > MAX_ZIP_ENTRIES) {
    throw workbookError('Excel 내부 항목 수가 안전 제한을 초과합니다.');
  }
  const centralEnd = centralOffset + centralSize;
  if (!Number.isSafeInteger(centralEnd) || centralEnd !== eocdOffset) {
    throw workbookError('Excel ZIP 중앙 디렉터리 범위가 올바르지 않습니다.');
  }

  const seenPaths = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let uncompressedTotal = 0;
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > centralEnd || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw workbookError('Excel ZIP 항목 구조가 올바르지 않습니다.');
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + filenameLength + extraLength + commentLength;
    if (
      (flags & 0x0001) !== 0
      || ![0, 8].includes(compression)
      || diskStart !== 0
      || filenameLength === 0
      || filenameLength > 2_048
      || nextOffset > centralEnd
      || localOffset + 30 > centralOffset
      || view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE
    ) {
      throw workbookError('암호화되었거나 지원하지 않는 Excel ZIP 항목이 있습니다.');
    }
    let filename: string;
    try {
      filename = decoder.decode(bytes.subarray(offset + 46, offset + 46 + filenameLength));
    } catch {
      throw workbookError('Excel ZIP 항목 이름을 읽을 수 없습니다.');
    }
    validateZipPath(filename);
    const canonicalPath = filename.replaceAll('\\', '/');
    if (seenPaths.has(canonicalPath)) {
      throw workbookError('Excel ZIP에 중복된 내부 경로가 있습니다.');
    }
    seenPaths.add(canonicalPath);
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw workbookError('Excel 내부 항목이 너무 큽니다.');
    }
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > MAX_UNCOMPRESSED_BYTES) {
      throw workbookError('Excel 압축 해제 크기가 안전 제한을 초과합니다.');
    }
    if (
      uncompressedSize > 0
      && (compressedSize === 0 || uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO)
    ) {
      throw workbookError('Excel 압축 비율이 안전 제한을 초과합니다.');
    }
    offset = nextOffset;
  }
  if (offset !== centralEnd) throw workbookError('Excel ZIP 중앙 디렉터리가 일치하지 않습니다.');
}

function zipEntrySizes(entry: JSZipObject): ZipEntrySizes {
  return ((entry as unknown as { _data?: ZipEntrySizes })._data || {});
}

function validateZipPath(value: string): void {
  const normalized = value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = normalized.split('/');
  if (
    !normalized
    || value.includes('\\')
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw workbookError('Excel 파일에 안전하지 않은 내부 경로가 있습니다.');
  }
}

function normalizePart(value: string): string {
  if (value.includes('\\')) throw workbookError('Excel 관계 경로가 올바르지 않습니다.');
  const segments: string[] = [];
  for (const segment of value.replace(/^\/+/, '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) throw workbookError('Excel 관계 경로가 파일 밖을 가리킵니다.');
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

function dirname(part: string): string {
  const separator = part.lastIndexOf('/');
  return separator >= 0 ? part.slice(0, separator) : '';
}

function basename(part: string): string {
  const separator = part.lastIndexOf('/');
  return separator >= 0 ? part.slice(separator + 1) : part;
}

function resolvePart(basePart: string, target: string): string {
  return normalizePart(target.startsWith('/') ? target : `${dirname(basePart)}/${target}`);
}

function relationshipPart(part: string): string {
  return `${dirname(part)}/_rels/${basename(part)}.rels`;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: ArrayBuffer | Uint8Array): Promise<string> {
  const input = value instanceof ArrayBuffer
    ? value
    : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  return bytesToHex(await crypto.subtle.digest('SHA-256', input));
}

function imageType(bytes: Uint8Array): { extension: string; contentType: string } | null {
  const startsWith = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return { extension: 'png', contentType: 'image/png' };
  }
  if (startsWith(0xff, 0xd8, 0xff)) return { extension: 'jpg', contentType: 'image/jpeg' };
  const header = new TextDecoder('ascii').decode(bytes.slice(0, 12));
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return { extension: 'gif', contentType: 'image/gif' };
  }
  if (header.startsWith('BM')) return { extension: 'bmp', contentType: 'image/bmp' };
  if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) {
    return { extension: 'tiff', contentType: 'image/tiff' };
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return { extension: 'webp', contentType: 'image/webp' };
  }
  return null;
}

function parseXml(content: Uint8Array, part: string): XMLDocument {
  if (content.byteLength > MAX_XML_PART_BYTES) {
    throw workbookError(`Excel XML 항목이 너무 큽니다: ${part}`);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  const upper = text.toUpperCase();
  if (upper.includes('<!DOCTYPE') || upper.includes('<!ENTITY')) {
    throw workbookError('Excel 파일에 안전하지 않은 XML 선언이 있습니다.');
  }
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw workbookError(`Excel XML을 읽을 수 없습니다: ${part}`);
  }
  return document;
}

function firstDescendant(parent: Element, namespace: string, localName: string): Element | null {
  return parent.getElementsByTagNameNS(namespace, localName).item(0);
}

function nodeInteger(parent: Element, localName: string): number | null {
  const value = firstDescendant(parent, DRAWING_NS, localName)?.textContent;
  if (value == null || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function formatDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const DISPLAY_DATE_HEADERS = new Set(['发生日期', '检查日期']);
const DISPLAY_DATE_PATTERN = /^(?:\d{1,2}[./-]\d{1,2}|\d{2,4}[./-]\d{1,2}[./-]\d{1,2})$/;

function cellValue(
  cell: CellObject | undefined,
  XLSX: typeof import('xlsx'),
  date1904: boolean,
  preferDisplayedDate = false,
): QualityWorkbookCell {
  if (!cell || cell.t === 'z' || cell.t === 'e' || cell.v == null) return null;
  const value = cell.v;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw workbookError('Excel 셀에 유효하지 않은 숫자가 있습니다.');
    if (cell.z && XLSX.SSF.is_date(cell.z)) {
      const parsed = XLSX.SSF.parse_date_code(value, { date1904 });
      if (parsed) return formatDateParts(parsed.y, parsed.m, parsed.d);
    }
    // These workbooks encode month/day as a decimal number. A value such as
    // 8.1 is displayed as 8.10 by the cell's `0.00` format, so using only the
    // raw number would silently turn August 10 into August 1.
    const displayed = typeof cell.w === 'string' ? cell.w.trim() : '';
    if (preferDisplayedDate && DISPLAY_DATE_PATTERN.test(displayed)) return displayed;
    return value;
  }
  if (value instanceof Date) {
    return formatDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === 'boolean') return value;
  const text = String(value);
  if (text.length > MAX_CELL_TEXT) throw workbookError('Excel 셀의 텍스트가 너무 깁니다.');
  return text;
}

function worksheetRows(
  sheet: WorkSheet,
  XLSX: typeof import('xlsx'),
  date1904: boolean,
): QualityWorkbookCell[][] {
  const reference = sheet['!ref'];
  if (!reference) return [];
  const range = XLSX.utils.decode_range(reference);
  const rowCount = range.e.r + 1;
  if (rowCount > MAX_ROWS_PER_SHEET) throw workbookError('품질 시트가 5,000행 제한을 초과합니다.');
  const lastColumn = Math.min(range.e.c, MAX_COLUMNS - 1);
  const displayDateColumns = new Set<number>();
  const headerRowIndex = 1;
  if (rowCount > headerRowIndex) {
    for (let columnIndex = 0; columnIndex <= lastColumn; columnIndex += 1) {
      const headerCell = sheet[XLSX.utils.encode_cell({ r: headerRowIndex, c: columnIndex })];
      const header = String(headerCell?.v ?? '').replace(/\s+/g, '');
      if (DISPLAY_DATE_HEADERS.has(header)) displayDateColumns.add(columnIndex);
    }
  }
  const rows: QualityWorkbookCell[][] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row: QualityWorkbookCell[] = [];
    for (let columnIndex = 0; columnIndex <= lastColumn; columnIndex += 1) {
      row.push(cellValue(
        sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })],
        XLSX,
        date1904,
        displayDateColumns.has(columnIndex),
      ));
    }
    while (row.length > 0 && row[row.length - 1] == null) row.pop();
    rows.push(row);
  }
  return rows;
}

function buildSheetManifest(
  workbook: WorkBook,
  XLSX: typeof import('xlsx'),
  filename: string,
): { sheets: QualityWorkbookSheetManifest[]; selection: SheetSelection } {
  const supportedNames = workbook.SheetNames.filter(isSupportedSheet);
  if (supportedNames.length > MAX_SUPPORTED_SHEETS) {
    throw workbookError('지원되는 품질 시트가 16개를 초과합니다.');
  }
  const selection = selectMonthlyIssueSheet(workbook.SheetNames, filename);
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  const sheets = [{
    sheet_name: selection.selectedName,
    rows: worksheetRows(workbook.Sheets[selection.selectedName], XLSX, date1904),
  }];
  if (sheets.reduce((total, sheet) => total + sheet.rows.length, 0) > MAX_TOTAL_ROWS + 32) {
    throw workbookError('Excel 행 수가 전체 제한을 초과합니다.');
  }
  return { sheets, selection };
}

function safeSheetKey(sheetName: string): string {
  return sheetName.replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'sheet';
}

export async function scanQualityWorkbook(file: File): Promise<ScannedQualityWorkbook> {
  if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
    throw workbookError('Excel 파일 크기가 허용 범위를 벗어났습니다.');
  }
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength !== file.size) throw workbookError('Excel 파일을 완전히 읽지 못했습니다.');
  preflightZipCentralDirectory(buffer);
  const workbookSha256 = await sha256(buffer);
  const [{ default: JSZip }, XLSX] = await Promise.all([import('jszip'), import('xlsx')]);

  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    // Read only the central directory first. `checkCRC32: true` decompresses
    // every entry before JSZip resolves, which would make the limits below too
    // late to protect the browser from an oversized archive.
    zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  } catch {
    throw workbookError('손상되었거나 암호화된 Excel 파일은 처리할 수 없습니다.');
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_ZIP_ENTRIES) throw workbookError('Excel 내부 항목 수가 안전 제한을 초과합니다.');
  let uncompressedTotal = 0;
  for (const entry of entries) {
    validateZipPath(entry.unsafeOriginalName || entry.name);
    const sizes = zipEntrySizes(entry);
    const uncompressedSize = safeInteger(sizes.uncompressedSize);
    const compressedSize = safeInteger(sizes.compressedSize);
    if (uncompressedSize == null || compressedSize == null) {
      throw workbookError('Excel 내부 항목 크기를 확인할 수 없습니다.');
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw workbookError('Excel 내부 항목이 너무 큽니다.');
    uncompressedTotal += uncompressedSize;
    if (uncompressedTotal > MAX_UNCOMPRESSED_BYTES) {
      throw workbookError('Excel 압축 해제 크기가 안전 제한을 초과합니다.');
    }
    if (uncompressedSize > 0) {
      if (compressedSize <= 0 || uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
        throw workbookError('Excel 압축 비율이 안전 제한을 초과합니다.');
      }
    }
  }

  try {
    // The archive is now bounded, so it is safe to decompress every entry once
    // and reject corrupt content before parsing any workbook or media data.
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  } catch {
    throw workbookError('손상되었거나 암호화된 Excel 파일은 처리할 수 없습니다.');
  }

  let workbook: WorkBook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'array',
      cellDates: false,
      cellFormula: false,
      cellNF: true,
      cellStyles: false,
      bookVBA: false,
    });
  } catch {
    throw workbookError('Excel 셀 데이터를 읽을 수 없습니다.');
  }
  const { sheets, selection } = buildSheetManifest(workbook, XLSX, file.name);
  const supportedSheetNames = new Set(sheets.map((sheet) => sheet.sheet_name));

  const xmlCache = new Map<string, XMLDocument>();
  const readXml = async (part: string): Promise<XMLDocument> => {
    const normalized = normalizePart(part);
    const cached = xmlCache.get(normalized);
    if (cached) return cached;
    const entry = zip.file(normalized);
    if (!entry) throw workbookError(`Excel 내부 항목이 없습니다: ${normalized}`);
    const document = parseXml(await entry.async('uint8array'), normalized);
    xmlCache.set(normalized, document);
    return document;
  };
  const relationships = async (part: string): Promise<Map<string, string>> => {
    const entry = zip.file(part);
    if (!entry) return new Map();
    const document = await readXml(part);
    const result = new Map<string, string>();
    for (const node of Array.from(document.getElementsByTagNameNS('*', 'Relationship'))) {
      if ((node.getAttribute('TargetMode') || '').toLowerCase() === 'external') continue;
      const id = node.getAttribute('Id');
      const target = node.getAttribute('Target');
      if (id && target) result.set(id, target);
    }
    return result;
  };

  const workbookPart = 'xl/workbook.xml';
  const workbookDocument = await readXml(workbookPart);
  const workbookRelationships = await relationships('xl/_rels/workbook.xml.rels');
  const sheetParts: Array<{ name: string; part: string }> = [];
  for (const sheet of Array.from(workbookDocument.getElementsByTagNameNS(SPREADSHEET_NS, 'sheet'))) {
    const name = sheet.getAttribute('name') || '';
    const relationshipId = sheet.getAttributeNS(OFFICE_REL_NS, 'id') || sheet.getAttribute('r:id');
    const target = relationshipId ? workbookRelationships.get(relationshipId) : null;
    if (!target || !supportedSheetNames.has(name)) continue;
    const part = resolvePart(workbookPart, target);
    if (part.startsWith('xl/worksheets/') && zip.file(part)) sheetParts.push({ name, part });
  }
  if (sheetParts.length !== supportedSheetNames.size) {
    throw workbookError('품질 시트의 내부 경로를 확인할 수 없습니다.');
  }

  const media: QualityWorkbookMediaManifest[] = [];
  const mediaSources = new Map<string, MediaSource>();
  const warnings: string[] = [
    `direct_import_selected_monthly_sheet:${selection.selectedName}:${selection.reason}`,
  ];
  if (selection.excludedNames.length > 0) {
    warnings.push(`direct_import_excluded_sheets:${selection.excludedNames.join(',')}`);
  }
  const imageCache = new Map<string, { bytes: Uint8Array; sha256: string }>();
  let mediaTotalBytes = 0;
  for (const sheet of sheetParts) {
    const sheetDocument = await readXml(sheet.part);
    const sheetRelationships = await relationships(relationshipPart(sheet.part));
    const anchorCounts = new Map<number, number>();
    for (const drawingReference of Array.from(sheetDocument.getElementsByTagNameNS(SPREADSHEET_NS, 'drawing'))) {
      const relationshipId = drawingReference.getAttributeNS(OFFICE_REL_NS, 'id')
        || drawingReference.getAttribute('r:id');
      const target = relationshipId ? sheetRelationships.get(relationshipId) : null;
      if (!target) {
        warnings.push(`unreadable_drawing_reference:${sheet.name}`);
        continue;
      }
      const drawingPart = resolvePart(sheet.part, target);
      if (!drawingPart.startsWith('xl/drawings/') || !zip.file(drawingPart)) {
        warnings.push(`missing_drawing_part:${sheet.name}`);
        continue;
      }
      const drawingDocument = await readXml(drawingPart);
      const drawingRelationships = await relationships(relationshipPart(drawingPart));
      const anchors = Array.from(drawingDocument.documentElement.children).filter((node) => (
        node.namespaceURI === DRAWING_NS
        && ['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'].includes(node.localName)
      ));
      for (const anchor of anchors) {
        const marker = firstDescendant(anchor, DRAWING_NS, 'from');
        const zeroBasedRow = marker ? nodeInteger(marker, 'row') : null;
        const zeroBasedColumn = marker ? nodeInteger(marker, 'col') : null;
        if (zeroBasedRow == null || zeroBasedColumn == null) {
          warnings.push(`unreadable_image_anchor:${sheet.name}`);
          continue;
        }
        const sourceAnchorRow = zeroBasedRow + 1;
        const sourceAnchorCol = zeroBasedColumn + 1;
        const blip = firstDescendant(anchor, DRAWINGML_NS, 'blip');
        const embedId = blip?.getAttributeNS(OFFICE_REL_NS, 'embed') || blip?.getAttribute('r:embed');
        const imageTarget = embedId ? drawingRelationships.get(embedId) : null;
        if (!imageTarget) {
          warnings.push(`unreadable_embedded_image:${sheet.name}:${sourceAnchorRow}`);
          continue;
        }
        const imagePart = resolvePart(drawingPart, imageTarget);
        const imageEntry = zip.file(imagePart);
        if (!imagePart.startsWith('xl/media/') || !imageEntry) {
          warnings.push(`missing_embedded_image:${sheet.name}:${sourceAnchorRow}`);
          continue;
        }
        const sourceIndex = anchorCounts.get(sourceAnchorRow) || 0;
        anchorCounts.set(sourceAnchorRow, sourceIndex + 1);
        let cachedImage = imageCache.get(imagePart);
        if (!cachedImage) {
          const bytes = await imageEntry.async('uint8array');
          if (bytes.byteLength > MAX_MEDIA_BYTES) throw workbookError('Excel 사진 한 장이 10MB를 초과합니다.');
          cachedImage = { bytes, sha256: await sha256(bytes) };
          imageCache.set(imagePart, cachedImage);
        }
        mediaTotalBytes += cachedImage.bytes.byteLength;
        if (mediaTotalBytes > MAX_MANIFEST_MEDIA_TOTAL_BYTES) {
          throw workbookError('Excel 사진의 전체 크기가 128MB를 초과합니다.');
        }
        const detected = imageType(cachedImage.bytes);
        if (!detected) {
          warnings.push(`unsupported_image_format:${sheet.name}:${sourceAnchorRow}:${sourceIndex}`);
          continue;
        }
        if (media.length >= MAX_MANIFEST_MEDIA_ITEMS) {
          throw workbookError('Excel 사진이 2,000장을 초과합니다.');
        }
        const key = `m_${media.length}`;
        media.push({
          key,
          source_sheet_name: sheet.name,
          source_anchor_row: sourceAnchorRow,
          source_anchor_col: sourceAnchorCol,
          source_index: sourceIndex,
          original_filename: `${safeSheetKey(sheet.name)}-r${sourceAnchorRow}-${sourceIndex}.${detected.extension}`,
          content_type: detected.contentType,
          byte_size: cachedImage.bytes.byteLength,
          sha256: cachedImage.sha256,
        });
        mediaSources.set(key, {
          part: imagePart,
          sha256: cachedImage.sha256,
          contentType: detected.contentType,
          byteSize: cachedImage.bytes.byteLength,
        });
      }
    }
  }
  imageCache.clear();

  const uniqueWarnings = [...new Set(warnings)].sort();
  const boundedWarnings = uniqueWarnings.length <= 500
    ? uniqueWarnings
    : [...uniqueWarnings.slice(0, 499), 'warnings_truncated'];
  const manifest: QualityWorkbookManifest = {
    version: 'quality-incremental-v1',
    filename: file.name,
    file_size: file.size,
    workbook_sha256: workbookSha256,
    workbook_properties: { title: String(workbook.Props?.Title || '') },
    sheets,
    media,
    warnings: boundedWarnings,
  };
  if (new TextEncoder().encode(JSON.stringify(manifest)).byteLength > MAX_MANIFEST_BYTES) {
    throw workbookError('Excel 비교 데이터가 2MB를 초과합니다. 시트 내용이나 사진 수를 줄여 주세요.');
  }

  const extractMedia = async (requiredKeys: readonly string[]): Promise<Map<string, Blob>> => {
    const uniqueKeys = [...new Set(requiredKeys)];
    const result = new Map<string, Blob>();
    for (const key of uniqueKeys) {
      const source = mediaSources.get(key);
      if (!source) throw workbookError(`요청된 사진을 Excel에서 찾지 못했습니다: ${key}`);
      const entry = zip.file(source.part);
      if (!entry) throw workbookError(`Excel 사진 항목이 없습니다: ${key}`);
      const bytes = await entry.async('uint8array');
      if (bytes.byteLength !== source.byteSize || await sha256(bytes) !== source.sha256) {
        throw workbookError(`Excel 사진 검증에 실패했습니다: ${key}`);
      }
      result.set(key, new Blob([bytes], { type: source.contentType }));
    }
    return result;
  };
  return { manifest, extractMedia };
}
