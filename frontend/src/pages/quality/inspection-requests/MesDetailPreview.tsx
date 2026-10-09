import { useEffect, useRef, useState } from 'react';
import { isAuthSessionCurrent } from '@/domains/auth/auth-transition';
import { getMesDetailPreview } from './api';
import { canReadMesDetailPreview, mesDetailPreviewDownload, mesDetailPreviewTarget, previewLifecycle, previewRequired, previewSpecification } from './mesDetailPreviewModel';
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
  return <section className="inspection-workspace inspection-detail inspection-mes-preview" aria-label={ko ? '지정 MES 검사 조회' : '查询指定 MES 检验'}>
    <div className="inspection-actions">
      <button type="button" className="inspection-button" disabled={disabled || busy} onClick={() => void load()}>{busy ? (ko ? '조회 중…' : '查询中…') : (ko ? '지정 MES 검사 조회' : '查询指定 MES 检验')}</button>
      <span className="inspection-muted">{mesDetailPreviewTarget} · {ko ? '사출기 선택과 별개로 조회' : '查询对象不随注塑机选择改变'}</span>
    </div>
    {error && <p className="inspection-message is-error" role="alert">{ko ? '지정 MES 검사를 조회하지 못했습니다. MES 연결 상태와 조회 권한을 확인한 뒤 다시 시도해 주세요.' : '无法查询指定 MES 检验。请确认 MES 连接状态和查询权限后重试。'}</p>}
    {data && <div className="inspection-mes-observation">
      <div className="inspection-mes-preview-summary" role="status">
        <strong>{data.qc_code}</strong>
        <span>{previewLifecycle(data.status, 'status', lang, false)}</span>
        <span>{previewLifecycle(data.get_status, 'get_status', lang, false)}</span>
        <span>{data.item_count ?? '—'}{ko ? '항목' : '项'}</span>
        <small className="inspection-muted">{ko ? '조회' : '查询'} {inspectionTime(data.observed_at, lang)}</small>
      </div>
      {data.item_count_matches_expected !== true && <p className="inspection-message" role="status">{ko ? `예정 ${data.expected_item_count}항목과 조회 수를 확인해 주세요.` : `请核对查询数量与预期 ${data.expected_item_count} 项。`}</p>}
      <div className="inspection-table-scroll" role="region" aria-label={ko ? 'MES 검사 기준표' : 'MES 检验标准表'} tabIndex={0}>
        <table className="inspection-history-table inspection-mes-preview-table">
          <caption className="sr-only">{data.qc_code} · {ko ? 'MES 검사 기준' : 'MES 检验标准'}</caption>
          <thead><tr>{(ko ? ['항목', '규격 / 허용값', '단위', '입력'] : ['项目', '规格 / 允许值', '单位', '填写']).map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{data.items.map((item) => <tr key={item.id}>
            <th scope="row">{item.name || '—'}</th>
            <td>{previewSpecification(item, lang)}</td>
            <td>{item.unit.name || item.unit.code || '—'}</td>
            <td>{previewRequired(item.required_type, lang)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <details className="inspection-help">
        <summary><span aria-hidden="true">ⓘ</span>{ko ? '조회 안내' : '查询说明'}</summary>
        <p>{ko ? '검사 기준만 조회하며 측정 결과는 포함하지 않습니다. 사출기별 현재 검사와의 연결은 아직 확인되지 않았습니다.' : '仅查询检验标准，不含测量结果。尚未确认与各注塑机当前检验的关联。'}</p>
        <button type="button" className="inspection-button" disabled={disabled || busy} onClick={download}>{ko ? '조회 메타데이터 내려받기' : '下载查询元数据'}</button>
      </details>
    </div>}
  </section>;
}
