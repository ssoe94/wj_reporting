import { inspectionTime } from './copy';
import { mesReadEnum, mesReadLabels, mesReadRecordValue, mesReadSpecification } from './mesReadObservation';
import type { MesReadItem, MesReadObservation } from './mesReadObservation';

function ObservedItem({ field, lang }: { field: MesReadItem; lang: 'ko' | 'zh' }) {
  const ko = lang === 'ko';
  const spec = mesReadSpecification(field);
  const source = field.source;
  const value = (text: string | null) => mesReadRecordValue(text, lang);
  return <li className="inspection-mes-item" data-testid="mes-observed-item">
    <strong>{field.label || '—'}</strong>
    <div className="inspection-mes-spec" data-testid="mes-item-specification">
      <h4>{ko ? '관측 규격' : '观测规格'}</h4>
      <dl className="inspection-mes-values">
        {spec.range && <div><dt>{ko ? '규격 범위' : '规格范围'}</dt><dd>{spec.range}</dd></div>}
        {spec.condition && <div><dt>{ko ? '조건·기준값' : '条件·基准值'}</dt><dd>{spec.condition}</dd></div>}
        {spec.options && <div><dt>{ko ? '선택값' : '选项'}</dt><dd>{spec.options}</dd></div>}
        {!spec.range && !spec.condition && !spec.options && <div><dt>{ko ? '규격' : '规格'}</dt><dd>—</dd></div>}
        <div><dt>{ko ? '필수' : '必填'}</dt><dd>{field.required === null ? '—' : field.required ? (ko ? '예' : '是') : (ko ? '아니오' : '否')}</dd></div>
        {source && <>
          <div><dt>{ko ? '항목 유형' : '项目类型'}</dt><dd>{mesReadEnum(source.execute_item_type)}</dd></div>
          <div><dt>{ko ? '값 유형' : '数值类型'}</dt><dd>{mesReadEnum(source.value_type)}</dd></div>
          <div><dt>{ko ? '소수 자릿수' : '小数位数'}</dt><dd>{source.scale ?? '—'}</dd></div>
        </>}
      </dl>
    </div>
    {field.records ? <section className="inspection-mes-records" aria-label={`${field.label || '—'} · ${ko ? '관측 기록' : '观测记录'}`}>
      <h4>{ko ? '관측 기록' : '观测记录'} ({field.records.length})</h4>
      {field.records.length ? <ol>{field.records.map((record) => <li key={record.record_id} data-testid="mes-item-record">
        <strong>{ko ? '샘플 순번' : '样本序号'} {record.seq}</strong>
        <dl className="inspection-mes-values">
          <div><dt>{ko ? '기록값' : '记录值'}</dt><dd data-testid="mes-record-result">{value(record.result)}</dd></div>
          <div><dt>{ko ? '기록 최솟값' : '记录下限'}</dt><dd>{value(record.minimum)}</dd></div>
          <div><dt>{ko ? '기록 최댓값' : '记录上限'}</dt><dd>{value(record.maximum)}</dd></div>
          {record.option !== null && <div><dt>{ko ? '선택 기록' : '选项记录'}</dt><dd>{record.option.length ? record.option.join(' · ') : '—'}</dd></div>}
          <div><dt>{ko ? '개별 판정 코드' : '单项判定代码'}</dt><dd>{record.single_judgment ?? '—'}</dd></div>
        </dl>
        <p className="inspection-mes-source-id">{ko ? '기록 ID' : '记录 ID'}: {record.record_id}</p>
      </li>)}</ol> : <p>{ko ? '관측된 기록 없음 · 미완료 여부는 별도 확인' : '未观测到记录 · 是否未完成需另行确认'}</p>}
    </section> : <p>{ko ? '기록값' : '记录值'}: {value(field.recorded_value)}</p>}
    {source && <p className="inspection-mes-source-id">{ko ? '기준행 ID' : '规格行 ID'}: {source.config_row_id}<br />
      {ko ? '항목 ID' : '项目 ID'}: {source.master_check_item_id}<br />{ko ? '버전 ID' : '版本 ID'}: {source.config_version_id}</p>}
  </li>;
}

/** Observations have no editor, completion badge, selection callback or write controls. */
export default function MesReadObservationCard({ item, lang }: { item: MesReadObservation; lang: 'ko' | 'zh' }) {
  const labels = mesReadLabels(item, lang);
  const ko = lang === 'ko';
  return <li className="inspection-unmapped-request inspection-mes-observation" data-testid="mes-read-observation">
    <strong>{labels.kind} · {item.qc_code || item.qc_id}</strong>
    <p>{labels.source}</p><p>{labels.caution}</p>
    {labels.warning && <p role="status">{labels.warning}</p>}
    {item.warnings.some((value) => value !== 'plan_name_type_mismatch') && <p>{ko ? '원천 자료·연결 확인 필요' : '需核对来源资料及关联'}</p>}
    <p>{ko ? '관측' : '观测'}: {inspectionTime(item.observed_at, lang)}</p>
    <details><summary>{ko ? 'QC 사본과 관측 항목' : 'QC 副本及观测项目'}</summary>
      <p>QC ID: {item.qc_id}</p><p>{ko ? '공단' : '工单'} ID: {item.work_order_id}</p>
      <p>{ko ? '생산작업' : '生产作业'} ID: {item.production_task_id || '—'}</p>
      <p>{ko ? '설비' : '设备'} ID: {item.equipment_id || '—'}</p>
      <p>Snapshot ID: {item.snapshot_id || '—'} · {item.plan_name || '—'}</p>
      <p>{ko ? '관측 진행 상태' : '观测任务状态'}: {mesReadEnum(item.lifecycle)}</p>
      <p>{ko ? '관측 판정' : '观测判定'}: {mesReadEnum(item.judgement)}</p>
      <p>{ko ? '원천 변경시각 원문' : '源修改时间原文'}: {item.source_updated_at || '—'}</p>
      <p>{ko ? '규격과 기록값은 별도 원천값입니다. 기록 누락·개별 판정만으로 검사 완료를 판단하지 않습니다.' : '规格与记录值分别保留原始值。不能仅凭缺失记录或单项判定认定检验完成。'}</p>
      <ul className="inspection-mes-items">{item.items.map((field) => <ObservedItem key={field.ordinal} field={field} lang={lang} />)}</ul>
    </details>
  </li>;
}
