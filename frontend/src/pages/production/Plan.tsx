import React, { useState, useEffect, useMemo } from 'react';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { TooltipProps } from 'recharts';
import { FileSpreadsheet, AlertTriangle, Layers } from 'lucide-react';
import { useLang } from '../../i18n';
import { getProductionPlanDates, getProductionPlanSummary } from '../../lib/api';
import PlanCalendar from '../../components/production/PlanCalendar';
import UploadCard from '../../components/production/UploadCard';
import { Skeleton } from '../../components/ui/skeleton';
import { formatInjectionMachineLabel, getInjectionMachineOrder, getMachiningLineOrder, sortMachineSummary } from '../../lib/productionUtils';

// Re-defining interfaces needed for the summary view
interface MachineSummaryRow {
    machine_name: string | null;
    plan_date: string;
    plan_qty: number;
}

interface ModelSummaryRow {
    model_name: string | null;
    plan_date: string;
    plan_qty: number;
}

interface DailyTotalRow {
    date: string;
    plan_qty: number;
}

interface PlanSummary {
    records: any[];
    machine_summary: MachineSummaryRow[];
    model_summary: ModelSummaryRow[];
    daily_totals: DailyTotalRow[];
}

interface MachinePlanDetail {
    id: string;
    partLabel: string;
    partNo?: string | null;
    modelName?: string | null;
    machineLabel?: string;
    qty: number;
    order: number;
}

interface MachineChartRow extends MachineSummaryRow {
    machineKey: string;
    displayLabel: string;
    partPlans: MachinePlanDetail[];
    segmentOrder?: Record<string, number>;
    segmentCount?: number;
    baseColor?: string;
    [key: string]: any;
}


const numberFormatter = new Intl.NumberFormat('ko-KR');

const formatNumber = (value?: number | null) => {
    if (value === null || value === undefined) return '0';
    return numberFormatter.format(value);
};
const normalizeQty = (value?: number | null) => Math.round(Number(value) || 0);
const COLOR_PALETTE = ['#2563eb', '#22c55e', '#a855f7', '#f97316', '#14b8a6', '#ef4444', '#0ea5e9'];
const BAR_SIZE = 24;
const BAR_GAP = 20;
const ROW_HEIGHT = BAR_SIZE + BAR_GAP;
const MIN_CHART_HEIGHT = 240;
const GRAPH_BOTTOM_PADDING = 60;
const DETAIL_CARD_MULTIPLIER = 1.05;
const LIST_CARD_MULTIPLIER = 2;
const Y_AXIS_LABEL_WIDTH = 180;
const CHART_LEFT_SHIFT = 80;

const estimateChartHeight = (summary?: PlanSummary, planType?: 'injection' | 'machining') => {
    if (!summary || !planType) return undefined;
    const count = summary.machine_summary?.length ?? 0;
    if (count === 0) return MIN_CHART_HEIGHT;
    const base = Math.max(MIN_CHART_HEIGHT, count * ROW_HEIGHT);
    return planType === 'machining' ? base * 0.7 : base;
};

const estimateColumnHeight = (summary?: PlanSummary, planType?: 'injection' | 'machining') => {
    const chartHeight = estimateChartHeight(summary, planType);
    if (typeof chartHeight !== 'number') return undefined;
    return chartHeight + GRAPH_BOTTOM_PADDING;
};

const estimateDetailHeight = (summary?: PlanSummary, planType?: 'injection' | 'machining') => {
    const columnHeight = estimateColumnHeight(summary, planType);
    if (typeof columnHeight !== 'number') return undefined;
    return columnHeight * DETAIL_CARD_MULTIPLIER;
};

const estimateListHeight = (summary?: PlanSummary, planType?: 'injection' | 'machining') => {
    const columnHeight = estimateColumnHeight(summary, planType);
    if (typeof columnHeight !== 'number') return undefined;
    return columnHeight * LIST_CARD_MULTIPLIER;
};

const parseLotOrder = (value: any, fallback: number) => {
    if (value === null || value === undefined) return fallback;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const hexToRgb = (hex: string) => {
    const sanitized = hex.replace('#', '');
    if (sanitized.length !== 6) return null;
    const bigint = parseInt(sanitized, 16);
    return {
        r: (bigint >> 16) & 255,
        g: (bigint >> 8) & 255,
        b: bigint & 255,
    };
};

const rgbComponentToHex = (c: number) => {
    const clamped = Math.max(0, Math.min(255, Math.round(c)));
    const hex = clamped.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
};

const lightenColor = (hex: string, amount: number) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const factor = Math.max(0, Math.min(1, amount));
    const r = rgb.r + (255 - rgb.r) * factor;
    const g = rgb.g + (255 - rgb.g) * factor;
    const b = rgb.b + (255 - rgb.b) * factor;
    return `#${rgbComponentToHex(r)}${rgbComponentToHex(g)}${rgbComponentToHex(b)}`;
};


const SquareBar: React.FC<any> = ({ x = 0, y = 0, width = 0, height = 0, fill }) => (
    <rect x={x} y={y} width={width} height={height} fill={fill} rx={0} ry={0} />
);

// Summary Component
interface SummaryDisplayProps {
    summary: PlanSummary;
    planType: 'injection' | 'machining';
    chartHeightOverride?: number;
    columnHeightOverride?: number;
    detailHeightOverride?: number;
    listHeightOverride?: number;
}

const SummaryDisplay: React.FC<SummaryDisplayProps> = ({
    summary,
    planType,
    chartHeightOverride,
    columnHeightOverride,
    detailHeightOverride,
    listHeightOverride,
}) => {
    const { t } = useLang();
    const title = planType === 'injection' ? t('plan_toggle_injection') : t('plan_toggle_machining');
    const [selectedMachine, setSelectedMachine] = useState<string | null>(null);
    const [hoveredMachine, setHoveredMachine] = useState<string | null>(null);

    useEffect(() => {
        setSelectedMachine(null);
        setHoveredMachine(null);
    }, [summary, planType]);

    const {
        machineData,
        partKeys,
        machineColorMap,
        modelColorMap,
        machineDetailsMap,
        machineLabelMap,
        globalPlans,
    } = useMemo(() => {
        type MachineMapEntry = {
            machineKey: string;
            machine_name: string | null;
            displayLabel: string;
            chartValues: Record<string, number>;
            partPlans: MachinePlanDetail[];
            plan_qty: number;
        };

        const records = summary.records || [];
        const machineMap = new Map<string, MachineMapEntry>();
        const partOrder: string[] = [];

        records.forEach((record: any, index: number) => {
            const rawMachineName = typeof record.machine_name === 'string' ? record.machine_name.trim() : '';
            const machineKey = rawMachineName || `machine-${index}`;
            const displayLabel = planType === 'injection'
                ? formatInjectionMachineLabel(rawMachineName, t)
                : (rawMachineName || t('plan_unknown_machine'));
            const qty = normalizeQty(record.planned_quantity);
            const partLabelCandidate =
                (typeof record.part_no === 'string' && record.part_no.trim()) ||
                (typeof record.model_name === 'string' && record.model_name.trim()) ||
                (typeof record.part_spec === 'string' && record.part_spec.trim()) ||
                `${t('plan_model_label')} #${index + 1}`;
            const partKey = partLabelCandidate;

            if (!partOrder.includes(partKey)) {
                partOrder.push(partKey);
            }

            if (!machineMap.has(machineKey)) {
                machineMap.set(machineKey, {
                    machineKey,
                    machine_name: rawMachineName || null,
                    displayLabel,
                    chartValues: {},
                    partPlans: [],
                    plan_qty: 0,
                });
            }

            const entry = machineMap.get(machineKey)!;
            entry.chartValues[partKey] = (entry.chartValues[partKey] || 0) + qty;
            entry.plan_qty += qty;
            entry.partPlans.push({
                id: `${machineKey}-${partKey}-${index}`,
                partLabel: partLabelCandidate,
                partNo: record.part_no,
                modelName: record.model_name,
                machineLabel: displayLabel,
                qty,
                order: parseLotOrder(record.lot_no, index),
            });
        });

        if (machineMap.size === 0) {
            const fallbackKey = 'total';
            const fallbackData: MachineChartRow[] = sortMachineSummary(summary.machine_summary || [], planType).map((row, index) => ({
                machineKey: row.machine_name || `machine-${index}`,
                machine_name: row.machine_name,
                plan_qty: normalizeQty(row.plan_qty),
                plan_date: row.plan_date,
                displayLabel: planType === 'injection'
                    ? formatInjectionMachineLabel(row.machine_name, t)
                    : (row.machine_name || t('plan_unknown_machine')),
                partPlans: [],
                segmentOrder: { [fallbackKey]: 0 },
                segmentCount: 1,
                [fallbackKey]: normalizeQty(row.plan_qty),
                baseColor: undefined,
            }));

            const labels = fallbackData.reduce<Record<string, string>>((acc, entry) => {
                acc[entry.machineKey] = entry.displayLabel;
                return acc;
            }, {});

            const colorMap = fallbackData.reduce<Record<string, string>>((acc, entry, idx) => {
                const color = COLOR_PALETTE[idx % COLOR_PALETTE.length];
                acc[entry.machineKey] = color;
                entry.baseColor = color;
                return acc;
            }, {});

            if (planType === 'machining') {
                const defaultLines = ['A LINE', 'B LINE', 'C LINE', 'D LINE'];
                defaultLines.forEach((line) => {
                    const machineKey = `line-${line.replace(/\s+/g, '-').toLowerCase()}`;
                    const newEntry: MachineChartRow = {
                        machineKey,
                        machine_name: line,
                        plan_qty: 0,
                        plan_date: '',
                        displayLabel: line,
                        partPlans: [],
                        segmentOrder: {},
                        segmentCount: 0,
                    };
                    newEntry[fallbackKey] = 0;
                    (fallbackData as MachineChartRow[]).push(newEntry);
                });
            }
            const fallbackSortFn = planType === 'injection' ? getInjectionMachineOrder : getMachiningLineOrder;
            (fallbackData as MachineChartRow[]).sort((a, b) => {
                const diff = fallbackSortFn(a.machine_name) - fallbackSortFn(b.machine_name);
                if (diff !== 0) return diff;
                return (a.displayLabel || '').localeCompare(b.displayLabel || '');
            });
            return {
                machineData: fallbackData as MachineChartRow[],
                partKeys: [fallbackKey],
                machineColorMap: colorMap,
                modelColorMap: { [fallbackKey]: COLOR_PALETTE[0] },
                machineDetailsMap: {} as Record<string, MachinePlanDetail[]>,
                machineLabelMap: labels,
                globalPlans: [],
            };
        }

        const sortFn = planType === 'injection' ? getInjectionMachineOrder : getMachiningLineOrder;

        let machineData = Array.from(machineMap.values())
            .map((entry) => {
                entry.partPlans.sort((a, b) => a.order - b.order);
                const segmentOrder: Record<string, number> = {};
                entry.partPlans.forEach((plan, idx) => {
                    if (segmentOrder[plan.partLabel] === undefined) {
                        segmentOrder[plan.partLabel] = idx;
                    }
                });
                const segmentCount = Object.keys(segmentOrder).length || 1;
                const chartRow: MachineChartRow = {
                    machineKey: entry.machineKey,
                    machine_name: entry.machine_name,
                    plan_qty: entry.plan_qty,
                    plan_date: '',
                    displayLabel: entry.displayLabel,
                    partPlans: entry.partPlans,
                    segmentOrder,
                    segmentCount,
                };
                partOrder.forEach((partKey) => {
                    chartRow[partKey] = entry.chartValues[partKey] || 0;
                });
                return chartRow;
            });

        let renderPartOrder = [...partOrder];
        if (renderPartOrder.length === 0) {
            renderPartOrder = ['__placeholder__'];
        }

        const modelColorMap = renderPartOrder.reduce<Record<string, string>>((acc, key, idx) => {
            acc[key] = COLOR_PALETTE[idx % COLOR_PALETTE.length];
            return acc;
        }, {});

        machineData = machineData.map((entry) => {
            renderPartOrder.forEach((partKey) => {
                if (entry[partKey] === undefined) {
                    entry[partKey] = 0;
                }
            });
            return entry;
        });

        machineData = machineData.sort((a, b) => {
            const diff = sortFn(a.machine_name) - sortFn(b.machine_name);
            if (diff !== 0) return diff;
            return (a.displayLabel || '').localeCompare(b.displayLabel || '');
        });

        if (planType === 'machining') {
            const defaultLines = ['A LINE', 'B LINE', 'C LINE', 'D LINE'];
            defaultLines.forEach((line) => {
                const exists = machineData.some(
                    (entry) => (entry.machine_name || entry.displayLabel || '').toUpperCase() === line
                );
                if (!exists) {
                    const machineKey = `line-${line.replace(/\s+/g, '-').toLowerCase()}`;
                    const newEntry: MachineChartRow = {
                        machineKey,
                        machine_name: line,
                        plan_qty: 0,
                        plan_date: '',
                        displayLabel: line,
                        partPlans: [],
                        segmentOrder: {},
                        segmentCount: 0,
                    };
                    renderPartOrder.forEach((partKey) => {
                        newEntry[partKey] = 0;
                    });
                    machineData.push(newEntry);
                }
            });
            machineData = machineData.sort((a, b) => {
                const diff = sortFn(a.machine_name) - sortFn(b.machine_name);
                if (diff !== 0) return diff;
                return (a.displayLabel || '').localeCompare(b.displayLabel || '');
            });
        }

        const machineDetailsMap = machineData.reduce<Record<string, MachinePlanDetail[]>>((acc, entry) => {
            acc[entry.machineKey] = entry.partPlans;
            return acc;
        }, {});

        const machineLabelMap = machineData.reduce<Record<string, string>>((acc, entry) => {
            acc[entry.machineKey] = entry.displayLabel;
            return acc;
        }, {});

        const machineColorMap = machineData.reduce<Record<string, string>>((acc, entry, idx) => {
            const color = COLOR_PALETTE[idx % COLOR_PALETTE.length];
            acc[entry.machineKey] = color;
            entry.baseColor = color;
            return acc;
        }, {});

        const globalPlans = machineData
            .flatMap((entry) =>
                entry.partPlans.map((plan) => ({
                    ...plan,
                    machineLabel: plan.machineLabel || entry.displayLabel,
                    machineKey: entry.machineKey,
                }))
            )
            .sort((a, b) => a.order - b.order);

        return {
            machineData,
            partKeys: renderPartOrder,
            machineColorMap,
            modelColorMap,
            machineDetailsMap,
            machineLabelMap,
            globalPlans,
        };
    }, [summary.records, summary.machine_summary, planType, t]);

    const baseHeight = Math.max(MIN_CHART_HEIGHT, machineData.length * ROW_HEIGHT);
    const computedChartHeight = planType === 'machining' ? baseHeight * 0.7 : baseHeight;
    const chartHeight = chartHeightOverride ?? computedChartHeight;
    const baseColumnHeight = chartHeight + GRAPH_BOTTOM_PADDING;
    const columnHeight = columnHeightOverride ?? baseColumnHeight;
    const baseDetailHeight = columnHeight * DETAIL_CARD_MULTIPLIER;
    const detailCardHeight = detailHeightOverride ?? baseDetailHeight;
    const baseListHeight = columnHeight * LIST_CARD_MULTIPLIER;
    const listCardHeight = listHeightOverride ?? baseListHeight;
    const activeMachineKey = hoveredMachine ?? selectedMachine;
    const selectedPlans = activeMachineKey ? machineDetailsMap[activeMachineKey] : null;
    const selectedMachineLabel = activeMachineKey ? (machineLabelMap[activeMachineKey] || activeMachineKey) : '';
    const handleBarClick = (payload?: any) => {
        if (!payload?.machineKey) return;
        setSelectedMachine(payload.machineKey);
    };

    const MachineTooltipContent = ({ active, payload }: TooltipProps<number, string>) => {
        if (!active || !payload?.length) return null;
        const machineKey = payload[0]?.payload?.machineKey;
        if (!machineKey) return null;
        const plans = machineDetailsMap[machineKey] || [];
        const label = machineLabelMap[machineKey] || payload[0]?.payload?.displayLabel;

        return (
            <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 space-y-2 min-w-[220px]">
                <p className="text-sm font-semibold text-gray-900">{label}</p>
                {plans.length ? (
                    <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                        {plans.map((plan) => (
                            <div key={plan.id} className="flex items-center justify-between gap-3 text-xs text-gray-700">
                                <span className="truncate">{plan.partNo || plan.partLabel}</span>
                                <span className="font-mono">{formatNumber(plan.qty)}</span>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-xs text-gray-500">{t('plan_no_machine_detail')}</p>
                )}
            </div>
        );
    };

    const renderSegmentShape = (partKey: string) => (props: any) => {
        const { payload } = props;
        const machineKey = payload?.machineKey;
        const baseColor = (machineKey && machineColorMap[machineKey]) || COLOR_PALETTE[0];
        const orderIndex = payload?.segmentOrder?.[partKey] ?? 0;
        const segmentCount = payload?.segmentCount || Object.keys(payload?.segmentOrder || {}).length || 1;
        const divisor = Math.max(segmentCount - 1, 1);
        const shadeAmount = segmentCount > 1 ? Math.min(0.55, (orderIndex / divisor) * 0.55) : 0;
        const fill = (planType === 'machining')
            ? (modelColorMap[partKey] || COLOR_PALETTE[0])
            : lightenColor(baseColor, shadeAmount);

        return <SquareBar {...props} fill={fill} />;
    };

    const labelGap = Y_AXIS_LABEL_WIDTH / 2;
    const chartWrapperStyle: React.CSSProperties = {
        width: `calc(100% + ${CHART_LEFT_SHIFT}px)`,
        marginLeft: `-${CHART_LEFT_SHIFT}px`,
    };

    return (
        <div className="space-y-6">
            <h3 className="text-xl font-bold text-gray-800 border-b pb-2">{title}</h3>
            <div className="space-y-6">
                <div
                    className="bg-white rounded-xl shadow p-5 flex flex-col"
                    style={{ minHeight: detailCardHeight, maxHeight: detailCardHeight }}
                >
                    <h4 className="text-base font-semibold text-gray-900 mb-4">{t('plan_summary_machine')}</h4>
                    <div className="flex-1 min-h-0 overflow-visible">
                        <div style={chartWrapperStyle}>
                            <ResponsiveContainer width="100%" height={chartHeight}>
                                <BarChart
                                    layout="vertical"
                                    data={machineData}
                                    margin={{ left: 16, right: 16, bottom: 8 }}
                                    barCategoryGap={BAR_GAP}
                                    barGap={0}
                                    onMouseMove={(state) => {
                                        const machineKey = state?.activePayload?.[0]?.payload?.machineKey;
                                        setHoveredMachine(machineKey || null);
                                    }}
                                    onMouseLeave={() => setHoveredMachine(null)}
                                >
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                                    <XAxis type="number" tickFormatter={(value) => formatNumber(value as number)} />
                                    <YAxis
                                        type="category"
                                        dataKey="displayLabel"
                                        width={Y_AXIS_LABEL_WIDTH}
                                        tickLine={false}
                                        axisLine={false}
                                        tick={({ x = 0, y = 0, payload }) => (
                                            <text
                                                x={x - labelGap}
                                                y={y}
                                                dy={4}
                                                textAnchor="start"
                                                fill="#111827"
                                                fontSize={12}
                                                fontWeight={500}
                                            >
                                                {payload.value}
                                            </text>
                                        )}
                                    />
                                    <Tooltip content={<MachineTooltipContent />} />
                                    {partKeys.map((partKey) => (
                                        <Bar
                                            key={`${planType}-${partKey}`}
                                            dataKey={partKey}
                                            stackId={`${planType}-stack`}
                                            name={partKey}
                                            barSize={BAR_SIZE}
                                            shape={renderSegmentShape(partKey)}
                                            cursor="pointer"
                                            onClick={(data) => handleBarClick(data?.payload)}
                                        />
                                    ))}
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>
                <div
                    className="bg-white rounded-xl shadow p-5 flex flex-col"
                    style={{ minHeight: listCardHeight, maxHeight: listCardHeight }}
                >
                    <div className="flex items-center justify-between gap-2 mb-4">
                        <div className="flex items-center gap-2">
                            <Layers className="w-5 h-5 text-purple-500" />
                            <h4 className="text-base font-semibold text-gray-900">
                                {activeMachineKey
                                    ? t('plan_machine_schedule_for', { machine: selectedMachineLabel })
                                    : t('plan_models_title')}
                            </h4>
                        </div>
                        {selectedMachine && (
                            <button
                                type="button"
                                onClick={() => setSelectedMachine(null)}
                                className="text-xs font-medium text-blue-600 hover:text-blue-500"
                            >
                                {t('reset')}
                            </button>
                        )}
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                        {(() => {
                            const plansToShow = activeMachineKey ? selectedPlans : globalPlans;
                            if (!plansToShow || plansToShow.length === 0) {
                                return <p className="text-sm text-gray-500">{t('plan_no_machine_detail')}</p>;
                            }
                            return (
                                <div className="space-y-2">
                                    {plansToShow.map((plan, idx) => (
                                        <div key={plan.id} className="border border-gray-100 rounded-lg p-3 space-y-2">
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
                                                    <p className="text-sm font-semibold text-gray-900">
                                                        {plan.partNo || plan.partLabel}
                                                    </p>
                                                    {plan.modelName && (
                                                        <p className="text-xs text-gray-500">{plan.modelName}</p>
                                                    )}
                                                    {!activeMachineKey && plan.machineLabel && (
                                                        <p className="text-[11px] text-gray-400 font-medium">
                                                            {plan.machineLabel}
                                                        </p>
                                                    )}
                                                </div>
                                                <p className="text-sm font-mono text-gray-900">
                                                    {formatNumber(plan.qty)}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2 text-[11px] text-gray-500">
                                                <span className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                                                    {t('plan_sequence_badge', { order: idx + 1 })}
                                                </span>
                                                <span>{t('plan_qty_summary')}</span>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            );
                        })()}
                    </div>
                </div>
            </div>
        </div>
    )
}


export default function ProductionPlanPage() {
    const { t } = useLang();

    const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());

    // Fetch plan dates for the calendar
    const { data: planDatesData, refetch: refetchPlanDates } = useQuery({
        queryKey: ['planDates'],
        queryFn: getProductionPlanDates,
        initialData: { injection: [], machining: [] },
    });

    const planDates = useMemo(() => ({
        injection: planDatesData.injection.map((d: string) => new Date(d)),
        machining: planDatesData.machining.map((d: string) => new Date(d)),
    }), [planDatesData]);

    // Fetch summary for the selected date
    const { data: summaryData, isLoading: isSummaryLoading, error: summaryError } = useQuery({
        queryKey: ['planSummary', selectedDate ? dayjs(selectedDate).format('YYYY-MM-DD') : null],
        queryFn: () => getProductionPlanSummary(dayjs(selectedDate!).format('YYYY-MM-DD')),
        enabled: !!selectedDate,
    });

    const handleUploadSuccess = () => {
        refetchPlanDates();
    };

    const { uniformChartHeight, uniformColumnHeight, uniformDetailHeight, uniformListHeight } = useMemo(() => {
        if (!summaryData) {
            return {
                uniformChartHeight: undefined,
                uniformColumnHeight: undefined,
                uniformDetailHeight: undefined,
                uniformListHeight: undefined,
            };
        }
        const chartHeights: number[] = [];
        const columnHeights: number[] = [];
        const detailHeights: number[] = [];
        const listHeights: number[] = [];
        if (summaryData.injection) {
            const h = estimateChartHeight(summaryData.injection, 'injection');
            if (typeof h === 'number') chartHeights.push(h);
            const ch = estimateColumnHeight(summaryData.injection, 'injection');
            if (typeof ch === 'number') columnHeights.push(ch);
            const dh = estimateDetailHeight(summaryData.injection, 'injection');
            if (typeof dh === 'number') detailHeights.push(dh);
            const lh = estimateListHeight(summaryData.injection, 'injection');
            if (typeof lh === 'number') listHeights.push(lh);
        }
        if (summaryData.machining) {
            const h = estimateChartHeight(summaryData.machining, 'machining');
            if (typeof h === 'number') chartHeights.push(h);
            const ch = estimateColumnHeight(summaryData.machining, 'machining');
            if (typeof ch === 'number') columnHeights.push(ch);
            const dh = estimateDetailHeight(summaryData.machining, 'machining');
            if (typeof dh === 'number') detailHeights.push(dh);
            const lh = estimateListHeight(summaryData.machining, 'machining');
            if (typeof lh === 'number') listHeights.push(lh);
        }
        return {
            uniformChartHeight: chartHeights.length ? Math.max(...chartHeights) : undefined,
            uniformColumnHeight: columnHeights.length ? Math.max(...columnHeights) : undefined,
            uniformDetailHeight: detailHeights.length ? Math.max(...detailHeights) : undefined,
            uniformListHeight: listHeights.length ? Math.max(...listHeights) : undefined,
        };
    }, [summaryData]);

    return (
        <div className="px-4 py-6 md:px-8 md:py-10">
            <div className="max-w-[1400px] mx-auto space-y-8">
                {/* Page Header */}
                <div className="flex items-center gap-3">
                    <FileSpreadsheet className="w-8 h-8 text-blue-600" />
                    <div>
                        <h1 className="text-2xl font-semibold text-gray-900">{t('plan_page_title')}</h1>
                        <p className="text-sm text-gray-600">{t('plan_page_description')}</p>
                    </div>
                </div>

                {/* Main Grid: Calendar and Upload Cards */}
                <div className="grid grid-cols-1 gap-6 items-start lg:grid-cols-[340px_minmax(0,1fr)_minmax(0,1fr)] max-w-[1350px] mx-auto">
                    <div className="h-full">
                        <PlanCalendar
                            planDates={planDates}
                            selectedDate={selectedDate}
                            onSelectDate={setSelectedDate}
                            className="h-full"
                        />
                    </div>
                    <div className="h-full">
                        <UploadCard planType="injection" onUploadSuccess={handleUploadSuccess} />
                    </div>
                    <div className="h-full">
                        <UploadCard planType="machining" onUploadSuccess={handleUploadSuccess} />
                    </div>
                </div>

                {/* Summary Section */}
                <div className="mt-8 bg-gray-50 rounded-xl p-6 space-y-6">
                    <h2 className="text-xl font-bold text-gray-900">
                        {selectedDate ? t('plan_summary_for_date', { date: dayjs(selectedDate).format('YYYY-MM-DD') }) : t('plan_select_date_hint')}
                    </h2>

                    {isSummaryLoading && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <Skeleton className="h-80 w-full" />
                            <Skeleton className="h-80 w-full" />
                        </div>
                    )}

                    {summaryError && !isSummaryLoading && (
                        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-6 text-center">
                            <AlertTriangle className="h-10 w-10 mx-auto mb-3 text-red-400" />
                            <h3 className="text-lg font-semibold">{t('dashboard_error_title')}</h3>
                            <p className="text-sm">{(summaryError as any).message}</p>
                        </div>
                    )}

                    {!isSummaryLoading && !summaryError && summaryData && (
                        <div className="grid gap-8 lg:grid-cols-2">
                            <div>
                                {summaryData.injection.records.length > 0 ? (
                                    <SummaryDisplay
                                        summary={summaryData.injection}
                                        planType="injection"
                                        chartHeightOverride={uniformChartHeight}
                                        columnHeightOverride={uniformColumnHeight}
                                        detailHeightOverride={uniformDetailHeight}
                                        listHeightOverride={uniformListHeight}
                                    />
                                ) : (
                                    <p className="text-sm text-gray-500">
                                        {t('plan_toggle_injection')}: {t('plan_no_summary')}
                                    </p>
                                )}
                            </div>
                            <div>
                                {summaryData.machining.records.length > 0 ? (
                                    <SummaryDisplay
                                        summary={summaryData.machining}
                                        planType="machining"
                                        chartHeightOverride={uniformChartHeight}
                                        columnHeightOverride={uniformColumnHeight}
                                        detailHeightOverride={uniformDetailHeight}
                                        listHeightOverride={uniformListHeight}
                                    />
                                ) : (
                                    <p className="text-sm text-gray-500">
                                        {t('plan_toggle_machining')}: {t('plan_no_summary')}
                                    </p>
                                )}
                            </div>
                        </div>
                    )}

                    {!isSummaryLoading && !summaryData && !summaryError && (
                        <div className="text-center py-10">
                            <p className="text-gray-500">{t('plan_select_date_hint')}</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
