/** Local read projection. Source IDs never establish item write authority. */
export type MesSourceEnum = { code: number | null; message: string | null };
export type MesReadRecord = {
  record_id: string; config_row_id: string; outer_group_name: string; seq: number;
  result: string | null; minimum: string | null; maximum: string | null;
  option: string[] | null; single_judgment: number | null; task_check_count: string | null;
  timestamps: Record<string, { epoch_ms: number | null; iso_utc: string | null }>;
  write_check_item_id: null; write_mapping_verified: false;
};
export type MesReadItemSource = {
  config_row_id: string; master_check_item_id: string; config_version_id: string;
  serial_no: number | null; outer_group_name: string; nested_group_name: string | null;
  unit: { id: string | null; code: string | null; name: string | null };
  minimum: string | null; maximum: string | null; base: string | null;
  logic: MesSourceEnum; scale: number | null; execute_item_type: MesSourceEnum;
  value_type: MesSourceEnum; required_type: MesSourceEnum; options: string[];
  check_count: string | null; task_check_count: string | null;
  total_report_count: number | null; required_report_count: number | null; filled_report_count: number | null;
};
export type MesReadItem = {
  ordinal: number; source_item_id?: string | null; label: string | null; unit: string | null;
  minimum: string | null; maximum: string | null; required: boolean | null;
  recorded_value: string | null; group?: string | null; seq?: number | null;
  write_check_item_id?: null; write_mapping_verified: false;
  source?: MesReadItemSource; records?: MesReadRecord[];
};

export type MesReadObservation = {
  observation_key: string; identity: string; qc_id: string; qc_code: string | null;
  work_order_id: string; production_task_id: string | null; equipment_id: string | null;
  snapshot_id: string | null; plan_name: string | null;
  kind: 'first' | 'periodic' | 'production' | 'unknown';
  lifecycle: { code: number | null; message: string | null };
  judgement: { code: number | null; message: string | null };
  observed_at: string; source_updated_at: string | null;
  evidence_kind: 'synthetic_contract_fixture' | 'sanitized_read_fixture';
  warnings: string[]; binding_status: 'explicit_fixture_relation' | 'unresolved';
  read_only: true; current_state_verified: false; physical_operation_verified: false;
  items: MesReadItem[];
};

export function mesReadEnum(value: MesSourceEnum) {
  return value.code === null ? '—' : `${value.code}${value.message ? ` · ${value.message}` : ''}`;
}

/** Display source strings as supplied; never parse numbers, judge or fill gaps. */
export function mesReadSpecification(item: MesReadItem) {
  const source = item.source;
  const minimum = source ? source.minimum : item.minimum;
  const maximum = source ? source.maximum : item.maximum;
  const hasRange = minimum !== null || maximum !== null;
  return {
    range: hasRange ? `${minimum ?? '—'} ~ ${maximum ?? '—'}${item.unit ? ` ${item.unit}` : ''}` : null,
    condition: source?.base !== null && source?.base !== undefined
      ? `${source.logic.message ?? mesReadEnum(source.logic)} ${source.base}${item.unit ? ` ${item.unit}` : ''}` : null,
    options: source?.options.join(' · ') || null,
  };
}

export function mesReadRecordValue(value: string | null, lang: 'ko' | 'zh') {
  return value === null ? (lang === 'ko' ? '원천값 없음' : '源值为空') : value === '' ? (lang === 'ko' ? '빈 문자열' : '空字符串') : value;
}

export function mesReadLabels(item: MesReadObservation, lang: 'ko' | 'zh') {
  const ko = lang === 'ko';
  const kinds = ko ? { first: '초검', periodic: '타임체크', production: '생산검사', unknown: '유형 미확인' }
    : { first: '首检', periodic: '巡检', production: '生产检验', unknown: '类型未确认' };
  return {
    kind: kinds[item.kind] || kinds.unknown,
    source: item.evidence_kind === 'synthetic_contract_fixture'
      ? (ko ? '합성 MES 관측 · 실제 수신 아님' : '合成 MES 观测 · 非实际接收')
      : (ko ? '정제된 과거 MES 관측' : '已脱敏的历史 MES 观测'),
    warning: item.warnings.includes('plan_name_type_mismatch')
      ? (ko ? '방안 이름과 실제 유형 불일치 · 확인 필요' : '方案名称与实际类型不一致 · 请核对') : '',
    caution: ko ? '읽기 전용 · 현재 상태·실제 가동·입고 조건 미확인' : '只读 · 当前状态、实际运行及入库条件未确认',
  };
}
