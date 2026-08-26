import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BarChart3, ClipboardList, Gauge } from 'lucide-react';
import { useLang } from '@/i18n';
import InjectionReportsPanel from './ReportsPanel';
import InjectionSetupPanel from './SetupPanel';

const ProductionConsole = lazy(() => import('@/components/production/ProductionConsole'));

type InjectionDashboardTab = 'console' | 'records' | 'cycle-time';

const tabHash: Record<InjectionDashboardTab, string> = {
  console: '#console',
  records: '#records',
  'cycle-time': '#cycle-time',
};

function getTabFromHash(hash: string): InjectionDashboardTab {
  if (hash === '#records' || hash === '#new' || hash === '#summary' || hash === '#top') {
    return 'records';
  }
  if (hash === '#cycle-time' || hash === '#setup' || hash === '#history') {
    return 'cycle-time';
  }
  return 'console';
}

export default function InjectionDashboardPage() {
  const { t } = useLang();
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<InjectionDashboardTab>(() => getTabFromHash(location.hash));

  const tabs = useMemo(
    () => [
      {
        id: 'console' as const,
        label: '작업 입력',
        description: '계획 대비 실적, 불량, 가동 C/T 입력',
        icon: BarChart3,
      },
      {
        id: 'records' as const,
        label: t('nav_injection_records'),
        description: '기록 조회, CSV, 신규 생산 등록',
        icon: ClipboardList,
      },
      {
        id: 'cycle-time' as const,
        label: t('setup.page_title'),
        description: '사출기 C/T 설정, 테스트, 이력',
        icon: Gauge,
      },
    ],
    [t],
  );

  useEffect(() => {
    setActiveTab(getTabFromHash(location.hash));
  }, [location.hash]);

  useEffect(() => {
    const id = location.hash.replace('#', '');
    if (!id) return;

    window.setTimeout(() => {
      if (id === 'top') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  }, [activeTab, location.hash]);

  const handleTabChange = (tab: InjectionDashboardTab) => {
    setActiveTab(tab);
    navigate(`/injection/dashboard${tabHash[tab]}`);
  };

  return (
    <div id="top" className="mx-auto max-w-[1680px] px-4 py-6 md:px-8">
      <div className="mb-6 rounded-[28px] border border-sky-100 bg-white/80 p-5 shadow-sm backdrop-blur md:p-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.18em] text-sky-700">
              Injection dashboard
            </div>
            <h1 className="mt-3 text-3xl font-black tracking-tight text-slate-950">{t('nav_injection_dashboard')}</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
              사출 생산 입력, 기존 생산기록 조회·등록, C/T 설정을 한 화면에서 관리합니다.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-3 xl:min-w-[720px]">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleTabChange(tab.id)}
                  className={`rounded-2xl border px-4 py-3 text-left transition ${
                    isActive
                      ? 'border-blue-300 bg-blue-50 text-blue-900 shadow-sm'
                      : 'border-slate-200 bg-white/70 text-slate-600 hover:border-blue-200 hover:bg-white'
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm font-black">
                    <Icon className="h-4 w-4" />
                    {tab.label}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{tab.description}</p>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {activeTab === 'console' && (
        <Suspense fallback={<div className="flex min-h-96 items-center justify-center text-lg font-bold text-slate-600">생산 실행 화면을 불러오는 중입니다…</div>}>
          <ProductionConsole
            planType="injection"
            title="사출 생산 실행 관리"
            subtitle="생산계획 기준으로 실적, 불량, 가동 C/T, 작업 메모를 입력합니다."
          />
        </Suspense>
      )}
      {activeTab === 'records' && <InjectionReportsPanel />}
      {activeTab === 'cycle-time' && <InjectionSetupPanel />}
    </div>
  );
}
