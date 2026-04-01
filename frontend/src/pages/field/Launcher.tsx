import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { getProductionPlanSummary } from '@/lib/api';
import {
  injectionStations,
  machiningStations,
  matchesFieldStation,
  parseFieldTerminalUser,
  type FieldStation,
} from '@/lib/fieldTerminal';

type PlanItem = {
  machine_name: string;
  planned_quantity: number;
};

type LauncherCell =
  | { key: string; station: FieldStation; accentGap: boolean }
  | { key: string; station: null; accentGap: boolean };

function getBusinessDateString() {
  const now = new Date();
  const businessDate = new Date(now);
  if (now.getHours() < 8) {
    businessDate.setDate(businessDate.getDate() - 1);
  }
  return format(businessDate, 'yyyy-MM-dd');
}

export default function FieldLauncherPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const currentFieldUser = useMemo(() => parseFieldTerminalUser(user?.username), [user?.username]);
  const businessDate = useMemo(() => getBusinessDateString(), []);

  const { data: planData } = useQuery({
    queryKey: ['field-launcher-plan-status', businessDate],
    queryFn: async () => {
      const summary = await getProductionPlanSummary(businessDate);
      return {
        injection: Array.isArray(summary?.injection?.records) ? (summary.injection.records as PlanItem[]) : [],
        machining: Array.isArray(summary?.machining?.records) ? (summary.machining.records as PlanItem[]) : [],
      };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const activeStationIds = useMemo(() => {
    const active = new Set<string>();

    for (const station of injectionStations) {
      const hasPlan = (planData?.injection || []).some(
        (item) => Number(item.planned_quantity || 0) > 0 && matchesFieldStation(item.machine_name, station),
      );
      if (hasPlan) active.add(station.id);
    }

    for (const station of machiningStations) {
      const hasPlan = (planData?.machining || []).some(
        (item) => Number(item.planned_quantity || 0) > 0 && matchesFieldStation(item.machine_name, station),
      );
      if (hasPlan) active.add(station.id);
    }

    return active;
  }, [planData]);

  const gridCells = useMemo<LauncherCell[]>(() => {
    const cells: LauncherCell[] = [];

    for (let row = 0; row < 4; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        const index = row * 5 + col;
        const station = injectionStations[index] ?? null;
        cells.push({
          key: station?.id ?? `blank-${row}-${col}`,
          station,
          accentGap: false,
        });
      }

      cells.push({
        key: machiningStations[row].id,
        station: machiningStations[row],
        accentGap: true,
      });
    }

    return cells;
  }, []);

  return (
    <div className="min-h-screen overflow-hidden bg-[#eef3f8] text-slate-900">
      <div className="mx-auto flex h-screen w-full max-w-[1920px] flex-col px-4 py-4">
        <section className="flex h-[88px] items-center justify-between rounded-2xl border border-slate-200 bg-white px-6 shadow-sm">
          <div className="min-w-0">
            <h1 className="text-[34px] font-black tracking-tight text-slate-900">现场终端</h1>
            <div className="mt-1 text-[18px] font-semibold text-slate-600">
              当前账号: {currentFieldUser?.username || '-'} / 基本工位: {currentFieldUser?.stationLabel || '-'}
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="h-12 rounded-xl border border-slate-300 bg-white px-5 text-lg font-bold text-slate-700 hover:bg-slate-50"
            onClick={logout}
          >
            <LogOut className="mr-2 h-5 w-5" />
            登出
          </Button>
        </section>

        <section className="mt-4 grid min-h-0 flex-1 grid-cols-6 grid-rows-4 gap-4">
          {gridCells.map((cell) => {
            if (!cell.station) {
              return <div key={cell.key} className="pointer-events-none" />;
            }

            const hasPlan = activeStationIds.has(cell.station.id);
            const isInjection = cell.station.type === 'injection';
            const activeClass = isInjection
              ? 'border-blue-300 bg-[#2563eb] text-white hover:bg-[#1d4ed8]'
              : 'border-amber-300 bg-[#f59e0b] text-white hover:bg-[#d97706]';
            const inactiveClass =
              'border-slate-300 bg-slate-300 text-slate-600 hover:bg-slate-300';

            return (
              <div key={cell.key} className={cell.accentGap ? 'translate-x-2' : ''}>
                <button
                  type="button"
                  onClick={() => navigate(`/field/${cell.station.id}`)}
                  className={`flex h-full min-h-0 w-full items-center justify-center rounded-2xl border text-center shadow-sm transition ${
                    hasPlan ? activeClass : inactiveClass
                  }`}
                >
                  <span className="text-[34px] font-black tracking-tight">{cell.station.label}</span>
                </button>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
