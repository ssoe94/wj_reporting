import { useEffect, useRef, useState } from 'react';
import { isAuthSessionCurrent } from '@/domains/auth/auth-transition';
import { getMesDetailPreview } from './api';
import { canReadMesDetailPreview, mesDetailPreviewDownload, previewLifecycle, previewSourceEnum } from './mesDetailPreviewModel';
import type { MesDetailPreviewData } from './mesDetailPreviewModel';
import { inspectionTime } from './copy';

export default function MesDetailPreview({ actorId, sessionId, lang, disabled }: {
  actorId: number; sessionId: string | null; lang: 'ko' | 'zh'; disabled: boolean;
}) {
  const [data, setData] = useState<MesDetailPreviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const ko = lang === 'ko';
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null; };
  }, []);
  const load = async () => {
    if (!mounted.current || pending.current || disabled || !canReadMesDetailPreview(actorId) || !isAuthSessionCurrent(sessionId)) return;
    const request = new AbortController(); pending.current = request;
    setBusy(true); setError(false); setData(null);
    const current = () => mounted.current && pending.current === request && !request.signal.aborted && isAuthSessionCurrent(sessionId);
    try { const result = await getMesDetailPreview(sessionId, request.signal); if (current()) setData(result); }
    catch { if (current()) setError(true); }
    finally { if (current()) setBusy(false); if (pending.current === request) pending.current = null; }
  };
  const download = () => {
    if (!data || disabled || busy || !canReadMesDetailPreview(actorId) || !isAuthSessionCurrent(sessionId)) return;
    const file = mesDetailPreviewDownload(data);
    const url = URL.createObjectURL(new Blob([file.contents], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!canReadMesDetailPreview(actorId) || !isAuthSessionCurrent(sessionId)) return null;
  const source = (label: string, value: string | number | null) => <div><dt>{label}</dt><dd>{value ?? '—'}</dd></div>;
  return <section className="inspection-workspace inspection-detail" aria-label={ko ? '지정 MES 검사 조회' : '查询指定 MES 检验'}>
    <div className="inspection-actions"><button type="button" className="inspection-button" disabled={disabled || busy} onClick={() => void load()}>{busy ? (ko ? '조회 중…' : '查询中…') : (ko ? '지정 MES 검사 조회' : '查询指定 MES 检验')}</button><span className="inspection-muted">{ko ? 'MES 검사 기준과 상태를 읽기 전용으로 확인합니다.' : '只读查看 MES 检验标准和状态。'}</span></div>
    {error && <p className="inspection-message is-error" role="alert">{ko ? '지정 MES 검사를 조회하지 못했습니다. MES 연결 상태와 조회 권한을 확인한 뒤 다시 시도해 주세요.' : '无法查询指定 MES 检验。请确认 MES 连接状态和查询权限后重试。'}</p>}
    {data && <details className="inspection-mes-observation" open>
      <summary>{data.qc_code} · {ko ? '조회 항목' : '查询项目'} {data.item_count ?? '—'}</summary>
      <p className="inspection-muted">{ko ? '조회 성공 · 측정 결과를 포함하지 않습니다.' : '查询成功 · 不含测量结果。'} {inspectionTime(data.observed_at, lang)}</p>
      <button type="button" className="inspection-button" disabled={disabled || busy} onClick={download}>{ko ? '조회 메타데이터 내려받기' : '下载查询元数据'}</button>
      <dl className="inspection-meta">
        {source('QC ID', data.qc_id)}{source(ko ? '스냅샷 ID' : '快照 ID', data.snapshot_id)}
        {source(ko ? '검사 상태' : '检验状态', previewLifecycle(data.status, 'status', lang))}
        {source(ko ? '수령 상태' : '领取状态', previewLifecycle(data.get_status, 'get_status', lang))}
        {source(ko ? '수령 가능 원천값' : '可领取源值', data.get_able)}
        {source(ko ? '담당 MES 사용자' : '负责 MES 用户', data.executor_present && data.executor_matches_lee === false ? (ko ? '다른 검사자' : '其他检验员') : data.executor_id)}
        {source(ko ? '현재 검사자와 담당자 일치' : '与当前检验员一致', data.executor_matches_lee === null ? '—' : data.executor_matches_lee ? (ko ? '일치' : '一致') : (ko ? '불일치' : '不一致'))}
      </dl>
      {data.item_count_matches_expected !== true && <p className="inspection-message" role="status">{ko ? `예정 ${data.expected_item_count}항목과 현재 조회 수가 일치하는지 확인되지 않았습니다.` : `尚未确认当前查询数量与预期 ${data.expected_item_count} 项一致。`}</p>}
      <ol className="inspection-mes-items">{data.items.map((item, index) => <li className="inspection-mes-item" key={item.id}>
        <strong>{index + 1}. {item.name || '—'}</strong>
        <dl className="inspection-mes-values">
          {source(ko ? '그룹' : '分组', item.group_name)}{source(ko ? '단위' : '单位', item.unit.name ?? item.unit.code)}
          {source(ko ? '하한 / 상한' : '下限 / 上限', `${item.minimum ?? '—'} / ${item.maximum ?? '—'}`)}
          {source(ko ? '기준 / 소수 자리' : '基准 / 小数位', `${item.base ?? '—'} / ${item.scale ?? '—'}`)}
          {source(ko ? '규격 조건' : '规格条件', previewSourceEnum(item.logic))}
          {source(ko ? '값 유형' : '值类型', previewSourceEnum(item.value_type))}
          {source(ko ? '입력 요구 원천값' : '填写要求源值', previewSourceEnum(item.required_type))}
          {source(ko ? '허용값' : '允许值', item.options.length ? item.options.join(' · ') : item.missing_fields.includes('options') ? (ko ? '미확인' : '未确认') : (ko ? '없음' : '无'))}
        </dl>
        <p className="inspection-mes-source-id">ID {item.id} · {ko ? '기준 항목' : '标准项目'} {item.check_item_id ?? '—'} · {ko ? '버전' : '版本'} {item.version_id ?? '—'}</p>
      </li>)}</ol>
      <details><summary>{ko ? '승인·입고 관련 원천 설정' : '审批及入库相关源设置'}</summary>
        <dl className="inspection-mes-values">
          {source(ko ? '승인 ID / 코드' : '审批 ID / 编码', data.approval ? `${data.approval.id ?? '—'} / ${data.approval.code ?? '—'}` : null)}
          {source(ko ? '승인 상태 · 의미 미확인' : '审批状态 · 含义未确认', data.approval ? previewSourceEnum(data.approval.status) : null)}
          {(['qcRange', 'materialBatchRecordType', 'sampleProcessMethod', 'recordSample', 'recordSummaryCount'] as const).map((key, index) => <div key={key}><dt>{(ko ? ['검사 범위', '자재 배치 기록', '샘플 처리 방식', '샘플 기록', '집계 수량 기록'] : ['检验范围', '物料批次记录', '样品处理方式', '样品记录', '汇总数量记录'])[index]}</dt><dd>{previewSourceEnum(data.inventory_metadata[key])}</dd></div>)}
          {source(ko ? '검사 자재 / 샘플 자재 수' : '检验物料 / 样品物料数', `${data.inventory_metadata.check_material_count ?? '—'} / ${data.inventory_metadata.sample_material_count ?? '—'}`)}
        </dl>
        <p className="inspection-muted">{ko ? '이 정보만으로 승인 완료나 입고 가능 여부를 판단하지 않습니다.' : '不能仅凭这些信息判断审批完成或是否可以入库。'}</p>
      </details>
      {data.missing_fields.length > 0 && <p className="inspection-muted">{ko ? '미확인 메타데이터' : '未确认元数据'}: {data.missing_fields.join(' · ')}</p>}
    </details>}
  </section>;
}
