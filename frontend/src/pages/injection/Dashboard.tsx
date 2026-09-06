import { lazy, Suspense } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Activity, ArrowUpRight, BarChart3, ClipboardCheck, ClipboardList, Gauge, PencilLine } from 'lucide-react';
import { useLang } from '@/i18n';
import PermissionLink from '@/components/common/PermissionLink';
import { useShanghaiBusinessDate } from '@/shared/hooks/useShanghaiBusinessDate';
import { buildInjectionLink, resolveInjectionScope } from '@/domains/injection/workspace';
import type { InjectionScope } from '@/domains/injection/workspace';
import { getFieldStationPath } from '@/domains/analysis/model';

const ProductionConsole = lazy(() => import('@/components/production/ProductionConsole'));
const InjectionReportsPanel = lazy(() => import('./ReportsPanel'));
const InjectionSetupPanel = lazy(() => import('./SetupPanel'));
const InjectionEvidencePanel = lazy(() => import('@/domains/injection/InjectionEvidencePanel'));

type Tab = 'overview' | 'field-records' | 'records' | 'console' | 'cycle-time';
function getTab(hash: string): Tab {
  if (['#records', '#new', '#summary', '#top'].includes(hash)) return 'records';
  if (['#cycle-time', '#setup', '#history'].includes(hash)) return 'cycle-time';
  if (hash === '#console') return 'console';
  if (hash === '#field-records') return 'field-records';
  return 'overview';
}

export default function InjectionDashboardPage() {
  const { lang, t } = useLang();
  const tx = (ko: string, zh: string) => lang === 'zh' ? zh : ko;
  const location = useLocation();
  const navigate = useNavigate();
  const currentDate = useShanghaiBusinessDate();
  const scope = resolveInjectionScope(location.search, currentDate);
  const tab = getTab(location.hash);
  const changeScope = (next: InjectionScope) => navigate(buildInjectionLink('/injection/dashboard', next, location.hash || '#overview'));
  const changeDate = (date: string) => changeScope({ ...scope, date: resolveInjectionScope(new URLSearchParams({ date }).toString(), currentDate).date });
  const tabs = [
    { id: 'overview', label: tx('실적 개요', '实绩概览'), description: tx('계획·MES 관측과 현장 기록', '计划、MES 观测与现场记录'), icon: BarChart3 },
    { id: 'field-records', label: tx('현장 기록', '现场记录'), description: tx('구간별 신고·원인·CSV', '区间申报、原因、CSV'), icon: ClipboardCheck },
    { id: 'records', label: tx('수기일보', '手工日报'), description: tx('기존 보고 이력·등록', '既有日报记录与登记'), icon: ClipboardList },
    { id: 'console', label: tx('관리자 실행 입력', '管理报工'), description: tx('계획별 실행 보완 기록', '按计划补录执行记录'), icon: PencilLine },
    { id: 'cycle-time', label: tx('C/T 기준 설정', 'C/T 基准设置'), description: tx('설비 기준·테스트·이력', '设备基准、测试、历史'), icon: Gauge },
  ] as const;
  const sources = [
    [tx('MES 관측 실적', 'MES 观测实绩'), tx('형합수 × Cavity, 계획 순서 배분', '模次 × 穴数，按计划顺序分配'), tx('계획 대비 추정 진도', '与计划比较估算进度')],
    [tx('현장 기록', '现场记录'), tx('저장한 구간과 신고 불량', '已保存区间与申报不良'), tx('현장 신고 추적·원인 확인', '跟踪现场申报与原因')],
    [tx('수기일보', '手工日报'), tx('일보 양식으로 별도 등록한 기록', '独立登记的日报记录'), tx('기존 보고 조회·보완 등록', '查询既有日报与补录')],
    [tx('관리자 실행 입력', '管理报工'), tx('생산계획 행에 연결한 실행 기록', '关联生产计划行的执行记录'), tx('관리자 보완·작업 메모', '管理补录与工作备注')],
  ];
  return <div className="mx-auto max-w-[1680px] px-4 py-4 md:px-8">
    <header className="mb-5 rounded-[28px] border border-sky-100 bg-white/85 p-4 shadow-sm md:p-5">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <h1 className="text-2xl font-black tracking-tight text-slate-950">{t('nav_injection_dashboard')}</h1>
        <nav aria-label={tx('사출 업무 연결', '注塑业务链接')} className="flex flex-wrap gap-2">
          <PermissionLink className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-800" to={buildInjectionLink('/mes/monitoring', scope)}><Activity size={16} />{tx('설비 모니터링', '设备监控')}</PermissionLink>
          <PermissionLink className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700" to={getFieldStationPath(scope.machineNumber)}>{scope.machineNumber === null ? tx('현장 설비 선택', '选择现场设备') : tx('현재 현장 열기', '打开当前现场')}<ArrowUpRight size={16} /></PermissionLink>
        </nav>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-3">
        <label className="text-sm font-semibold text-slate-700">{tx('업무일', '业务日')}<input className="mt-1 block rounded-xl border border-slate-200 bg-white px-3 py-2 font-normal" type="date" value={scope.date} max={currentDate} onChange={(event) => { if (event.target.value) changeDate(event.target.value); }} /></label>
        <button type="button" className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700" onClick={() => changeScope({ ...scope, date: currentDate })}>{tx('오늘', '今天')}</button>
        <label className="text-sm font-semibold text-slate-700">{tx('설비', '设备')}<select className="mt-1 block min-w-36 rounded-xl border border-slate-200 bg-white px-3 py-2 font-normal" value={scope.machineNumber ?? ''} onChange={(event) => changeScope({ ...scope, machineNumber: event.target.value ? Number(event.target.value) : null })}><option value="">{tx('전체 설비', '全部设备')}</option>{Array.from({ length: 17 }, (_, index) => index + 1).map((number) => <option value={number} key={number}>{number}{tx('호기', '号机')}</option>)}</select></label>
        <p className="pb-2 text-xs leading-5 text-slate-500">{tx('중국 업무일 08:00 → 다음 날 08:00 · UTC+8', '中国业务日 08:00 → 次日 08:00 · UTC+8')}{tab === 'cycle-time' && <><br />{tx('C/T 탭은 전체 설비의 현재 기준정보이며 선택일의 과거 상태가 아닙니다.', 'C/T 页为全部设备的当前基准信息，并非所选日期的历史状态。')}</>}</p>
      </div>
      <nav className="mt-4 flex flex-wrap gap-2" aria-label={tx('사출 실적과 기록 탭', '注塑实绩与记录选项')}>
        {tabs.map(({ id, label, description, icon: Icon }) => <button key={id} type="button" title={description} aria-current={tab === id ? 'page' : undefined} onClick={() => navigate(buildInjectionLink('/injection/dashboard', scope, id))} className={`rounded-xl border px-3 py-2 text-left transition ${tab === id ? 'border-blue-300 bg-blue-50 text-blue-900' : 'border-slate-200 bg-white/70 text-slate-600 hover:border-blue-200'}`}><span className="flex items-center gap-2 text-sm font-bold"><Icon size={16} />{label}</span></button>)}
      </nav>
    </header>
    <Suspense fallback={<p role="status" className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-slate-600">{tx('선택한 업무 화면을 불러오는 중입니다.', '正在加载所选业务页面。')}</p>}>
      {(tab === 'overview' || tab === 'field-records') && <InjectionEvidencePanel scope={scope} currentDate={currentDate} view={tab} />}
      {tab === 'records' && <InjectionReportsPanel businessDate={scope.date} machineNumber={scope.machineNumber} onBusinessDateChange={changeDate} />}
      {tab === 'console' && <ProductionConsole planType="injection" businessDate={scope.date} onBusinessDateChange={changeDate} stationFilter={scope.machineNumber === null ? null : `imm${String(scope.machineNumber).padStart(2, '0')}`} title={tx('계획별 실행 보완 입력', '按计划补录执行')} subtitle={tx('관리자가 저장하는 생산 실행 기록입니다. 현장 신고·수기일보와 별도이며 MES 추정 실적에 자동 합산되지 않습니다.', '管理人员保存的生产执行记录。与现场申报、手工日报分开，不自动合入 MES 估算实绩。')} />}
      {tab === 'cycle-time' && <InjectionSetupPanel />}
    </Suspense>
    <details className="mt-6 rounded-2xl border border-slate-200 bg-white/70 p-4 text-sm text-slate-600"><summary className="cursor-pointer font-semibold text-slate-800">{tx('숫자가 다른 이유와 보고서 선택', '数字差异与报表选择')}</summary><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[580px] text-left text-sm"><thead><tr><th className="p-2">{tx('자료', '资料')}</th><th className="p-2">{tx('기준', '口径')}</th><th className="p-2">{tx('사용 목적', '用途')}</th></tr></thead><tbody>{sources.map((row) => <tr className="border-t border-slate-100" key={row[0]}>{row.map((cell) => <td key={cell} className="p-2 align-top">{cell}</td>)}</tr>)}</tbody></table></div><p className="mt-3 leading-6">{tx('이 자료들은 자동 대사되지 않아 합산하면 중복 집계될 수 있습니다. 검사 수량·확정 실행 연결이 준비된 뒤 단일 확정 실적으로 통합합니다.', '这些资料尚未自动对账，合计可能重复统计。需先建立检验数量与确认执行的关联，再统一为确认实绩。')}</p></details>
  </div>;
}
