import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
import { useLang } from '@/i18n';
import { useShanghaiBusinessDate } from '@/shared/hooks/useShanghaiBusinessDate';
import { fieldExceptions, fieldOverview } from '@/domains/field-monitoring/api';
import { exceptionRecordFilters } from '@/domains/field-monitoring/model';
import type { FieldException, FieldFilters } from '@/domains/field-monitoring/model';
import FieldStationAdmin from './FieldStationAdmin';
import {
  FieldExceptionsView, FieldLoadError, FieldNotice, FieldOverviewView, FieldRecordsView, FieldStationSelect, panelClass,
} from './FieldMonitoringViews';

type Tab = 'overview' | 'exceptions' | 'records' | 'stations';

function FieldMonitoringWorkspace({ authSessionId, superuser }: {
  authSessionId: string | null;
  superuser: boolean;
}) {
  const { lang, t } = useLang();
  const tx = (ko: string, zh: string) => lang === 'zh' ? zh : ko;
  const currentDay = useShanghaiBusinessDate();
  const [selectedDay, setSelectedDay] = useState('');
  const [station, setStation] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [recordFilters, setRecordFilters] = useState<FieldFilters | null>(null);
  const [recordFormRevision, setRecordFormRevision] = useState(0);
  const recordsTab = useRef<HTMLButtonElement>(null);
  const businessDate = selectedDay || currentDay;
  const scope = { business_date: businessDate, ...(station && { station }) };
  const scopeVisible = tab === 'overview' || tab === 'exceptions';
  const overview = useQuery({
    queryKey: ['field-monitoring', authSessionId, 'overview', businessDate],
    queryFn: ({ signal }) => fieldOverview({ business_date: businessDate }, { authSessionId, signal }),
    enabled: tab !== 'stations',
    retry: false,
    refetchInterval: scopeVisible ? 60_000 : false,
  });
  const exceptions = useQuery({
    queryKey: ['field-monitoring', authSessionId, 'exceptions', scope],
    queryFn: ({ signal }) => fieldExceptions(scope, { authSessionId, signal }),
    enabled: tab === 'exceptions',
    retry: false,
    refetchInterval: tab === 'exceptions' ? 60_000 : false,
  });
  const overviewStations = overview.data?.stations ?? [];
  const filteredStations = station
    ? overviewStations.filter(item => item.station_id === station) : overviewStations;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: tx('현황', '状态总览') },
    { id: 'exceptions', label: tx('예외', '异常') },
    { id: 'records', label: tx('기록 검색', '记录查询') },
  ];
  if (superuser) tabs.push({ id: 'stations', label: tx('현장 PC 관리', '现场电脑管理') });

  function changeTab(next: Tab) {
    if (tab === next) return;
    if (next === 'records' && recordFilters === null) {
      setRecordFilters({ from: businessDate, to: businessDate, station });
    }
    setTab(next);
  }

  function exceptionSearch(row: FieldException) {
    setRecordFilters(exceptionRecordFilters(businessDate, row.station_id, row.filters));
    setRecordFormRevision(value => value + 1);
    setTab('records');
    recordsTab.current?.focus();
  }

  return <div className="mx-auto grid w-full min-w-0 max-w-[1440px] gap-3 px-4 py-4 text-[var(--wj-text)] md:px-6">
    <header>
      <h1 className="text-2xl font-semibold">{t('nav_injection_field_monitoring')}</h1>
      <p className="mt-1 text-sm leading-6 text-[var(--wj-muted)]">
        {tx('접속 표시는 하트비트 수신 상태입니다. 실제 작업은 장치 입력과 기록으로 확인하고, 판정의 정확성은 기준 샘플로 검증합니다.', '连接状态来自心跳记录。实际作业以设备输入和记录为准，判定准确性通过标准样件验证。')}
      </p>
    </header>
    <nav aria-label={tx('현장 모니터링 화면', '现场监控视图')} className="flex flex-wrap gap-1.5">
      {tabs.map(item => <Button key={item.id} type="button" ref={item.id === 'records' ? recordsTab : undefined}
        variant={tab === item.id ? 'primary' : 'secondary'} aria-pressed={tab === item.id}
        onClick={() => changeTab(item.id)}>{item.label}</Button>)}
    </nav>
    {scopeVisible && <div className={`${panelClass} grid grid-cols-1 items-end gap-3 p-3 sm:grid-cols-[auto_minmax(0,18rem)_auto] sm:justify-start`}>
      <label className="block min-w-0 text-sm">
        <span className="mb-1 block font-medium">{tx('업무일 (상하이 08:00)', '业务日 (上海 08:00)')}</span>
        <Input className="min-h-10" type="date" value={businessDate} onChange={event => { setSelectedDay(event.target.value); setRecordFilters(null); }} />
      </label>
      <FieldStationSelect stations={overviewStations} value={station} onChange={value => { setStation(value); setRecordFilters(null); }} tx={tx} />
      <div><Button type="button" variant="secondary" disabled={overview.isFetching || (tab === 'exceptions' && exceptions.isFetching)} onClick={() => {
        void overview.refetch();
        if (tab === 'exceptions') void exceptions.refetch();
      }}>{tx('새로고침', '刷新')}</Button></div>
    </div>}
    {tab !== 'stations' && overview.isError && <FieldLoadError tx={tx} retry={() => void overview.refetch()} />}
    {tab === 'overview' && overview.isPending && <FieldNotice>{tx('현황을 불러오는 중입니다.', '正在加载状态。')}</FieldNotice>}
    {tab === 'overview' && overview.data && <FieldOverviewView stations={filteredStations} tx={tx} />}
    {tab === 'exceptions' && exceptions.isPending && <FieldNotice>{tx('예외를 불러오는 중입니다.', '正在加载异常。')}</FieldNotice>}
    {tab === 'exceptions' && exceptions.isError && <FieldLoadError tx={tx} retry={() => void exceptions.refetch()} />}
    {tab === 'exceptions' && exceptions.data && <FieldExceptionsView rows={exceptions.data} onSearch={exceptionSearch} tx={tx} />}
    {tab === 'records' && <FieldRecordsView
      key={recordFormRevision}
      tx={tx}
      authSessionId={authSessionId}
      stations={overviewStations}
      applied={recordFilters ?? { from: businessDate, to: businessDate, station }}
      onApply={setRecordFilters}
    />}
    {tab === 'stations' && superuser && <FieldStationAdmin tx={tx} authSessionId={authSessionId} />}
  </div>;
}

export default function FieldMonitoringPage() {
  const { authSessionId, user } = useAuth();
  return <FieldMonitoringWorkspace key={authSessionId} authSessionId={authSessionId} superuser={user?.is_superuser === true} />;
}
