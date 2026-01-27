import { useEffect, useMemo, useState } from 'react';
import type { FC, ReactNode } from 'react';
import dayjs from 'dayjs';
import { toast } from 'react-toastify';
import { AxiosError } from 'axios';
import {
  BarChart3, CalendarDays, Loader2, ServerCrash,
  ChevronDown, Activity,
  Package, Target, TrendingUp, Info
} from 'lucide-react';
import { useLang } from '../../i18n';
import { getProductionStatusData } from '../../lib/api';
import DonutChart from '../../components/common/DonutChart';
import { motion } from 'framer-motion';

import { formatInjectionMachineLabel } from '../../lib/productionUtils';
import { InjectionIcon, MachiningIcon } from '../../components/common/CustomIcons';
import { Dialog, Transition } from '@headlessui/react';
import { Fragment } from 'react';

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

const MachineCard: FC<{
  machine: MachineStatus;
  planType: 'injection' | 'machining';
  startAnimation: boolean;
  onOpenDetails: (machine: MachineStatus) => void;
}> = ({ machine, planType, startAnimation, onOpenDetails }) => {
  const { t } = useLang();

  const displayMachineName = planType === 'injection'
    ? formatInjectionMachineLabel(machine.machine_name, t)
    : machine.machine_name;

  const progressColorClass = machine.progress >= 100
    ? 'text-emerald-500'
    : machine.progress > 80
      ? 'text-blue-500'
      : 'text-amber-500';

  const barColorClass = machine.progress >= 100
    ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.3)]'
    : machine.progress > 80
      ? 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.3)]'
      : 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.3)]';

  return (
    <motion.div
      whileHover={{ y: -5, scale: 1.02 }}
      transition={{ type: "spring", stiffness: 300 }}
      className="flex flex-col h-full ring-1 ring-gray-200 bg-white/70 backdrop-blur-md rounded-[32px] overflow-hidden shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] hover:shadow-[0_20px_40px_-12px_rgba(0,0,0,0.1)] hover:ring-blue-300 transition-all duration-300 group cursor-pointer"
      onClick={() => onOpenDetails(machine)}
    >
      <div className="p-6 flex-1 flex flex-col">
        <div className="flex items-start justify-between mb-8">
          <div className="flex gap-4">
            <div className={`p-4 rounded-[20px] shadow-inner ${planType === 'injection' ? 'bg-blue-50/50' : 'bg-emerald-50/50'} group-hover:rotate-6 transition-transform duration-300`}>
              {planType === 'injection' ? (
                <InjectionIcon className="w-8 h-8 text-blue-500" />
              ) : (
                <MachiningIcon className="w-8 h-8 text-emerald-500" />
              )}
            </div>
            <div>
              <h3 className="text-xl font-black text-gray-900 tracking-tight leading-none mb-2">
                {displayMachineName}
              </h3>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${machine.progress > 0 ? 'bg-emerald-400 animate-pulse' : 'bg-gray-300'}`} />
                <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest">
                  {planType === 'injection' ? t('machine') : t('line')}
                </span>
              </div>
            </div>
          </div>
          <div className={`text-2xl font-black ${progressColorClass} tracking-tighter drop-shadow-sm`}>
            {machine.progress}%
          </div>
        </div>

        <div className="mb-8 relative group/bar">
          <div className="h-3 w-full bg-gray-100 rounded-full overflow-hidden p-[2px] border border-gray-50/50">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: startAnimation ? `${Math.min(machine.progress, 100)}%` : 0 }}
              transition={{ duration: 1.5, ease: [0.34, 1.56, 0.64, 1] }}
              className={`h-full ${barColorClass} rounded-full relative`}
            >
              <div className="absolute inset-0 bg-white/20 animate-pulse rounded-full" />
            </motion.div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-auto">
          <div className="bg-gray-50/80 backdrop-blur-sm rounded-2xl p-4 border border-white transition-colors group-hover:bg-white/50">
            <p className="text-[9px] font-black text-gray-400 uppercase tracking-[0.15em] mb-1.5">{t('dashboard_table_actual')}</p>
            <div className="flex items-end gap-1">
              <p className="text-xl font-black text-gray-900 leading-none">{machine.total_actual.toLocaleString()}</p>
              <span className="text-[10px] font-bold text-gray-400 mb-0.5">{t('pieces_unit')}</span>
            </div>
          </div>
          <div className="bg-gray-50/80 backdrop-blur-sm rounded-2xl p-4 border border-white transition-colors group-hover:bg-white/50">
            <p className="text-[9px] font-black text-gray-400 uppercase tracking-[0.15em] mb-1.5">{t('dashboard_table_planned')}</p>
            <div className="flex items-end gap-1">
              <p className="text-xl font-bold text-gray-500 leading-none">{machine.total_planned.toLocaleString()}</p>
              <span className="text-[10px] font-bold text-gray-400 mb-0.5">{t('pieces_unit')}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 py-4 flex items-center justify-between bg-gray-50/50 border-t border-gray-100 group-hover:bg-blue-50/30 transition-colors">
        <span className="text-[10px] font-black text-gray-400 uppercase tracking-widest group-hover:text-blue-500 transition-colors">
          {t('dashboard_production_details')}
        </span>
        <Activity className="w-4 h-4 text-gray-300 group-hover:text-blue-400 group-hover:animate-bounce transition-colors" />
      </div>
    </motion.div>
  );
};

const MachineDetailDrawer: FC<{
  isOpen: boolean;
  onClose: () => void;
  machine: MachineStatus | null;
  planType: 'injection' | 'machining' | null;
}> = ({ isOpen, onClose, machine, planType }) => {
  const { t } = useLang();
  if (!machine) return null;

  const displayMachineName = planType === 'injection'
    ? formatInjectionMachineLabel(machine.machine_name, t)
    : machine.machine_name;

  return (
    <Transition.Root show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-in-out duration-500"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in-out duration-500"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm transition-opacity" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-hidden">
          <div className="absolute inset-0 overflow-hidden">
            <div className="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10">
              <Transition.Child
                as={Fragment}
                enter="transform transition ease-in-out duration-500 sm:duration-700"
                enterFrom="translate-x-full"
                enterTo="translate-x-0"
                leave="transform transition ease-in-out duration-500 sm:duration-700"
                leaveFrom="translate-x-0"
                leaveTo="translate-x-full"
              >
                <Dialog.Panel className="pointer-events-auto w-screen max-w-2xl">
                  <div className="flex h-full flex-col overflow-y-scroll bg-white shadow-2xl">
                    <div className="px-4 py-8 sm:px-8 bg-gradient-to-br from-blue-50 to-white border-b border-gray-100">
                      <div className="flex items-start justify-between">
                        <div className="flex gap-6 items-center">
                          <div className={`p-5 rounded-3xl ${planType === 'injection' ? 'bg-blue-600 shadow-[0_8px_30px_rgb(37,99,235,0.4)]' : 'bg-emerald-600 shadow-[0_8px_30px_rgb(5,150,105,0.4)]'}`}>
                            {planType === 'injection' ? (
                              <InjectionIcon className="w-10 h-10 text-white" />
                            ) : (
                              <MachiningIcon className="w-10 h-10 text-white" />
                            )}
                          </div>
                          <div>
                            <Dialog.Title className="text-3xl font-black text-gray-900 tracking-tighter">
                              {displayMachineName}
                            </Dialog.Title>
                            <div className="flex items-center gap-3 mt-1.5 text-gray-500">
                              <p className="text-sm font-bold flex items-center gap-1.5">
                                <Activity className="w-4 h-4 text-blue-500" />
                                {t('dashboard_production_details')}
                              </p>
                              <span className="w-1 h-1 bg-gray-300 rounded-full" />
                              <p className="text-sm font-bold">{machine.parts.length} {t('pieces_unit')}</p>
                            </div>
                          </div>
                        </div>
                        <div className="ml-3 flex h-7 items-center">
                          <button
                            type="button"
                            className="relative rounded-2xl bg-white p-2 text-gray-400 hover:text-gray-500 hover:shadow-lg transition-all border border-gray-100"
                            onClick={onClose}
                          >
                            <ChevronDown className="h-6 w-6 rotate-[-90deg]" aria-hidden="true" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-6 mt-10">
                        <div className="bg-white p-5 rounded-[24px] shadow-sm border border-gray-100">
                          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">{t('achievement_rate')}</p>
                          <p className={`text-4xl font-black tracking-tighter ${machine.progress >= 100 ? 'text-emerald-500' : 'text-blue-600'}`}>{machine.progress}%</p>
                        </div>
                        <div className="bg-white p-5 rounded-[24px] shadow-sm border border-gray-100 col-span-2">
                          <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-2">{t('dashboard_summary_planned_vs_actual')}</p>
                          <div className="flex items-baseline gap-2">
                            <p className="text-4xl font-black tracking-tighter text-gray-900">{machine.total_actual.toLocaleString()}</p>
                            <p className="text-xl font-bold text-gray-300 tracking-tight">/ {machine.total_planned.toLocaleString()}</p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="relative flex-1 p-4 sm:p-8 bg-gray-50/50">
                      <div className="space-y-6">
                        {machine.parts.map((part, idx) => (
                          <motion.div
                            key={`${part.part_no}-${idx}`}
                            initial={{ opacity: 0, x: 20 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: idx * 0.05 }}
                            className="bg-white p-6 rounded-[28px] border border-gray-100 flex flex-col md:flex-row items-center gap-8 shadow-sm hover:shadow-xl transition-shadow"
                          >
                            <div className="shrink-0 scale-125 md:scale-100">
                              <DonutChart
                                progress={part.progress}
                                actual={part.actual_quantity}
                                planned={part.planned_quantity}
                                size={100}
                                strokeWidth={10}
                              />
                            </div>
                            <div className="flex-1 w-full flex flex-col min-w-0">
                              <div className="flex items-start justify-between mb-4">
                                <div className="min-w-0">
                                  <h4 className="font-black text-gray-900 text-xl tracking-tight truncate group">
                                    <span className="bg-blue-50 text-blue-600 px-2 py-0.5 rounded-lg text-xs mr-2 border border-blue-100 align-middle">PN</span>
                                    {part.part_no}
                                  </h4>
                                  <p className="text-sm font-bold text-gray-400 truncate mt-1">{part.model_name || t('plan_unknown_machine')}</p>
                                </div>
                                <div className="hidden sm:block text-right">
                                  <span className={`text-2xl font-black ${part.progress >= 100 ? 'text-emerald-500' : 'text-blue-600'} tracking-tighter`}>
                                    {part.progress}%
                                  </span>
                                </div>
                              </div>

                              <div className="grid grid-cols-2 gap-4">
                                <div className="flex items-center gap-4 bg-gray-50 p-3 rounded-2xl border border-gray-100">
                                  <div className="p-2 bg-white rounded-xl shadow-sm">
                                    <Package className="w-4 h-4 text-blue-500" />
                                  </div>
                                  <div>
                                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest leading-none mb-1">ACTUAL</p>
                                    <p className="text-lg font-black text-gray-900 leading-none">{part.actual_quantity.toLocaleString()}</p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-4 bg-gray-50 p-3 rounded-2xl border border-gray-100">
                                  <div className="p-2 bg-white rounded-xl shadow-sm">
                                    <Target className="w-4 h-4 text-gray-400" />
                                  </div>
                                  <div>
                                    <p className="text-[10px] font-black text-gray-400 uppercase tracking-widest leading-none mb-1">PLAN</p>
                                    <p className="text-lg font-black text-gray-500 leading-none">{part.planned_quantity.toLocaleString()}</p>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        ))}
                      </div>
                    </div>

                    <div className="shrink-0 border-t border-gray-100 bg-white p-6 sm:px-8">
                      <button
                        type="button"
                        className="w-full rounded-[20px] bg-gray-900 py-4 text-sm font-black text-white shadow-xl hover:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 transition-all uppercase tracking-widest"
                        onClick={onClose}
                      >
                        {t('close')}
                      </button>
                    </div>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
};

const StatCard: FC<{
  title: string;
  value: string | number;
  label?: string;
  icon: ReactNode;
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

const ProductionDashboardPage: FC = () => {
  const { lang, t } = useLang();
  const [targetDate, setTargetDate] = useState(() => dayjs().format('YYYY-MM-DD'));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [startAnimation, setStartAnimation] = useState(false);
  const [selectedMachine, setSelectedMachine] = useState<{ machine: MachineStatus, type: 'injection' | 'machining' } | null>(null);

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
  const stats = useMemo(() => {
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
              label={t('dashboard_trend_steady')}
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
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
                    {data.injection.map((machine) => (
                      <MachineCard
                        key={machine.machine_name}
                        machine={machine}
                        planType="injection"
                        startAnimation={startAnimation}
                        onOpenDetails={(m: MachineStatus) => setSelectedMachine({ machine: m, type: 'injection' })}
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
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
                    {data.machining.map((machine) => (
                      <MachineCard
                        key={machine.machine_name}
                        machine={machine}
                        planType="machining"
                        startAnimation={startAnimation}
                        onOpenDetails={(m: MachineStatus) => setSelectedMachine({ machine: m, type: 'machining' })}
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

        {/* Machine Detail Drawer */}
        <MachineDetailDrawer
          isOpen={selectedMachine !== null}
          onClose={() => setSelectedMachine(null)}
          machine={selectedMachine?.machine || null}
          planType={selectedMachine?.type || null}
        />
      </div>
    </div>
  );
};

export default ProductionDashboardPage;
