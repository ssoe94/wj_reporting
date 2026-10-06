// A display projection only. These IDs never select a request or grant write authority.
const approvedQc = { id: '1791013139392836', code: 'QC-26100300323' };
export const canReadMesDetailPreview = (actorId: unknown) => actorId === 18;
export type PreviewEnum = { code: number | null; message: string | null };
type PreviewUnit = { id: string | null; code: string | null; name: string | null };
export type MesDetailPreviewItem = {
  id: string; check_item_id: string | null; version_id: string | null; group_name: string | null;
  code: string | null; serial_no: number | null; execute_item_type: PreviewEnum;
  name: string | null; unit: PreviewUnit; minimum: string | null; maximum: string | null; base: string | null;
  scale: number | null; logic: PreviewEnum; value_type: PreviewEnum; required_type: PreviewEnum; options: string[]; missing_fields: 'options'[];
};
const inventoryKeys = ['qcRange', 'materialBatchRecordType', 'sampleProcessMethod', 'recordSample', 'recordSummaryCount'] as const;
const missingNames = ['get_able', 'status', 'get_status', 'executor_id', 'snapshot_id', 'items', 'approval',
  ...inventoryKeys.map((key) => `inventory_metadata.${key}`), 'inventory_metadata.check_material_count', 'inventory_metadata.sample_material_count'];
export type MesDetailPreviewData = {
  qc_id: string; qc_code: string; read_only: true; observed_at: string;
  get_able: number | null; status: PreviewEnum; get_status: PreviewEnum;
  executor_id: string | null; executor_present: boolean; executor_matches_lee: boolean | null; snapshot_id: string | null;
  items: MesDetailPreviewItem[]; item_count: number | null; expected_item_count: 16;
  item_count_matches_expected: boolean | null;
  approval: null | { id: string | null; code: string | null; status: PreviewEnum; status_meaning: 'unknown' };
  inventory_metadata: Record<typeof inventoryKeys[number], PreviewEnum> & { check_material_count: number | null; sample_material_count: number | null };
  missing_fields: string[];
};
function invalid(): never { throw new Error('Invalid MES detail preview response'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 256): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > limit) return invalid();
  return value;
}
function id(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)
    || (value.length === 19 && value > '9223372036854775807')) return invalid();
  return value;
}
function integer(value: unknown, maximum: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) return invalid();
  return value;
}
function flag(value: unknown): boolean | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') return invalid();
  return value;
}
function sourceEnum(value: unknown): PreviewEnum {
  const row = object(value);
  if (row.code !== null && (typeof row.code !== 'number' || !Number.isSafeInteger(row.code))) return invalid();
  return { code: row.code as number | null, message: text(row.message) };
}
function decimal(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 64 || !/^-?[0-9]+(?:\.[0-9]{1,18})?$/.test(value)) return invalid();
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const significant = whole.replace(/^0+/, '') || '0';
  if (significant.length > 16 || (significant.length === 16
    && (significant > '1000000000000000' || (significant === '1000000000000000' && /[1-9]/.test(fraction))))) return invalid();
  return value;
}
export function parseMesDetailPreview(value: unknown): MesDetailPreviewData {
  const data = object(value);
  if (data.qc_id !== approvedQc.id || data.qc_code !== approvedQc.code || data.read_only !== true
    || typeof data.observed_at !== 'string' || data.observed_at.length > 64 || !Number.isFinite(Date.parse(data.observed_at))
    || data.expected_item_count !== 16 || !Array.isArray(data.items) || data.items.length > 100) return invalid();
  const seen = new Set<string>();
  const items = data.items.map((raw): MesDetailPreviewItem => {
    const row = object(raw); const itemId = id(row.id); const unit = object(row.unit);
    if (!itemId || seen.has(itemId) || !Array.isArray(row.options) || row.options.length > 50
      || row.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 500)
      || !Array.isArray(row.missing_fields) || row.missing_fields.length > 1
      || row.missing_fields.some((name) => name !== 'options') || (row.missing_fields.length > 0 && row.options.length > 0)) return invalid();
    seen.add(itemId);
    return { id: itemId, check_item_id: id(row.check_item_id), version_id: id(row.version_id), group_name: text(row.group_name, 128),
      code: text(row.code), serial_no: integer(row.serial_no, 10000), execute_item_type: sourceEnum(row.execute_item_type),
      name: text(row.name), unit: { id: id(unit.id), code: text(unit.code), name: text(unit.name) },
      minimum: decimal(row.minimum), maximum: decimal(row.maximum), base: decimal(row.base), scale: integer(row.scale, 18),
      logic: sourceEnum(row.logic), value_type: sourceEnum(row.value_type), required_type: sourceEnum(row.required_type),
      options: [...row.options] as string[], missing_fields: [...row.missing_fields] as 'options'[] };
  });
  const count = integer(data.item_count, 100); const countMatches = flag(data.item_count_matches_expected);
  if (count === null ? items.length !== 0 || countMatches !== null : count !== items.length || countMatches !== (count === 16)) return invalid();
  const inventory = object(data.inventory_metadata);
  const inventoryEnums = Object.fromEntries(inventoryKeys.map((key) => [key, sourceEnum(inventory[key])])) as Record<typeof inventoryKeys[number], PreviewEnum>;
  const approval = data.approval === null ? null : object(data.approval);
  if (approval && approval.status_meaning !== 'unknown') return invalid();
  if (!Array.isArray(data.missing_fields) || data.missing_fields.length > missingNames.length
    || data.missing_fields.some((name) => typeof name !== 'string' || !missingNames.includes(name))) return invalid();
  const executorMatches = flag(data.executor_matches_lee);
  if (typeof data.executor_present !== 'boolean' || (data.executor_id !== null && data.executor_id !== '1733276056994641')
    || (data.executor_id !== null && executorMatches !== true)
    || (executorMatches === true && data.executor_id === null)
    || (!data.executor_present && executorMatches !== null)) return invalid();
  return { qc_id: data.qc_id, qc_code: data.qc_code, read_only: true, observed_at: data.observed_at,
    get_able: integer(data.get_able, 1), status: sourceEnum(data.status), get_status: sourceEnum(data.get_status),
    executor_id: id(data.executor_id), executor_present: data.executor_present, executor_matches_lee: executorMatches, snapshot_id: id(data.snapshot_id),
    items, item_count: count, expected_item_count: 16, item_count_matches_expected: countMatches,
    approval: approval ? { id: id(approval.id), code: text(approval.code), status: sourceEnum(approval.status), status_meaning: 'unknown' } : null,
    inventory_metadata: { ...inventoryEnums, check_material_count: integer(inventory.check_material_count, 1000), sample_material_count: integer(inventory.sample_material_count, 1000) },
    missing_fields: [...data.missing_fields] as string[] };
}
export function previewLifecycle(value: PreviewEnum, kind: 'status' | 'get_status', lang: 'ko' | 'zh') {
  const labels = kind === 'status'
    ? (lang === 'ko' ? ['시작 전', '진행 중', '종료', '취소', '검토 중', '반려'] : ['未开始', '进行中', '结束', '取消', '审核中', '驳回'])
    : (lang === 'ko' ? ['미수령', '수령됨'] : ['未领取', '已领取']);
  return value.code !== null && value.code >= 0 && value.code < labels.length
    ? `${labels[value.code]} (${value.code})` : `${lang === 'ko' ? '미확인' : '未确认'} (${value.code ?? '—'})`;
}
export function previewSourceEnum(value: PreviewEnum) {
  return value.code === null ? '—' : `${value.code}${value.message ? ` · ${value.message}` : ''}`;
}
export function mesDetailPreviewDownload(value: unknown) {
  return { filename: 'wj-qc-detail-preview-QC-26100300323.json',
    contents: `${JSON.stringify(parseMesDetailPreview(value), null, 2)}\n` };
}
