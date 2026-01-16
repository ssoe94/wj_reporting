import React, { useState, useEffect } from 'react';
import dayjs from 'dayjs';
import { toast } from 'react-toastify';
import { AxiosError } from 'axios';
import {
  BarChart3, CalendarDays, Loader2, ServerCrash,
  ChevronDown, ChevronUp, Activity,
  Package, Target, TrendingUp, Info
} from 'lucide-react';
import { useLang } from '../../i18n';
import { getProductionStatusData } from '../../lib/api';
import DonutChart from '../../components/common/DonutChart';
import { motion, AnimatePresence } from 'framer-motion';

import { formatInjectionMachineLabel } from '../../lib/productionUtils';
import { InjectionIcon, MachiningIcon } from '../../components/common/CustomIcons';

interface PartStatus {
  part_no: string;
  model_name: string;
  planned_quantity: number;
  actual_quantity: number;
  progress: number;
}

interface MachineStatus {
  machine_name: string;
  total_planned: number;
  total_actual: number;
  progress: number;
  parts: PartStatus[];
}

interface DashboardData {
  injection: MachineStatus[];
  machining: MachineStatus[];
}

const MachineCard: React.FC<{
  machine: MachineStatus;
  planType: 'injection' | 'machining';
  startAnimation: boolean;
}> = ({ machine, planType, startAnimation }) => {
  const { lang, t } = useLang();
  const [isExpanded, setIsExpanded] = useState(false);

  const displayMachineName = planType === 'injection'
    ? formatInjectionMachineLabel(machine.machine_name, t)
    : machine.machine_name;

  const progressColorClass = machine.progress >= 100
    ? 'text-green-500'
    : machine.progress > 80
      ? 'text-blue-500'
      : 'text-orange-500';

  const barColorClass = machine.progress >= 100
    ? 'bg-green-500'
    : machine.progress > 80
      ? 'bg-blue-500'
      : 'bg-orange-500';

  return (
    <div className="flex flex-col h-full ring-1 ring-gray-200 bg-white rounded-3xl overflow-hidden shadow-sm hover:shadow-xl hover:ring-blue-200 transition-all duration-300 group">
      {/* Card Header & Main Stats */}
      <div
        className="p-5 flex-1 flex flex-col cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-start justify-between mb-6">
          <div className="flex gap-4">
            <div className={`p-3 rounded-2xl ${planType === 'injection' ? 'bg-blue-50' : 'bg-green-50'} group-hover:scale-110 transition-transform duration-300`}>
              {planType === 'injection' ? (
                <InjectionIcon className="w-7 h-7 text-blue-500" />
              ) : (
                <MachiningIcon className="w-7 h-7 text-green-500" />
              )}
            </div>
            <div>
              <h3 className="text-lg font-black text-gray-900 tracking-tight leading-none mb-1.5">
                {displayMachineName}
              </h3>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full animate-pulse ${machine.progress > 0 ? 'bg-green-500' : 'bg-gray-300'}`} />
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                  {planType === 'injection' ? t('machine') : t('line')}
                </span>
              </div>
            </div>
          </div>
          <div className={`text-2xl font-black ${progressColorClass} tracking-tighter`}>
            {machine.progress}%
          </div>
        </div>

        {/* Progress Bar (Compact) */}
        <div className="mb-6 space-y-2">
          <div className="h-2.5 w-full bg-gray-100 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: startAnimation ? `${Math.min(machine.progress, 100)}%` : 0 }}
              transition={{ duration: 1.2, ease: "circOut" }}
              className={`h-full ${barColorClass} rounded-full`}
            />
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-4 mt-auto">
          <div className="bg-gray-50/50 rounded-2xl p-3 border border-gray-100/50">
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">{t('dashboard_table_actual')}</p>
            <p className="text-lg font-bold text-gray-900 leading-none">{machine.total_actual.toLocaleString()}</p>
          </div>
          <div className="bg-gray-50/50 rounded-2xl p-3 border border-gray-100/50">
            <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">{t('dashboard_table_planned')}</p>
            <p className="text-lg font-bold text-gray-500 leading-none">{machine.total_planned.toLocaleString()}</p>
          </div>
        </div>
      </div>

      {/* Expand/Collapse Footer */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full py-2.5 bg-gray-50/80 hover:bg-gray-100 border-t border-gray-100 flex items-center justify-center transition-colors gap-2"
      >
        <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
          {isExpanded ? t('close') : t('dashboard_production_details')}
        </span>
        {isExpanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
      </button>

      {/* Expanded Details */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden border-t border-gray-100 bg-gray-50/50"
          >
            <div className="p-4 space-y-3">
              {machine.parts.map((part, idx) => (
                <div key={`${part.part_no}-${idx}`} className="bg-white p-3 rounded-2xl border border-gray-200/60 flex items-center gap-4 shadow-sm">
                  <DonutChart
                    progress={part.progress}
                    actual={part.actual_quantity}
                    planned={part.planned_quantity}
                    size={48}
                    strokeWidth={5}
                    hideQuantity={true}
                  />
                  <div className="flex-1 min-w-0">
                    <h4 className="font-bold text-gray-800 text-xs truncate mb-0.5">{part.part_no}</h4>
                    <p className="text-[10px] text-gray-400 truncate mb-1">{part.model_name || t('plan_unknown_machine')}</p>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1">
                        <Package className="w-2.5 h-2.5 text-blue-500" />
                        <span className="text-[10px] font-bold text-gray-700">{part.actual_quantity.toLocaleString()}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <Target className="w-2.5 h-2.5 text-gray-300" />
                        <span className="text-[10px] font-medium text-gray-400">{part.planned_quantity.toLocaleString()}</span>
                      </div>
                      <div className="ml-auto text-[10px] font-black text-blue-600">{part.progress}%</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

const StatCard: React.FC<{
  title: string;
  value: string | number;
  label?: string;
  icon: React.ReactNode;
  colorClass: string;
  delay?: number;
}> = ({ title, value, label, icon, colorClass, delay = 0 }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.5, delay }}
    className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex items-center gap-6"
  >
    <div className={`p-4 rounded-2xl ${colorClass}`}>
      {icon}
    </div>
    <div>
      <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1">{title}</p>
      <div className="flex items-baseline gap-2">
        <h4 className="text-3xl font-black text-gray-900 tracking-tighter">{value}</h4>
        {label && <span className="text-xs font-bold text-gray-400">{label}</span>}
      </div>
    </div>
  </motion.div>
);

const ProductionDashboardPage: React.FC = () => {
  const { lang, t } = useLang();
  const [targetDate, setTargetDate] = useState(() => dayjs().format('YYYY-MM-DD'));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [startAnimation, setStartAnimation] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setStartAnimation(false);
      setError(null);
      setData(null);

      try {
        const response = await getProductionStatusData(targetDate);
        setData(response);
        if (response.injection.length === 0 && response.machining.length === 0) {
          toast.info(t('dashboard_no_data_found'));
        }
      } catch (err) {
        const axiosError = err as AxiosError<{ error?: string }>;
        const errorMessage = axiosError.response?.data?.error || 'An unexpected error occurred';
        setError(errorMessage);
        toast.error(errorMessage);
      } finally {
        setIsLoading(false);
        setTimeout(() => setStartAnimation(true), 200);
      }
    };

    fetchData();
  }, [targetDate, t]);

  // Aggregate statistics
  const stats = React.useMemo(() => {
    if (!data) return null;
    const all = [...data.injection, ...data.machining];
    const totalPlanned = all.reduce((sum, item) => sum + item.total_planned, 0);
    const totalActual = all.reduce((sum, item) => sum + item.total_actual, 0);
    const avgProgress = all.length > 0 ? (totalActual / totalPlanned) * 100 : 0;
    const activeCount = all.filter(item => item.total_actual > 0).length;

    return {
      avgProgress: Math.round(avgProgress),
      activeCount,
      totalActual,
      totalPlanned
    };
  }, [data]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] pb-20">
      <div className="container mx-auto p-4 md:p-8 space-y-10 max-w-[1600px]">
        {/* Header Section */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-white rounded-2xl shadow-sm border border-blue-50 flex items-center justify-center">
              <BarChart3 className="w-8 h-8 text-blue-600" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-4">
                <h1 className="text-3xl font-black text-gray-900 tracking-tighter">
                  {t('nav_production_dashboard')}
                </h1>

                {/* Integrated Date Picker */}
                <div className="relative group flex items-center bg-white border border-gray-200 rounded-xl px-3 py-1.5 shadow-sm hover:border-blue-400 hover:ring-4 hover:ring-blue-50 transition-all cursor-pointer">
                  <CalendarDays className="w-4 h-4 text-blue-500 mr-2" />
                  <style>{`
                    .custom-date-input::-webkit-calendar-picker-indicator {
                      background: transparent;
                      bottom: 0;
                      color: transparent;
                      cursor: pointer;
                      height: auto;
                      left: 0;
                      position: absolute;
                      right: 0;
                      top: 0;
                      width: auto;
                    }
                  `}</style>
                  <input
                    id="date-picker"
                    type="date"
                    className="custom-date-input bg-transparent border-none p-0 text-sm font-black text-gray-700 focus:ring-0 outline-none w-32"
                    value={targetDate}
                    onChange={(event) => setTargetDate(event.target.value)}
                  />
                </div>
              </div>
              <p className="text-gray-400 font-bold flex items-center gap-2 text-xs mt-1">
                <Info className="w-3 h-3 text-blue-300" />
                {t('dashboard_description')}
              </p>
            </div>
          </div>
        </header>

        {/* KPI Summary Grid */}
        {stats && !isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatCard
              title={t('dashboard_summary_total_achievement')}
              value={`${stats.avgProgress}%`}
              icon={<TrendingUp className="w-6 h-6 text-blue-600" />}
              colorClass="bg-blue-50"
              delay={0.1}
            />
            <StatCard
              title={t('dashboard_summary_active_machines')}
              value={stats.activeCount}
              label={t('unit.records') || (lang === 'ko' ? '건' : '件')}
              icon={<Activity className="w-6 h-6 text-green-600" />}
              colorClass="bg-green-50"
              delay={0.2}
            />
            <StatCard
              title={t('dashboard_summary_planned_vs_actual')}
              value={stats.totalActual.toLocaleString()}
              label={`/ ${stats.totalPlanned.toLocaleString()}`}
              icon={<Package className="w-6 h-6 text-orange-600" />}
              colorClass="bg-orange-50"
              delay={0.3}
            />
            <StatCard
              title={t('dashboard_summary_trend')}
              value="+"
              label="Steady"
              icon={<BarChart3 className="w-6 h-6 text-indigo-600" />}
              colorClass="bg-indigo-50"
              delay={0.4}
            />
          </div>
        )}

        {/* Content Section */}
        <main>
          {isLoading && (
            <div className="flex flex-col justify-center items-center py-32 gap-6">
              <div className="relative">
                <Loader2 className="h-20 w-20 text-blue-500 animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Activity className="w-8 h-8 text-blue-300" />
                </div>
              </div>
              <p className="text-gray-400 font-black animate-pulse text-lg uppercase tracking-widest">{t('dashboard_loading')}</p>
            </div>
          )}

          {error && !isLoading && (
            <div className="bg-red-50/50 border border-red-100 text-red-800 rounded-[40px] p-16 text-center max-w-2xl mx-auto shadow-sm">
              <ServerCrash className="h-24 w-24 mx-auto mb-8 text-red-200" />
              <h3 className="text-3xl font-black mb-3 tracking-tighter">{t('dashboard_error_title')}</h3>
              <p className="text-red-600/70 font-bold text-lg">{error}</p>
            </div>
          )}

          {data && !isLoading && !error && (
            <div className="space-y-16">
              {/* Injection Section */}
              {data.injection.length > 0 && (
                <section className="space-y-8">
                  <div className="flex items-center justify-between border-b border-gray-100 pb-6 ml-2">
                    <div className="flex items-center gap-6">
                      <div className="h-10 w-2.5 bg-blue-500 rounded-full shadow-[0_0_15px_rgba(59,130,246,0.6)]" />
                      <h2 className="text-3xl font-black text-gray-900 tracking-tighter flex items-center gap-4">
                        {t('plan_toggle_injection')}
                        <span className="px-5 py-2 bg-blue-50 text-blue-600 text-sm font-black rounded-2xl tracking-tight border border-blue-100 shadow-sm">
                          {data.injection.length} {t('machine')} {t('in_production')}
                        </span>
                      </h2>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {data.injection.map((machine) => (
                      <MachineCard
                        key={machine.machine_name}
                        machine={machine}
                        planType="injection"
                        startAnimation={startAnimation}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* Machining Section */}
              {data.machining.length > 0 && (
                <section className="space-y-8">
                  <div className="flex items-center justify-between border-b border-gray-100 pb-6 ml-2">
                    <div className="flex items-center gap-6">
                      <div className="h-10 w-2.5 bg-green-500 rounded-full shadow-[0_0_15px_rgba(34,197,94,0.6)]" />
                      <h2 className="text-3xl font-black text-gray-900 tracking-tighter flex items-center gap-4">
                        {t('plan_toggle_machining')}
                        <span className="px-5 py-2 bg-green-50 text-green-600 text-sm font-black rounded-2xl tracking-tight border border-green-100 shadow-sm">
                          {data.machining.length} {t('line')} {t('in_production')}
                        </span>
                      </h2>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {data.machining.map((machine) => (
                      <MachineCard
                        key={machine.machine_name}
                        machine={machine}
                        planType="machining"
                        startAnimation={startAnimation}
                      />
                    ))}
                  </div>
                </section>
              )}

              {!data.injection.length && !data.machining.length && (
                <div className="py-40 text-center bg-white rounded-[40px] border-2 border-dashed border-gray-200">
                  <Package className="w-24 h-24 text-gray-100 mx-auto mb-8" />
                  <p className="text-gray-400 font-bold text-2xl tracking-tighter underline underline-offset-8 decoration-gray-100">
                    {t('dashboard_no_data_found')}
                  </p>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

export default ProductionDashboardPage;