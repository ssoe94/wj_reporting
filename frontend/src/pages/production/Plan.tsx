import React, { useState, useEffect, useMemo, useRef } from 'react';
import dayjs from 'dayjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { TooltipProps } from 'recharts';
import { FileSpreadsheet, AlertTriangle, Layers, PencilLine, RefreshCcw, X } from 'lucide-react';
import { useLang } from '../../i18n';
import { getProductionPlanDates, getProductionPlanSummary, getProductionPlanItems, updateProductionPartCavity, updateProductionPlanItem, createProductionPlanItem, deleteProductionPlanItem, searchProductionPlanParts } from '../../lib/api';
import PlanCalendar from '../../components/production/PlanCalendar';
import UploadCard from '../../components/production/UploadCard';
import { Skeleton } from '../../components/ui/skeleton';
import { formatInjectionMachineLabel, getInjectionMachineOrder, getMachiningLineOrder, sortMachineSummary } from '../../lib/productionUtils';
import { Button } from '../../components/ui/button';
import { useAuth } from '../../contexts/AuthContext';
import machines from '../../constants/machines';

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
    cavity?: number;
}

interface PlanEditItem {
    id: number;
    plan_date: string;
    plan_type: 'injection' | 'machining';
    machine_name: string;
    part_no: string;
    model_name?: string | null;
    part_spec?: string | null;
    lot_no?: string | null;
    planned_quantity: number;
    sequence?: number | null;
    isNew?: boolean;
}

interface PartSuggestion {
    part_no: string;
    model_code?: string;
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
    return estimateDetailHeight(summary, planType);
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
    canEdit?: boolean;
    onEditClick?: () => void;
}

const SummaryDisplay: React.FC<SummaryDisplayProps> = ({
    summary,
    planType,
    chartHeightOverride,
    columnHeightOverride,
    detailHeightOverride,
    listHeightOverride,
    canEdit,
    onEditClick,
}) => {
    const { t } = useLang();
    const queryClient = useQueryClient();
    const title = planType === 'injection' ? t('plan_toggle_injection') : t('plan_toggle_machining');
    const [selectedMachine, setSelectedMachine] = useState<string | null>(null);
    const [hoveredMachine, setHoveredMachine] = useState<string | null>(null);
    const [cavityOverrides, setCavityOverrides] = useState<Record<string, number>>({});
    const [savingCavity, setSavingCavity] = useState<Record<string, boolean>>({});

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
                cavity: normalizeQty(record.cavity ?? 1),
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
    const listCardHeight = listHeightOverride ?? detailCardHeight;
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

    const handleCavitySave = async (partNo?: string | null) => {
        if (!partNo) return;
        const key = partNo.toUpperCase();
        const value = cavityOverrides[key] ?? 1;
        setSavingCavity((prev) => ({ ...prev, [key]: true }));
        try {
            await updateProductionPartCavity(key, value);
            await queryClient.invalidateQueries({ queryKey: ['planSummary'] });
        } finally {
            setSavingCavity((prev) => ({ ...prev, [key]: false }));
        }
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
            <div className="flex items-center justify-between gap-3 border-b pb-2">
                <h3 className="text-xl font-bold text-gray-800">{title}</h3>
                {canEdit && onEditClick && (
                    <button
                        type="button"
                        onClick={onEditClick}
                        className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-100"
                    >
                        <PencilLine className="h-3.5 w-3.5" />
                        {t('plan_edit_button')}
                    </button>
                )}
            </div>
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
                    <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                        {(() => {
                            const plansToShow = activeMachineKey ? selectedPlans : globalPlans;
                            if (!plansToShow || plansToShow.length === 0) {
                                return <p className="text-sm text-gray-500">{t('plan_no_machine_detail')}</p>;
                            }
                            return (
                                <div className="space-y-2">
                                    {plansToShow.map((plan, idx) => {
                                        const partKey = plan.partNo?.toUpperCase();
                                        const cavityValue = partKey ? (cavityOverrides[partKey] ?? plan.cavity ?? 1) : 1;
                                        return (
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
                                                <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                                                    <span className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                                                        {t('plan_sequence_badge', { order: idx + 1 })}
                                                    </span>
                                                    <span>{t('plan_qty_summary')}</span>
                                                    {partKey && (
                                                        <label className="ml-auto flex items-center gap-1 text-[11px] text-gray-500">
                                                            <span>{t('cavity')}</span>
                                                            <input
                                                                type="number"
                                                                min={1}
                                                                className="w-16 rounded-md border border-gray-200 px-2 py-0.5 text-right text-[11px] font-semibold text-gray-700 focus:border-blue-400 focus:outline-none"
                                                                value={cavityValue}
                                                                onChange={(e) => {
                                                                    const next = Math.max(1, Number(e.target.value || 1));
                                                                    setCavityOverrides((prev) => ({ ...prev, [partKey]: next }));
                                                                }}
                                                                onBlur={() => handleCavitySave(partKey)}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter') {
                                                                        e.currentTarget.blur();
                                                                    }
                                                                }}
                                                            />
                                                            {savingCavity[partKey] && (
                                                                <span className="text-[10px] text-gray-400">...</span>
                                                            )}
                                                        </label>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
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
    const { user, hasPermission } = useAuth();
    const queryClient = useQueryClient();

    const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
    const [editPlanType, setEditPlanType] = useState<'injection' | 'machining' | null>(null);
    const [editItems, setEditItems] = useState<PlanEditItem[]>([]);
    const [originalEditItems, setOriginalEditItems] = useState<Record<number, PlanEditItem>>({});
    const [editError, setEditError] = useState<string | null>(null);
    const [isSavingAll, setIsSavingAll] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [partSearchTerm, setPartSearchTerm] = useState('');
    const [partSuggestions, setPartSuggestions] = useState<PartSuggestion[]>([]);
    const tableContainerRef = useRef<HTMLDivElement | null>(null);
    const partSearchCacheRef = useRef<Map<string, PartSuggestion[]>>(new Map());
    const machineOptions = useMemo(() => {
        if (editPlanType === 'injection') {
            const baseOptions = machines
                .slice()
                .sort((a, b) => a.id - b.id)
                .map((machine) => {
                    const label = `${machine.ton}T-${machine.id}`;
                    return { value: label, label };
                });
            const existingNames = new Set(
                editItems
                    .map((item) => item.machine_name)
                    .filter((name): name is string => Boolean(name && name.trim()))
            );
            const merged = [...baseOptions];
            existingNames.forEach((name) => {
                if (!merged.find((option) => option.value === name)) {
                    merged.push({ value: name, label: name });
                }
            });
            return merged.sort((a, b) => getInjectionMachineOrder(a.value) - getInjectionMachineOrder(b.value));
        }
        const names = new Set(
            editItems
                .map((item) => item.machine_name)
                .filter((name): name is string => Boolean(name && name.trim()))
        );
        return Array.from(names)
            .sort((a, b) => {
                const orderA = getMachiningLineOrder(a);
                const orderB = getMachiningLineOrder(b);
                if (orderA !== orderB) return orderA - orderB;
                return a.localeCompare(b);
            })
            .map((name) => ({ value: name, label: name }));
    }, [editItems, editPlanType]);
    const partSuggestionMap = useMemo(() => {
        const map = new Map<string, PartSuggestion>();
        partSuggestions.forEach((suggestion) => {
            if (suggestion.part_no && !map.has(suggestion.part_no)) {
                map.set(suggestion.part_no, suggestion);
            }
        });
        return map;
    }, [partSuggestions]);
    const modelOptions = useMemo(() => {
        const set = new Set(
            partSuggestions
                .map((suggestion) => suggestion.model_code)
                .filter((value): value is string => Boolean(value && value.trim()))
        );
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [partSuggestions]);
    const dirtyItems = useMemo(() => {
        return editItems.filter((item) => {
            const original = originalEditItems[item.id];
            if (!original) return true;
            if (item.isNew) return true;
            const machineChanged = (original.machine_name || '') !== (item.machine_name || '');
            const partChanged = (original.part_no || '') !== (item.part_no || '');
            const modelChanged = (original.model_name || '') !== (item.model_name || '');
            const lotChanged = (original.lot_no || '') !== (item.lot_no || '');
            const qtyChanged = Number(original.planned_quantity ?? 0) !== Number(item.planned_quantity ?? 0);
            return machineChanged || partChanged || modelChanged || lotChanged || qtyChanged;
        });
    }, [editItems, originalEditItems]);

    useEffect(() => {
        if (!partSearchTerm || partSearchTerm.trim().length < 2) {
            setPartSuggestions([]);
            return;
        }
        const normalizedTerm = partSearchTerm.trim().toUpperCase();
        const cached = partSearchCacheRef.current.get(normalizedTerm);
        if (cached) {
            setPartSuggestions(cached);
            return;
        }
        const handle = window.setTimeout(async () => {
            try {
                const response = await searchProductionPlanParts(normalizedTerm, editPlanType || undefined);
                const raw = Array.isArray(response)
                    ? response
                    : Array.isArray(response?.results)
                        ? response.results
                        : [];
                const map = new Map<string, PartSuggestion>();
                raw.forEach((item: any) => {
                    const partNo = (item?.part_no || '').toString().trim().toUpperCase();
                    if (!partNo) return;
                    if (!map.has(partNo)) {
                        map.set(partNo, {
                            part_no: partNo,
                            model_code: (item?.model_name || item?.model_code || item?.model || '').toString().trim(),
                        });
                    }
                });
                const suggestions = Array.from(map.values());
                partSearchCacheRef.current.set(normalizedTerm, suggestions);
                setPartSuggestions(suggestions);
            } catch {
                setPartSuggestions([]);
            }
        }, 250);
        return () => window.clearTimeout(handle);
    }, [partSearchTerm]);
    const canEditInjection = Boolean(user?.is_staff || user?.permissions?.is_admin || hasPermission('can_edit_injection'));
    const canEditMachining = Boolean(user?.is_staff || user?.permissions?.is_admin || hasPermission('can_edit_assembly'));
    const editPlanLabel = editPlanType
        ? (editPlanType === 'injection' ? t('plan_toggle_injection') : t('plan_toggle_machining'))
        : '';

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

    const editDateStr = selectedDate ? dayjs(selectedDate).format('YYYY-MM-DD') : null;
    const {
        data: planItemsData,
        isLoading: isPlanItemsLoading,
        refetch: refetchPlanItems,
        error: planItemsError,
    } = useQuery({
        queryKey: ['planItems', editDateStr, editPlanType],
        queryFn: () => getProductionPlanItems(editDateStr!, editPlanType!),
        enabled: !!editPlanType && !!editDateStr,
    });

    useEffect(() => {
        if (!planItemsData) {
        setEditItems([]);
        setOriginalEditItems({});
        setSelectedIds(new Set());
        return;
    }
        const items = Array.isArray(planItemsData)
            ? planItemsData
            : Array.isArray((planItemsData as any)?.results)
                ? (planItemsData as any).results
                : [];
        setEditItems(items);
        setOriginalEditItems(items.reduce<Record<number, PlanEditItem>>((acc, item) => {
            acc[item.id] = item;
            return acc;
        }, {}));
        setSelectedIds(new Set());
    }, [planItemsData, editPlanType]);

    useEffect(() => {
        if (!planItemsError) return;
        const message =
            (planItemsError as any)?.response?.data?.detail ||
            (planItemsError as any)?.response?.data?.error ||
            (planItemsError as any)?.message ||
            t('plan_upload_error');
        setEditError(message);
        setEditItems([]);
    }, [planItemsError, t]);

    const handleUploadSuccess = () => {
        refetchPlanDates();
    };

    const openEditModal = (type: 'injection' | 'machining') => {
        setEditPlanType(type);
        setEditItems([]);
        setEditError(null);
    };

    const closeEditModal = () => {
        setEditPlanType(null);
        setEditItems([]);
        setOriginalEditItems({});
        setSelectedIds(new Set());
        setEditError(null);
    };

    const updateEditItem = (id: number, field: keyof PlanEditItem, value: any) => {
        setEditItems((prev) =>
            prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
        );
    };

    const handleSaveAll = async () => {
        if (dirtyItems.length === 0 || isSavingAll) return;
        setIsSavingAll(true);
        setEditError(null);
        try {
            const newItems = dirtyItems.filter((item) => item.isNew);
            const existingItems = dirtyItems.filter((item) => !item.isNew);
            await Promise.all(
                newItems.map((item) =>
                    createProductionPlanItem({
                        plan_date: item.plan_date,
                        plan_type: item.plan_type,
                        machine_name: item.machine_name,
                        part_no: item.part_no || null,
                        model_name: item.model_name ?? null,
                        part_spec: item.part_spec ?? null,
                        lot_no: item.lot_no ?? null,
                        planned_quantity: item.planned_quantity,
                    })
                )
            );
            await Promise.all(
                existingItems.map((item) =>
                    updateProductionPlanItem(item.id, {
                        machine_name: item.machine_name,
                        part_no: item.part_no || null,
                        model_name: item.model_name ?? null,
                        lot_no: item.lot_no ?? null,
                        planned_quantity: item.planned_quantity,
                    })
                )
            );
            await queryClient.invalidateQueries({ queryKey: ['planSummary'] });
            await refetchPlanItems();
        } catch (err: any) {
            const message =
                err?.response?.data?.detail ||
                err?.response?.data?.error ||
                err?.message ||
                t('plan_upload_error');
            setEditError(message);
        } finally {
            setIsSavingAll(false);
        }
    };

    const handleAddRow = () => {
        if (!editPlanType || !editDateStr) return;
        const newId = -Date.now();
        setEditItems((prev) => ([
            ...prev,
            {
                id: newId,
                plan_date: editDateStr,
                plan_type: editPlanType,
                machine_name: '',
                part_no: '',
                model_name: '',
                part_spec: '',
                lot_no: '',
                planned_quantity: 0,
                sequence: null,
                isNew: true,
            },
        ]));
        window.setTimeout(() => {
            if (tableContainerRef.current) {
                tableContainerRef.current.scrollTo({
                    top: tableContainerRef.current.scrollHeight,
                    behavior: 'smooth',
                });
            }
        }, 0);
    };

    const toggleSelected = (id: number) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const toggleSelectAll = () => {
        setSelectedIds((prev) => {
            if (prev.size === editItems.length) {
                return new Set();
            }
            return new Set(editItems.map((item) => item.id));
        });
    };

    const handleDeleteSelected = async () => {
        if (selectedIds.size === 0) return;
        setEditError(null);
        const ids = Array.from(selectedIds);
        const newIds = ids.filter((id) => id < 0);
        if (newIds.length) {
            setEditItems((prev) => prev.filter((item) => !newIds.includes(item.id)));
        }
        const existingIds = ids.filter((id) => id > 0);
        if (existingIds.length) {
            try {
                await Promise.all(existingIds.map((id) => deleteProductionPlanItem(id)));
                await queryClient.invalidateQueries({ queryKey: ['planSummary'] });
                await refetchPlanItems();
            } catch (err: any) {
                const message =
                    err?.response?.data?.detail ||
                    err?.response?.data?.error ||
                    err?.message ||
                    t('plan_upload_error');
                setEditError(message);
            }
        }
        setSelectedIds(new Set());
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
                        <UploadCard planType="injection" onUploadSuccess={handleUploadSuccess} canEdit={canEditInjection} />
                    </div>
                    <div className="h-full">
                        <UploadCard planType="machining" onUploadSuccess={handleUploadSuccess} canEdit={canEditMachining} />
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
                                        canEdit={canEditInjection}
                                        onEditClick={() => openEditModal('injection')}
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
                                        canEdit={canEditMachining}
                                        onEditClick={() => openEditModal('machining')}
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
            {editPlanType && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div className="w-full max-w-6xl bg-white rounded-2xl shadow-2xl p-6 max-h-[85vh] overflow-hidden flex flex-col">
                        <div className="flex items-start justify-between gap-3 mb-4">
                            <div>
                                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest">
                                    {t('plan_edit_modal_title')}
                                </p>
                                <h3 className="text-xl font-bold text-gray-900">
                                    {editPlanLabel} - {editDateStr}
                                </h3>
                            </div>
                            <button
                                type="button"
                                onClick={closeEditModal}
                                className="rounded-full border border-gray-200 p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        {editError && (
                            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                {editError}
                            </div>
                        )}

                        <div className="flex items-center justify-between gap-3 mb-3">
                            <p className="text-xs text-gray-500">{t('plan_edit_helper')}</p>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                onClick={() => refetchPlanItems()}
                                className="gap-2"
                            >
                                <RefreshCcw className="h-4 w-4" />
                                {t('plan_edit_refresh')}
                            </Button>
                        </div>

                        <div ref={tableContainerRef} className="flex-1 overflow-auto border border-gray-100 rounded-lg">
                            {isPlanItemsLoading ? (
                                <div className="p-6 text-sm text-gray-500">{t('plan_edit_loading')}</div>
                            ) : editItems.length === 0 ? (
                                <div className="p-6 text-sm text-gray-500">{t('plan_edit_no_data')}</div>
                            ) : (
                                <table className="min-w-full text-sm">
                                    <thead className="sticky top-0 bg-gray-50 border-b border-gray-100 text-gray-600">
                                        <tr>
                                            <th className="px-3 py-2 text-center font-semibold">
                                                <input
                                                    type="checkbox"
                                                    checked={editItems.length > 0 && selectedIds.size === editItems.length}
                                                    onChange={toggleSelectAll}
                                                />
                                            </th>
                                            <th className="px-3 py-2 text-left font-semibold">{t('plan_edit_machine')}</th>
                                            <th className="px-3 py-2 text-left font-semibold">{t('plan_edit_part_no')}</th>
                                            <th className="px-3 py-2 text-left font-semibold">{t('plan_edit_model')}</th>
                                            <th className="px-3 py-2 text-left font-semibold">{t('plan_edit_lot')}</th>
                                            <th className="px-3 py-2 text-right font-semibold">{t('plan_edit_qty')}</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {editItems.map((item) => (
                                            (() => {
                                                const original = originalEditItems[item.id];
                                                const machineDirty = item.isNew || (!!original && (original.machine_name || '') !== (item.machine_name || ''));
                                                const partDirty = item.isNew || (!!original && (original.part_no || '') !== (item.part_no || ''));
                                                const modelDirty = item.isNew || (!!original && (original.model_name || '') !== (item.model_name || ''));
                                                const lotDirty = item.isNew || (!!original && (original.lot_no || '') !== (item.lot_no || ''));
                                                const qtyDirty = item.isNew || (!!original && Number(original.planned_quantity ?? 0) !== Number(item.planned_quantity ?? 0));
                                                const highlightClass = (dirty: boolean) =>
                                                    dirty ? 'bg-amber-50 border-amber-300 text-amber-900' : '';
                                                return (
                                            <tr key={item.id} className="hover:bg-gray-50">
                                                <td className="px-3 py-2 text-center">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedIds.has(item.id)}
                                                        onChange={() => toggleSelected(item.id)}
                                                    />
                                                </td>
                                                <td className="px-3 py-2">
                                                    <select
                                                        value={item.machine_name || ''}
                                                        onChange={(e) => updateEditItem(item.id, 'machine_name', e.target.value)}
                                                        className={`w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none ${highlightClass(machineDirty)}`}
                                                    >
                                                        <option value="">{t('select')}</option>
                                                        {machineOptions.map((machine) => (
                                                            <option key={machine.value} value={machine.value}>
                                                                {machine.label}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </td>
                                                <td className="px-3 py-2">
                                                    <input
                                                        value={item.part_no || ''}
                                                        list="plan-partno-options"
                                                        onChange={(e) => {
                                                            const next = e.target.value.toUpperCase();
                                                            updateEditItem(item.id, 'part_no', next);
                                                            setPartSearchTerm(next);
                                                            const match = partSuggestionMap.get(next);
                                                            if (match?.model_code) {
                                                                updateEditItem(item.id, 'model_name', match.model_code);
                                                            }
                                                        }}
                                                        className={`w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none ${highlightClass(partDirty)}`}
                                                    />
                                                </td>
                                                <td className="px-3 py-2">
                                                    <input
                                                        value={item.model_name || ''}
                                                        list="plan-model-options"
                                                        onChange={(e) => {
                                                            const next = e.target.value;
                                                            updateEditItem(item.id, 'model_name', next);
                                                            setPartSearchTerm(next);
                                                            if (!item.part_no) {
                                                                const matches = partSuggestions.filter((suggestion) => suggestion.model_code === next);
                                                                if (matches.length === 1 && matches[0]?.part_no) {
                                                                    updateEditItem(item.id, 'part_no', matches[0].part_no);
                                                                }
                                                            }
                                                        }}
                                                        className={`w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none ${highlightClass(modelDirty)}`}
                                                    />
                                                </td>
                                                <td className="px-3 py-2">
                                                    {item.isNew ? (
                                                        <input
                                                            value={item.lot_no || ''}
                                                            onChange={(e) => updateEditItem(item.id, 'lot_no', e.target.value)}
                                                            className={`w-full rounded-md border border-gray-200 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none ${highlightClass(lotDirty)}`}
                                                        />
                                                    ) : (
                                                        <span className="block text-xs text-gray-700">{item.lot_no || '-'}</span>
                                                    )}
                                                </td>
                                                <td className="px-3 py-2 text-right">
                                                    <input
                                                        type="text"
                                                        inputMode="numeric"
                                                        value={formatNumber(item.planned_quantity ?? 0)}
                                                        onChange={(e) => {
                                                            const raw = e.target.value.replace(/,/g, '').replace(/[^\d]/g, '');
                                                            updateEditItem(item.id, 'planned_quantity', Number(raw || 0));
                                                        }}
                                                        className={`w-28 rounded-md border border-gray-200 px-2 py-1 text-right text-xs focus:border-blue-400 focus:outline-none ${highlightClass(qtyDirty)}`}
                                                    />
                                                </td>
                                            </tr>
                                                );
                                            })()
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                        <datalist id="plan-partno-options">
                            {partSuggestions.map((suggestion) => (
                                <option
                                    key={suggestion.part_no}
                                    value={suggestion.part_no}
                                    label={suggestion.model_code || ''}
                                />
                            ))}
                        </datalist>
                        <datalist id="plan-model-options">
                            {modelOptions.map((model) => (
                                <option key={model} value={model} />
                            ))}
                        </datalist>

                        <div className="mt-4 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    onClick={handleAddRow}
                                    className="bg-emerald-600 text-white hover:bg-emerald-700"
                                >
                                    {t('add')}
                                </Button>
                                <Button
                                    type="button"
                                    onClick={handleDeleteSelected}
                                    disabled={selectedIds.size === 0}
                                    className="bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-200"
                                >
                                    {t('delete')}
                                </Button>
                            </div>
                            <div className="flex items-center gap-2">
                                <Button
                                    type="button"
                                    onClick={handleSaveAll}
                                    disabled={dirtyItems.length === 0 || isSavingAll}
                                >
                                    {isSavingAll ? t('plan_edit_saving') : t('plan_edit_save')}
                                </Button>
                                <Button type="button" variant="secondary" onClick={closeEditModal}>
                                    {t('plan_edit_close')}
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            </div>
        </div>
    );
}
