import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, LogOut } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import ProductionConsole from '@/components/production/ProductionConsole';
import { getProductionStatusData } from '@/lib/api';
import { getFieldStationById } from '@/lib/fieldTerminal';

const getBusinessDateString = () => {
  const now = new Date();
  const businessDate = new Date(now);
  if (businessDate.getHours() < 8) {
    businessDate.setDate(businessDate.getDate() - 1);
  }
  const adjusted = new Date(businessDate.getTime() - businessDate.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 10);
};

const formatUpdateTime = (timestamp: number) => {
  const date = new Date(timestamp);
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `更新时间  ${hours}：${minutes}`;
};

export default function FieldStationPage() {
  const { stationId } = useParams();
  const navigate = useNavigate();
  const { logout } = useAuth();

  const station = getFieldStationById(stationId);
  const businessDate = getBusinessDateString();
  const { dataUpdatedAt } = useQuery<any>({
    queryKey: ['production-status-header', businessDate],
    queryFn: () => getProductionStatusData(businessDate),
    refetchInterval: 60 * 1000,
    refetchIntervalInBackground: true,
    staleTime: 30 * 1000,
  });

  if (!station) {
    return <Navigate to="/field" replace />;
  }

  const stationTitle = station.type === 'injection' ? `注塑 ${station.shortLabel}` : `加工${station.shortLabel}`;

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
          <ProductionConsole
            planType={station.type}
            stationFilter={station.machineFilterValue}
            kioskMode
            title={stationTitle}
          />
        </div>
      </div>
    </div>
  );
}
