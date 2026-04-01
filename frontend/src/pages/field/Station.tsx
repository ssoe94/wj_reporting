import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, LogOut } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
  const updatedDate = new Date(dataUpdatedAt || Date.now());
  const updatedText = `更新时间  ${`${updatedDate.getHours()}`.padStart(2, '0')}：${`${updatedDate.getMinutes()}`.padStart(2, '0')}`;

  return (
    <div className="h-screen overflow-hidden bg-slate-100 p-3">
      <div className="mx-auto flex h-full max-w-[1920px] flex-col gap-3">
        <Card className="rounded-3xl border-slate-200 bg-white/95 px-6 py-4 shadow-sm">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
            <div className="text-base font-semibold text-slate-700">{updatedText}</div>
            <h1 className="text-center text-4xl font-black tracking-tight text-slate-900">
              {stationTitle}
            </h1>
            <div className="flex justify-end gap-3">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="gap-2 px-5 text-base"
                onClick={() => navigate('/field')}
              >
                <ChevronLeft className="h-4 w-4" />
                工位选择
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="gap-2 px-5 text-base"
                onClick={logout}
              >
                <LogOut className="h-4 w-4" />
                登出
              </Button>
            </div>
          </div>
        </Card>

        <div className="min-h-0 flex-1 rounded-3xl bg-transparent">
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
