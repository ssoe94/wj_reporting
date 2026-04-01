import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, LogOut, MonitorSmartphone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import ProductionConsole from '@/components/production/ProductionConsole';
import { getFieldStationById, parseFieldTerminalUser } from '@/lib/fieldTerminal';

export default function FieldStationPage() {
  const { stationId } = useParams();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const station = getFieldStationById(stationId);
  const fieldUser = parseFieldTerminalUser(user?.username);

  if (!station) {
    return <Navigate to="/field" replace />;
  }

  return (
    <div className="min-h-screen bg-slate-100 px-3 py-3 md:px-4">
      <div className="mx-auto max-w-[1920px] space-y-4">
        <Card className="rounded-3xl border-slate-200 bg-white/95 p-4 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-2xl bg-blue-100 p-3 text-blue-700">
                <MonitorSmartphone className="h-7 w-7" />
              </div>
              <div>
                <h1 className="text-3xl font-black tracking-tight text-slate-900">{station.label} 작업 화면</h1>
                <p className="text-sm text-slate-600">
                  {station.type === 'injection' ? '사출기' : '가공 라인'} 전용 운영 화면입니다. 현장 입력과 확인을 한 화면에서 처리합니다.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {fieldUser && (
                <span className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
                  계정: {fieldUser.username}
                </span>
              )}
              <Button type="button" variant="secondary" size="lg" className="gap-2" onClick={() => navigate('/field')}>
                <ChevronLeft className="h-4 w-4" />
                스테이션 선택
              </Button>
              <Button type="button" variant="secondary" size="lg" className="gap-2" onClick={logout}>
                <LogOut className="h-4 w-4" />
                로그아웃
              </Button>
            </div>
          </div>
        </Card>

        <div className="rounded-3xl bg-transparent">
          <ProductionConsole
            planType={station.type}
            stationFilter={station.machineFilterValue}
            kioskMode
            title={`${station.label} 운영 콘솔`}
            subtitle={`${station.shortLabel} 계획/실적/C/T/인원/비가동을 현장 터치 화면에서 직접 입력합니다.`}
          />
        </div>
      </div>
    </div>
  );
}

