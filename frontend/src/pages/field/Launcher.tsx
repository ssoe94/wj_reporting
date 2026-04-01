import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Factory, LogOut, MonitorSmartphone, Wrench } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { allFieldStations, injectionStations, machiningStations, parseFieldTerminalUser } from '@/lib/fieldTerminal';

export default function FieldLauncherPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const currentFieldUser = useMemo(() => parseFieldTerminalUser(user?.username), [user?.username]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#eff6ff,_#f8fafc_45%,_#e2e8f0_100%)] px-4 py-6 md:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-sm backdrop-blur">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-blue-100 p-3 text-blue-700">
                  <MonitorSmartphone className="h-7 w-7" />
                </div>
                <div>
                  <h1 className="text-3xl font-black tracking-tight text-slate-900">现场终端</h1>
                  <p className="mt-1 text-sm text-slate-600">터치스크린 전용 시작 화면입니다. 설비 또는 라인을 선택해 바로 작업 화면으로 이동합니다.</p>
                </div>
              </div>
              {currentFieldUser && (
                <div className="mt-4 inline-flex rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
                  현재 계정: {currentFieldUser.username} / 기본 스테이션: {currentFieldUser.stationLabel}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                size="lg"
                onClick={() => navigate(currentFieldUser ? `/field/${currentFieldUser.stationId}` : `/field/${allFieldStations[0].id}`)}
              >
                내 스테이션 바로가기
              </Button>
              <Button type="button" variant="secondary" size="lg" onClick={logout} className="gap-2">
                <LogOut className="h-4 w-4" />
                로그아웃
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <Card className="rounded-3xl border-slate-200 shadow-sm">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-blue-100 p-3 text-blue-700">
                  <Factory className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-2xl font-black text-slate-900">注塑</h2>
                  <p className="text-sm text-slate-500">01호기부터 17호기까지 바로 진입</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {injectionStations.map((station) => (
                  <Button
                    key={station.id}
                    type="button"
                    size="lg"
                    className="h-24 rounded-2xl text-xl font-black"
                    onClick={() => navigate(`/field/${station.id}`)}
                  >
                    {station.label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-slate-200 shadow-sm">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-amber-100 p-3 text-amber-700">
                  <Wrench className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-2xl font-black text-slate-900">加工</h2>
                  <p className="text-sm text-slate-500">A라인부터 D라인까지 바로 진입</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                {machiningStations.map((station) => (
                  <Button
                    key={station.id}
                    type="button"
                    size="lg"
                    variant="secondary"
                    className="h-24 rounded-2xl text-xl font-black"
                    onClick={() => navigate(`/field/${station.id}`)}
                  >
                    {station.label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

