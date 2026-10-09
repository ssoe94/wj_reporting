import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { useLang } from '../../i18n';
import { COMPANY_CLASSIFICATION } from '../../domains/hr/company-structure';
import type { HrCurrency, HrDepartment, HrEmployee } from '../../domains/hr/types';
import './company-structure.css';

export type CompanyChartSummary = {
  departments: readonly {
    id: string; direct_total: string | null; total: string | null; direct_count: number; headcount: number;
    known_direct_total?: string; known_total?: string; missing_cost_count?: number; direct_missing_cost_count?: number;
  }[];
};
export type CompanyClassificationChartProps = {
  departments: HrDepartment[]; employees: HrEmployee[]; summary: CompanyChartSummary; currency: HrCurrency;
  onSelect?: (id: string) => void; onMove?: (code: string, target: string | null) => void; disabled?: boolean;
  catalog?: typeof COMPANY_CLASSIFICATION;
};

/** Only the secondary reporting chart uses a scaled viewport. */
export function CompanyChartViewport({ title, description, width, height, children, canvasClass, label }: {
  title: string; description: string; width: number; height: number; children: ReactNode;
  canvasClass?: string; label: string;
}) {
  const { lang } = useLang(); const ko = lang === 'ko';
  const [zoom, setZoom] = useState(0.3);
  const [fitted, setFitted] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const fitSize = useCallback(() => viewport.current ? Math.max(0.12, Math.min(1, (viewport.current.clientWidth - 2) / width, 420 / height)) : 0.3, [width, height]);
  useLayoutEffect(() => {
    if (!fitted) return;
    const fit = () => setZoom(fitSize());
    fit();
    if (typeof ResizeObserver === 'undefined' || !viewport.current) return;
    const observer = new ResizeObserver(fit); observer.observe(viewport.current);
    return () => observer.disconnect();
  }, [fitted, fitSize]);
  return <div className="company-chart company-chart-secondary">
    <div className="company-chart-heading"><div><h2>{title}</h2><p>{description}</p></div><div className="company-chart-controls">
      <button className="hr-icon-button" aria-label={ko ? '조직도 축소' : '缩小组织图'} disabled={zoom <= 0.12} onClick={() => { setFitted(false); setZoom((value) => Math.max(0.12, value - 0.1)); }}><Minus size={16} /></button>
      <span>{Math.round(zoom * 100)}%</span><button className="hr-icon-button" aria-label={ko ? '조직도 확대' : '放大组织图'} disabled={zoom >= 1.3} onClick={() => { setFitted(false); setZoom((value) => Math.min(1.3, value + 0.1)); }}><Plus size={16} /></button>
      <button className="hr-button" onClick={() => { setFitted(true); setZoom(fitSize()); viewport.current?.scrollTo({ left: 0, top: 0 }); }}><Maximize2 size={15} />{ko ? '맞춤' : '适应'}</button>
    </div></div>
    <div ref={viewport} className="company-chart-viewport" tabIndex={0} role="region" aria-label={label}><div className="company-chart-stage" style={{ width: width * zoom, height: height * zoom }}><div className={`company-chart-canvas ${canvasClass ?? ''}`} style={{ width, height, left: '50%', marginLeft: -(width * zoom) / 2, transform: `scale(${zoom})` }}>{children}</div></div></div>
  </div>;
}
