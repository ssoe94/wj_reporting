import { useEffect, useMemo, useRef, useState } from 'react';
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

const roundQty = (value: number) => Math.round(value);

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
    ? 'text-[var(--wj-success)]'
    : machine.progress > 80
      ? 'text-[var(--wj-info)]'
      : 'text-[var(--wj-warning)]';

  const barColorClass = machine.progress >= 100
    ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.3)]'
    : machine.progress > 80
      ? 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.3)]'
      : 'bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.3)]';

  const plannedDisplay = roundQty(machine.total_planned);
  const actualDisplay = roundQty(machine.total_actual);

  return (
    <motion.div
      whileHover={{ y: -5, scale: 1.02 }}
      transition={{ type: "spring", stiffness: 300 }}
      className="flex flex-col h-full ring-1 ring-[var(--wj-border)] bg-[var(--wj-surface-solid)] backdrop-blur-md rounded-[32px] overflow-hidden shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] hover:shadow-[0_20px_40px_-12px_rgba(0,0,0,0.1)] hover:ring-[var(--wj-border)] transition-all duration-300 group cursor-pointer"
      onClick={() => onOpenDetails(machine)}
    >
      <div className="p-6 flex-1 flex flex-col">
        <div className="flex items-start justify-between mb-8">
          <div className="flex gap-4">
            <div className={`p-4 rounded-[20px] shadow-inner ${planType === 'injection' ? 'bg-[var(--wj-bg-strong)]' : 'bg-[var(--wj-success-bg)]'} group-hover:rotate-6 transition-transform duration-300`}>
              {planType === 'injection' ? (
                <InjectionIcon className="w-8 h-8 text-[var(--wj-accent-strong)]" />
              ) : (
                <MachiningIcon className="w-8 h-8 text-[var(--wj-success)]" />
              )}
            </div>
            <div>
              <h3 className="text-xl font-black text-[var(--wj-text)] tracking-tight leading-none mb-2">
                {displayMachineName}
              </h3>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${machine.progress > 0 ? 'bg-[var(--wj-success-bg)] animate-pulse' : 'bg-[var(--wj-bg-strong)]'}`} />
                <span className="text-[10px] font-black text-[var(--wj-muted)] uppercase tracking-widest">
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
          <div className="h-3 w-full bg-[var(--wj-bg-strong)] rounded-full overflow-hidden p-[2px] border border-[var(--wj-border)]">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: startAnimation ? `${Math.min(machine.progress, 100)}%` : 0 }}
              transition={{ duration: 1.5, ease: [0.34, 1.56, 0.64, 1] }}
              className={`h-full ${barColorClass} rounded-full relative`}
            >
              <div className="absolute inset-0 bg-[var(--wj-surface-solid)] animate-pulse rounded-full" />
            </motion.div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-auto">
          <div className="bg-[var(--wj-surface-solid)] backdrop-blur-sm rounded-2xl p-4 border border-[var(--wj-border)] transition-colors group-hover:bg-[var(--wj-surface-solid)]">
            <p className="text-[9px] font-black text-[var(--wj-muted)] uppercase tracking-[0.15em] mb-1.5">{t('dashboard_table_actual')}</p>
            <div className="flex items-end gap-1">
              <p className="text-xl font-black text-[var(--wj-text)] leading-none">{actualDisplay.toLocaleString()}</p>
              <span className="text-[10px] font-bold text-[var(--wj-muted)] mb-0.5">{t('pieces_unit')}</span>
            </div>
          </div>
          <div className="bg-[var(--wj-surface-solid)] backdrop-blur-sm rounded-2xl p-4 border border-[var(--wj-border)] transition-colors group-hover:bg-[var(--wj-surface-solid)]">
            <p className="text-[9px] font-black text-[var(--wj-muted)] uppercase tracking-[0.15em] mb-1.5">{t('dashboard_table_planned')}</p>
            <div className="flex items-end gap-1">
              <p className="text-xl font-bold text-[var(--wj-muted)] leading-none">{plannedDisplay.toLocaleString()}</p>
              <span className="text-[10px] font-bold text-[var(--wj-muted)] mb-0.5">{t('pieces_unit')}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 py-4 flex items-center justify-between bg-[var(--wj-surface-solid)] border-t border-[var(--wj-border)] group-hover:bg-[var(--wj-bg-strong)] transition-colors">
        <span className="text-[10px] font-black text-[var(--wj-muted)] uppercase tracking-widest group-hover:text-[var(--wj-accent-strong)] transition-colors">
          {t('dashboard_production_details')}
        </span>
        <Activity className="w-4 h-4 text-[var(--wj-muted)] group-hover:text-[var(--wj-accent-strong)] group-hover:animate-bounce transition-colors" />
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
          <div className="fixed inset-0 bg-[var(--wj-nav-surface)] backdrop-blur-sm transition-opacity" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 sm:p-8">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              enterTo="opacity-100 translate-y-0 sm:scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 translate-y-0 sm:scale-100"
              leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            >
              <Dialog.Panel className="w-full max-w-3xl overflow-hidden rounded-[32px] bg-[var(--wj-surface-solid)] shadow-2xl ring-1 ring-[var(--wj-border)]">
                <div className="max-h-[85vh] overflow-y-auto">
                  <div className="px-4 py-8 sm:px-8 bg-gradient-to-br from-[var(--wj-bg-strong)] to-[var(--wj-surface-solid)] border-b border-[var(--wj-border)]">
                    <div className="flex items-start justify-between">
                      <div className="flex gap-6 items-center">
                        <div className={`p-5 rounded-3xl ${planType === 'injection' ? 'bg-[var(--wj-accent-strong)] shadow-[0_8px_30px_rgb(37,99,235,0.4)]' : 'bg-[var(--wj-success)] shadow-[0_8px_30px_rgb(5,150,105,0.4)]'}`}>
                          {planType === 'injection' ? (
                            <InjectionIcon className="w-10 h-10 text-[var(--wj-on-accent)]" />
                          ) : (
                            <MachiningIcon className="w-10 h-10 text-[var(--wj-on-accent)]" />
                          )}
                        </div>
                        <div>
                          <Dialog.Title className="text-3xl font-black text-[var(--wj-text)] tracking-tighter">
                            {displayMachineName}
                          </Dialog.Title>
                          <div className="flex items-center gap-3 mt-1.5 text-[var(--wj-muted)]">
                            <p className="text-sm font-bold flex items-center gap-1.5">
                              <Activity className="w-4 h-4 text-[var(--wj-accent-strong)]" />
                              {t('dashboard_production_details')}
                            </p>
                            <span className="w-1 h-1 bg-[var(--wj-bg-strong)] rounded-full" />
                            <p className="text-sm font-bold">{machine.parts.length} {t('pieces_unit')}</p>
                          </div>
                        </div>
                      </div>
                      <div className="ml-3 flex h-7 items-center">
                        <button
                          type="button"
                          className="relative rounded-2xl bg-[var(--wj-surface-solid)] p-2 text-[var(--wj-muted)] hover:text-[var(--wj-muted)] hover:shadow-lg transition-all border border-[var(--wj-border)]"
                          onClick={onClose}
                        >
                          <ChevronDown className="h-6 w-6 rotate-180" aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-6 mt-10">
                      <div className="bg-[var(--wj-surface-solid)] p-5 rounded-[24px] shadow-sm border border-[var(--wj-border)]">
                        <p className="text-[10px] font-black text-[var(--wj-muted)] uppercase tracking-widest mb-2">{t('achievement_rate')}</p>
                        <p className={`text-4xl font-black tracking-tighter ${machine.progress >= 100 ? 'text-[var(--wj-success)]' : 'text-[var(--wj-accent-strong)]'}`}>{machine.progress}%</p>
                      </div>
                      <div className="bg-[var(--wj-surface-solid)] p-5 rounded-[24px] shadow-sm border border-[var(--wj-border)] col-span-2">
                        <p className="text-[10px] font-black text-[var(--wj-muted)] uppercase tracking-widest mb-2">{t('dashboard_summary_planned_vs_actual')}</p>
                        <div className="flex items-baseline gap-2">
                          <p className="text-4xl font-black tracking-tighter text-[var(--wj-text)]">{roundQty(machine.total_actual).toLocaleString()}</p>
                          <p className="text-xl font-bold text-[var(--wj-muted)] tracking-tight">/ {roundQty(machine.total_planned).toLocaleString()}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="relative p-4 sm:p-8 bg-[var(--wj-surface-solid)]">
                    <div className="space-y-6">
                      {machine.parts.map((part, idx) => (
                        <motion.div
                          key={`${part.part_no}-${idx}`}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: idx * 0.05 }}
                          className="bg-[var(--wj-surface-solid)] p-6 rounded-[28px] border border-[var(--wj-border)] flex flex-col md:flex-row items-center gap-8 shadow-sm hover:shadow-xl transition-shadow"
                        >
                          <div className="shrink-0 scale-125 md:scale-100">
                            <DonutChart
                              progress={part.progress}
                              actual={roundQty(part.actual_quantity)}
                              planned={roundQty(part.planned_quantity)}
                              size={100}
                              strokeWidth={10}
                            />
                          </div>
                          <div className="flex-1 w-full flex flex-col min-w-0">
                            <div className="flex items-start justify-between mb-4">
                              <div className="min-w-0">
                                <h4 className="font-black text-[var(--wj-text)] text-xl tracking-tight truncate group">
                                  <span className="bg-[var(--wj-bg-strong)] text-[var(--wj-accent-strong)] px-2 py-0.5 rounded-lg text-xs mr-2 border border-[var(--wj-border)] align-middle">PN</span>
                                  {part.part_no}
                                </h4>
                                <p className="text-sm font-bold text-[var(--wj-muted)] truncate mt-1">{part.model_name || t('plan_unknown_machine')}</p>
                              </div>
                              <div className="hidden sm:block text-right">
                                <span className={`text-2xl font-black ${part.progress >= 100 ? 'text-[var(--wj-success)]' : 'text-[var(--wj-accent-strong)]'} tracking-tighter`}>
                                  {part.progress}%
                                </span>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                              <div className="flex items-center gap-4 bg-[var(--wj-surface-solid)] p-3 rounded-2xl border border-[var(--wj-border)]">
                                <div className="p-2 bg-[var(--wj-surface-solid)] rounded-xl shadow-sm">
                                  <Package className="w-4 h-4 text-[var(--wj-accent-strong)]" />
                                </div>
                                <div>
                                  <p className="text-[10px] font-black text-[var(--wj-muted)] uppercase tracking-widest leading-none mb-1">ACTUAL</p>
                                  <p className="text-lg font-black text-[var(--wj-text)] leading-none">{roundQty(part.actual_quantity).toLocaleString()}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-4 bg-[var(--wj-surface-solid)] p-3 rounded-2xl border border-[var(--wj-border)]">
                                <div className="p-2 bg-[var(--wj-surface-solid)] rounded-xl shadow-sm">
                                  <Target className="w-4 h-4 text-[var(--wj-muted)]" />
                                </div>
                                <div>
                                  <p className="text-[10px] font-black text-[var(--wj-muted)] uppercase tracking-widest leading-none mb-1">PLAN</p>
                                  <p className="text-lg font-black text-[var(--wj-muted)] leading-none">{roundQty(part.planned_quantity).toLocaleString()}</p>
                                </div>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  </div>

                  <div className="border-t border-[var(--wj-border)] bg-[var(--wj-surface-solid)] p-6 sm:px-8">
                    <button
                      type="button"
                      className="w-full rounded-[20px] bg-[var(--wj-contrast-surface)] py-4 text-sm font-black text-[var(--wj-on-contrast)] shadow-xl hover:bg-[var(--wj-contrast-surface)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 transition-all uppercase tracking-widest"
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
    className="bg-[var(--wj-surface-solid)] rounded-3xl p-6 shadow-sm border border-[var(--wj-border)] flex items-center gap-6"
  >
    <div className={`p-4 rounded-2xl ${colorClass}`}>
      {icon}
    </div>
    <div>
      <p className="text-[10px] font-black text-[var(--wj-muted)] uppercase tracking-widest mb-1">{title}</p>
      <div className="flex items-baseline gap-2">
        <h4 className="text-3xl font-black text-[var(--wj-text)] tracking-tighter">{value}</h4>
        {label && <span className="text-xs font-bold text-[var(--wj-muted)]">{label}</span>}
      </div>
    </div>
  </motion.div>
);

const ProductionDashboardPage: FC = () => {
  const { t } = useLang();
  const [targetDate, setTargetDate] = useState(() => dayjs().format('YYYY-MM-DD'));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardData | null>(null);
  const [startAnimation, setStartAnimation] = useState(false);
  const [selectedMachine, setSelectedMachine] = useState<{ machine: MachineStatus, type: 'injection' | 'machining' } | null>(null);
  const initialLoadRef = useRef(true);

  useEffect(() => {
    let active = true;

    const fetchData = async () => {
      if (!active) return;
      const showLoader = initialLoadRef.current;
      if (showLoader) {
        setIsLoading(true);
        setData(null);
      }
      setStartAnimation(false);
      setError(null);

      try {
        const response = await getProductionStatusData(targetDate);
        if (!active) return;
        setData(response);
        if (response.injection.length === 0 && response.machining.length === 0) {
          toast.info(t('dashboard_no_data_found'));
        }
      } catch (err) {
        if (!active) return;
        const axiosError = err as AxiosError<{ error?: string }>;
        const errorMessage = axiosError.response?.data?.error || 'An unexpected error occurred';
        setError(errorMessage);
        toast.error(errorMessage);
      } finally {
        if (active) {
          if (showLoader) {
            setIsLoading(false);
          }
          initialLoadRef.current = false;
          setTimeout(() => setStartAnimation(true), 200);
        }
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchData();
      }
    };

    fetchData();
    const intervalId = window.setInterval(fetchData, 60 * 1000);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [targetDate, t]);

  // Aggregate statistics
  const stats = useMemo(() => {
    if (!data) return null;
    const all = [...data.injection, ...data.machining];
    const totalPlanned = all.reduce((sum, item) => sum + item.total_planned, 0);
    const totalActual = all.reduce((sum, item) => sum + item.total_actual, 0);
    const avgProgress = totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0;
    const activeCount = all.filter(item => item.total_actual > 0).length;

    let trendLabel = t('dashboard_trend_no_data');
    if (totalPlanned > 0) {
      if (avgProgress >= 100) {
        trendLabel = t('dashboard_trend_over');
      } else if (avgProgress >= 70) {
        trendLabel = t('dashboard_trend_steady');
      } else {
        trendLabel = t('dashboard_trend_alert');
      }
    }

    return {
      avgProgress: Math.round(avgProgress),
      activeCount,
      totalActual,
      totalPlanned,
      trendLabel,
    };
  }, [data]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] pb-20">
      <div className="container mx-auto p-4 md:p-8 space-y-10 max-w-[1600px]">
        {/* Header Section */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-[var(--wj-surface-solid)] rounded-2xl shadow-sm border border-[var(--wj-border)] flex items-center justify-center">
              <BarChart3 className="w-8 h-8 text-[var(--wj-accent-strong)]" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-4">
                <h1 className="text-3xl font-black text-[var(--wj-text)] tracking-tighter">
                  {t('nav_production_dashboard')}
                </h1>

                {/* Integrated Date Picker */}
                <div className="relative group flex items-center bg-[var(--wj-surface-solid)] border border-[var(--wj-border)] rounded-xl px-3 py-1.5 shadow-sm hover:border-[var(--wj-accent)] hover:ring-4 hover:ring-[var(--wj-border)] transition-all cursor-pointer">
                  <CalendarDays className="w-4 h-4 text-[var(--wj-accent-strong)] mr-2" />
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
                    className="custom-date-input bg-transparent border-none p-0 text-sm font-black text-[var(--wj-text)] focus:ring-0 outline-none w-32"
                    value={targetDate}
                    onChange={(event) => setTargetDate(event.target.value)}
                  />
                </div>
              </div>
              <p className="text-[var(--wj-muted)] font-bold flex items-center gap-2 text-xs mt-1">
                <Info className="w-3 h-3 text-[var(--wj-accent-strong)]" />
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
              icon={<TrendingUp className="w-6 h-6 text-[var(--wj-accent-strong)]" />}
              colorClass="bg-[var(--wj-info-bg)]"
              delay={0.1}
            />
            <StatCard
              title={t('dashboard_summary_active_machines')}
              value={stats.activeCount}
              label={t('unit.records')}
              icon={<Activity className="w-6 h-6 text-[var(--wj-success)]" />}
              colorClass="bg-[var(--wj-success-bg)]"
              delay={0.2}
            />
            <StatCard
              title={t('dashboard_summary_planned_vs_actual')}
              value={roundQty(stats.totalActual).toLocaleString()}
              label={`/ ${roundQty(stats.totalPlanned).toLocaleString()}`}
              icon={<Package className="w-6 h-6 text-[var(--wj-warning)]" />}
              colorClass="bg-[var(--wj-warning-bg)]"
              delay={0.3}
            />
            <StatCard
              title={t('dashboard_summary_trend')}
              value="+"
              label={stats.trendLabel}
              icon={<BarChart3 className="w-6 h-6 text-[var(--wj-accent-strong)]" />}
              colorClass="bg-[var(--wj-accent-soft)]"
              delay={0.4}
            />
          </div>
        )}

        {/* Content Section */}
        <main>
          {isLoading && (
            <div className="flex flex-col justify-center items-center py-32 gap-6">
              <div className="relative">
                <Loader2 className="h-20 w-20 text-[var(--wj-accent-strong)] animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Activity className="w-8 h-8 text-[var(--wj-accent-strong)]" />
                </div>
              </div>
              <p className="text-[var(--wj-muted)] font-black animate-pulse text-lg uppercase tracking-widest">{t('dashboard_loading')}</p>
            </div>
          )}

          {error && !isLoading && (
            <div className="bg-[var(--wj-danger-bg)] border border-[var(--wj-danger-border)] text-[var(--wj-danger)] rounded-[40px] p-16 text-center max-w-2xl mx-auto shadow-sm">
              <ServerCrash className="h-24 w-24 mx-auto mb-8 text-[var(--wj-danger)]" />
              <h3 className="text-3xl font-black mb-3 tracking-tighter">{t('dashboard_error_title')}</h3>
              <p className="text-[var(--wj-danger)] font-bold text-lg">{error}</p>
            </div>
          )}

          {data && !isLoading && !error && (
            <div className="space-y-16">
              {/* Injection Section */}
              {data.injection.length > 0 && (
                <section className="space-y-8">
                  <div className="flex items-center justify-between border-b border-[var(--wj-border)] pb-6 ml-2">
                    <div className="flex items-center gap-6">
                      <div className="h-10 w-2.5 bg-[var(--wj-accent-strong)] rounded-full shadow-[0_0_15px_rgba(59,130,246,0.6)]" />
                      <h2 className="text-3xl font-black text-[var(--wj-text)] tracking-tighter flex items-center gap-4">
                        {t('plan_toggle_injection')}
                        <span className="px-5 py-2 bg-[var(--wj-bg-strong)] text-[var(--wj-accent-strong)] text-sm font-black rounded-2xl tracking-tight border border-[var(--wj-border)] shadow-sm">
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
                  <div className="flex items-center justify-between border-b border-[var(--wj-border)] pb-6 ml-2">
                    <div className="flex items-center gap-6">
                      <div className="h-10 w-2.5 bg-[var(--wj-success)] rounded-full shadow-[0_0_15px_rgba(34,197,94,0.6)]" />
                      <h2 className="text-3xl font-black text-[var(--wj-text)] tracking-tighter flex items-center gap-4">
                        {t('plan_toggle_machining')}
                        <span className="px-5 py-2 bg-[var(--wj-success-bg)] text-[var(--wj-success)] text-sm font-black rounded-2xl tracking-tight border border-[var(--wj-success-border)] shadow-sm">
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
                <div className="py-40 text-center bg-[var(--wj-surface-solid)] rounded-[40px] border-2 border-dashed border-[var(--wj-border)]">
                  <Package className="w-24 h-24 text-[var(--wj-muted)] mx-auto mb-8" />
                  <p className="text-[var(--wj-muted)] font-bold text-2xl tracking-tighter underline underline-offset-8 decoration-gray-100">
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
