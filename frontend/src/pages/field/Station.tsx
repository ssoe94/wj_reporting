import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, LogOut } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { getProductionStatusData } from '@/lib/api';
import { getFieldStationById, parseFieldTerminalUser } from '@/lib/fieldTerminal';
import { useShanghaiBusinessDate } from '@/shared/hooks/useShanghaiBusinessDate';
import InjectionKanban from './InjectionKanban';

const ProductionConsole = lazy(() => import('@/components/production/ProductionConsole'));

class FieldRuntimeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Field terminal render failed', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="grid h-screen place-items-center bg-slate-100 p-8 text-center text-slate-900" role="alert">
        <div className="max-w-2xl rounded-2xl border-2 border-red-200 bg-white p-10 shadow-xl">
          <h1 className="text-4xl font-black">页面运行异常</h1>
          <p className="mt-4 text-xl font-bold text-slate-600">现场数据仍保留在服务器。请重新加载画面。</p>
          <button
            className="mt-8 min-h-16 rounded-xl bg-blue-700 px-10 text-2xl font-black text-white"
            onClick={() => window.location.reload()}
            type="button"
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

const formatUpdateTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `更新时间  ${hours}：${minutes}`;
};

export default function FieldStationPage() {
  const { stationId } = useParams();
  const navigate = useNavigate();
  const { logout, user } = useAuth();

  const station = getFieldStationById(stationId);
  const currentFieldUser = parseFieldTerminalUser(user?.username);
  const assignedInjectionStationMismatch = Boolean(
    station
    && currentFieldUser?.type === 'injection'
    && station.id !== currentFieldUser.stationId,
  );
  const businessDate = useShanghaiBusinessDate();
  const { dataUpdatedAt } = useQuery<any>({
    queryKey: ['production-status-header', businessDate],
    queryFn: () => getProductionStatusData(businessDate),
    enabled: station?.type === 'machining' && !assignedInjectionStationMismatch,
    refetchInterval: 60 * 1000,
    refetchIntervalInBackground: true,
    staleTime: 30 * 1000,
  });

  if (!station) {
    return <Navigate to="/field" replace />;
  }

  if (assignedInjectionStationMismatch && currentFieldUser) {
    return <Navigate to={`/field/${currentFieldUser.stationId}`} replace />;
  }

  if (station.type === 'injection') {
    return (
      <FieldRuntimeBoundary key={station.id}>
        <InjectionKanban onBack={() => navigate(user ? '/field' : '/boards')} station={station} />
      </FieldRuntimeBoundary>
    );
  }

  const stationTitle = `加工${station.shortLabel}`;

  return (
    <div className="h-screen overflow-hidden bg-white p-2">
      <div className="mx-auto flex h-full max-w-[1920px] flex-col gap-2">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center border-2 border-slate-300 bg-white px-5 py-3">
          <div className="text-lg font-bold text-slate-700">{formatUpdateTime(dataUpdatedAt || Date.now())}</div>
          <h1 className="text-center text-4xl font-black text-slate-900">{stationTitle}</h1>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-12 rounded-none border-2 border-slate-300 bg-white px-5 text-lg font-bold text-slate-900 shadow-none"
              onClick={() => navigate('/field')}
            >
              <ChevronLeft className="mr-2 h-5 w-5" />
              工位选择
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-12 rounded-none border-2 border-slate-300 bg-white px-5 text-lg font-bold text-slate-900 shadow-none"
              onClick={logout}
            >
              <LogOut className="mr-2 h-5 w-5" />
              登出
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="flex h-full items-center justify-center text-2xl font-bold text-slate-700">正在读取加工数据…</div>}>
            <ProductionConsole
              planType={station.type}
              stationFilter={station.machineFilterValue}
              kioskMode
              title={stationTitle}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
