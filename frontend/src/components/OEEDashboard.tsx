import React, { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader } from './ui/card';
import { useAllReports } from '../hooks/useReports';
import { usePeriod } from '../contexts/PeriodContext';
import { useLang } from '../i18n';
import dayjs from 'dayjs';

interface OEEData {
  date: string;
  availability: number;
  performance: number;
  quality: number;
  oee: number;
  isWeekend: boolean;
  dayOfWeek: number;
}

interface OEEAggregate {
  availability: number;
  performance: number;
  quality: number;
  oee: number;
}

function OeeDashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={idx} className="h-24 rounded-xl bg-gray-200" />
        ))}
      </div>
      <div className="h-64 rounded-2xl bg-gray-200" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="h-56 rounded-2xl bg-gray-200" />
        <div className="h-56 rounded-2xl bg-gray-200" />
      </div>
    </div>
  );
}

export default function OEEDashboard() {
  const { data, isLoading, isFetching } = useAllReports();
  const reports = data ?? [];
  const { t } = useLang();
  const { startDate, endDate, excludeWeekends, setStartDate, setEndDate } = usePeriod();
  const [compareMode, setCompareMode] = useState(false);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);
  const isLiteMode = document.documentElement.classList.contains('lite-mode');

  const showSkeleton = !data && (isLoading || isFetching);

  // 실제 데이터의 날짜 범위 계산
  const dataDateRange = useMemo(() => {
    if (reports.length === 0) return { minDate: '', maxDate: '' };

    const dates = reports.map(r => r.date).sort();
    return {
      minDate: dates[0],
      maxDate: dates[dates.length - 1]
    };
  }, [reports]);

  // 날짜 범위가 변경되면 자동으로 업데이트
  useEffect(() => {
    if (!dataDateRange.minDate || !dataDateRange.maxDate) return;

    let adjustedStart = startDate;
    let adjustedEnd = endDate;

    if (!adjustedStart || adjustedStart < dataDateRange.minDate) {
      adjustedStart = dataDateRange.minDate;
    } else if (adjustedStart > dataDateRange.maxDate) {
      adjustedStart = dataDateRange.maxDate;
    }

    if (!adjustedEnd || adjustedEnd > dataDateRange.maxDate) {
      adjustedEnd = dataDateRange.maxDate;
    } else if (adjustedEnd < dataDateRange.minDate) {
      adjustedEnd = dataDateRange.minDate;
    }

    if (adjustedStart > adjustedEnd) {
      adjustedStart = dataDateRange.minDate;
      adjustedEnd = dataDateRange.maxDate;
    }

    if (adjustedStart !== startDate) setStartDate(adjustedStart);
    if (adjustedEnd !== endDate) setEndDate(adjustedEnd);
  }, [dataDateRange, startDate, endDate, setStartDate, setEndDate]);

  const {
    chartData: oeeData,
    rangeMetrics,
    overallMetrics
  } = React.useMemo(() => {
    const reports = data ?? [];
    if (!reports.length) {
      return {
        chartData: [] as OEEData[],
        rangeMetrics: null as OEEAggregate | null,
        overallMetrics: null as OEEAggregate | null,
      };
    }

    const dailyMap = new Map<string, {
      totalTime: number;
      operationTime: number;
      planQty: number;
      actualQty: number;
      totalQty: number;
    }>();

    reports.forEach((r) => {
      if (!dailyMap.has(r.date)) {
        dailyMap.set(r.date, {
          totalTime: 17 * 24 * 60,
          operationTime: 0,
          planQty: 0,
          actualQty: 0,
          totalQty: 0,
        });
      }

      const entry = dailyMap.get(r.date)!;
      entry.operationTime += r.operation_time || 0;
      entry.planQty += r.plan_qty || 0;
      entry.actualQty += r.actual_qty || 0;
      entry.totalQty += (r.actual_qty || 0) + (r.actual_defect || 0);
    });

    const round1 = (value: number) => Math.round(value * 10) / 10;

    const toOeeData = ([date, data]: [string, { totalTime: number; operationTime: number; planQty: number; actualQty: number; totalQty: number; }]): OEEData => {
      const availabilityRaw = data.totalTime > 0 ? (data.operationTime / data.totalTime) * 100 : 0;
      const performanceRaw = data.planQty > 0 ? (data.totalQty / data.planQty) * 100 : 0;
      const qualityRaw = data.totalQty > 0 ? (data.actualQty / data.totalQty) * 100 : 0;
      const oeeRaw = (availabilityRaw * performanceRaw * qualityRaw) / 10000;
      const dayOfWeek = dayjs(date).day();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

      return {
        date,
        availability: round1(availabilityRaw),
        performance: round1(performanceRaw),
        quality: round1(qualityRaw),
        oee: round1(oeeRaw),
        isWeekend,
        dayOfWeek,
      };
    };

    const aggregate = (entries: Array<[string, { totalTime: number; operationTime: number; planQty: number; actualQty: number; totalQty: number; }]>): OEEAggregate | null => {
      if (!entries.length) return null;

      const totals = entries.reduce(
        (acc, [, data]) => {
          acc.totalTime += data.totalTime || 0;
          acc.operationTime += data.operationTime || 0;
          acc.planQty += data.planQty || 0;
          acc.actualQty += data.actualQty || 0;
          acc.totalQty += data.totalQty || 0;
          return acc;
        },
        { totalTime: 0, operationTime: 0, planQty: 0, actualQty: 0, totalQty: 0 }
      );

      const availabilityRaw = totals.totalTime > 0 ? (totals.operationTime / totals.totalTime) * 100 : 0;
      const performanceRaw = totals.planQty > 0 ? (totals.totalQty / totals.planQty) * 100 : 0;
      const qualityRaw = totals.totalQty > 0 ? (totals.actualQty / totals.totalQty) * 100 : 0;
      const oeeRaw = (availabilityRaw * performanceRaw * qualityRaw) / 10000;

      return {
        availability: round1(availabilityRaw),
        performance: round1(performanceRaw),
        quality: round1(qualityRaw),
        oee: round1(oeeRaw),
      };
    };

    const sortedEntries = Array.from(dailyMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    let filteredEntries = sortedEntries;

    if (startDate && endDate) {
      filteredEntries = filteredEntries.filter(([date]) => date >= startDate && date <= endDate);
      if (excludeWeekends) {
        filteredEntries = filteredEntries.filter(([date]) => {
          const day = dayjs(date).day();
          return day !== 0 && day !== 6;
        });
      }
    }

    const chartData = filteredEntries.map(toOeeData);
    const rangeMetrics = aggregate(filteredEntries);
    const overallMetrics = aggregate(sortedEntries);

    return { chartData, rangeMetrics, overallMetrics };
  }, [reports, startDate, endDate, excludeWeekends]);

  // 비교 모드에서 날짜 선택 처리
  const handleDateClick = (date: string) => {
    if (!compareMode) return;

    setSelectedDates(prev => {
      if (prev.includes(date)) {
        return prev.filter(d => d !== date);
      } else if (prev.length < 2) {
        return [...prev, date];
      } else {
        return [prev[1], date];
      }
    });
  };

  // 비교 데이터 계산
  const comparisonData = useMemo(() => {
    if (selectedDates.length !== 2) return null;

    const [date1, date2] = selectedDates;
    const data1 = oeeData.find(d => d.date === date1);
    const data2 = oeeData.find(d => d.date === date2);

    if (!data1 || !data2) return null;

    return { date1: data1, date2: data2 };
  }, [selectedDates, oeeData]);

  // 사출기별 상세 데이터 계산
  const machineComparisonData = useMemo(() => {
    if (selectedDates.length !== 2) return null;

    const [date1, date2] = selectedDates;

    // 각 날짜별 사출기 데이터 그룹화
    const getMachineData = (date: string) => {
      const dayReports = reports.filter(r => r.date === date);
      const machineMap = new Map<number, any>();

      dayReports.forEach(r => {
        const machineNo = r.machine_no;
        if (!machineMap.has(machineNo)) {
          machineMap.set(machineNo, {
            machine_no: machineNo,
            model: r.model || '-',
            actual_qty: 0,
            plan_qty: 0,
            total_qty: 0,
            operation_time: 0,
            total_time: 0
          });
        }

        const machine = machineMap.get(machineNo);
        machine.actual_qty += r.actual_qty || 0;
        machine.plan_qty += r.plan_qty || 0;
        machine.total_qty += (r.actual_qty || 0) + (r.actual_defect || 0);
        machine.operation_time += r.operation_time || 0;
        machine.total_time += r.total_time || 1440; // 기본 24시간
      });

      // 성능률과 품질률 계산
      return Array.from(machineMap.values()).map(machine => {
        const performance = machine.plan_qty > 0
          ? (machine.total_qty / machine.plan_qty) * 100
          : 0;
        const quality = machine.total_qty > 0
          ? (machine.actual_qty / machine.total_qty) * 100
          : 0;

        return {
          ...machine,
          performance: Math.round(performance * 10) / 10,
          quality: Math.round(quality * 10) / 10
        };
      }).sort((a, b) => a.machine_no - b.machine_no);
    };

    const date1Data = getMachineData(date1);
    const date2Data = getMachineData(date2);

    // 모든 사출기 번호 수집
    const allMachineNos = new Set([
      ...date1Data.map(d => d.machine_no),
      ...date2Data.map(d => d.machine_no)
    ]);

    return {
      date1,
      date2,
      date1Data: date1Data,
      date2Data: date2Data,
      allMachineNos: Array.from(allMachineNos).sort((a, b) => a - b)
    };
  }, [selectedDates, reports]);


  const getOeeColor = (value?: number) => {
    if (value == null) return 'text-gray-400';
    if (value >= 85) return 'text-green-600';
    if (value >= 70) return 'text-yellow-600';
    return 'text-red-600';
  };

  if (showSkeleton) {
    return <OeeDashboardSkeleton />;
  }

  if (!overallMetrics) {
    return <p className="text-gray-500 text-sm">{t('analysis_no_period_data')}</p>;
  }

  const rangeLabel = startDate && endDate ? `${startDate} ~ ${endDate}` : '';
  const overallLabel =
    dataDateRange.minDate && dataDateRange.maxDate
      ? `${dataDateRange.minDate} ~ ${dataDateRange.maxDate}`
      : '';

  const summaryRows = [
    {
      key: 'range',
      title: t('analysis_selected_period'),
      subtitle: rangeLabel,
      metrics: rangeMetrics,
    },
    {
      key: 'overall',
      title: t('analysis_all_data'),
      subtitle: overallLabel,
      metrics: overallMetrics,
    },
  ];

  const metricCards = [
    { key: 'oee', label: 'OEE', tooltip: t('OEE_툴팁') },
    { key: 'availability', label: `${t('availability')} (A)`, tooltip: t('가동률_툴팁') },
    { key: 'performance', label: `${t('performance')} (P)`, tooltip: t('성능률_툴팁') },
    { key: 'quality', label: `${t('quality')} (Q)`, tooltip: t('품질률_툴팁') },
  ] as const;

  const formatValue = (value?: number) => (value != null ? `${value}%` : '-');
  const noRangeData = !rangeMetrics || oeeData.length === 0;

  return (
    <div className="space-y-6">
      {/* OEE 개요 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {metricCards.map((metric) => (
          <div key={metric.key} title={metric.tooltip}>
            <Card>
              <CardHeader className="text-sm text-gray-500">{metric.label}</CardHeader>
              <CardContent className="space-y-3">
                {summaryRows.map((row) => {
                  const value = row.metrics?.[metric.key];
                  return (
                    <div key={row.key} className="flex items-center justify-between gap-3">
                      <div className="flex flex-col">
                        <span className="text-xs font-medium text-gray-500">{row.title}</span>
                        {row.subtitle && (
                          <span className="text-[11px] text-gray-400">{row.subtitle}</span>
                        )}
                      </div>
                      <span className={`text-lg font-semibold ${getOeeColor(value)}`}>
                        {formatValue(value)}
                      </span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>
        ))}
      </div>
      {noRangeData && (
        <p className="text-xs text-orange-600">{t('analysis_no_period_data')}</p>
      )}

      {/* OEE 트렌드 차트 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">{t('oee_trend')}</h3>
            <button
              onClick={() => {
                setCompareMode(!compareMode);
                setSelectedDates([]);
              }}
              className={`px-3 py-1 rounded text-sm ${compareMode ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
            >
              {compareMode ? t('compare_mode_off') : t('compare')}
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-64">
            {oeeData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={oeeData}
                  margin={{ top: 20, right: 20, bottom: 5, left: 0 }}
                  onClick={(e: any) => {
                    if (compareMode && e && e.activeLabel) {
                      handleDateClick(e.activeLabel);
                    }
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={isLiteMode ? '#000000' : '#e0e0e0'} vertical />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: isLiteMode ? '#000000' : '#666666' }}
                    interval={0}
                    height={32}
                    tickFormatter={d => d.slice(5)}
                    tickLine={{ stroke: isLiteMode ? '#000000' : '#666' }}
                    axisLine={{ stroke: isLiteMode ? '#000000' : '#666' }}
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: isLiteMode ? '#000000' : '#666666' }}
                    tickLine={{ stroke: isLiteMode ? '#000000' : '#666' }}
                    axisLine={{ stroke: isLiteMode ? '#000000' : '#666' }}
                    domain={[0, 100]}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#fff',
                      border: isLiteMode ? '2px solid #000000' : '1px solid #ccc',
                      borderRadius: '4px',
                      color: '#000000',
                    }}
                    formatter={(value: any, name: string) => [`${value}%`, name]}
                    labelFormatter={(label) => {
                      const data = oeeData.find(item => item.date === label);
                      const dayName = data?.isWeekend ? ` ${t('weekend')}` : ` ${t('weekday')}`;
                      return `${label}${dayName}`;
                    }}
                  />
                  <Line type="monotone" dataKey="oee" stroke={isLiteMode ? '#000000' : '#8884d8'} name="OEE" strokeWidth={isLiteMode ? 3 : 2} />
                  <Line type="monotone" dataKey="availability" stroke={isLiteMode ? '#333333' : '#82ca9d'} name={t('availability')} strokeWidth={isLiteMode ? 2 : 1} />
                  <Line type="monotone" dataKey="performance" stroke={isLiteMode ? '#666666' : '#ffc658'} name={t('performance')} strokeWidth={isLiteMode ? 2 : 1} />
                  <Line type="monotone" dataKey="quality" stroke={isLiteMode ? '#999999' : '#ff7300'} name={t('quality')} strokeWidth={isLiteMode ? 2 : 1} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-500">
                {t('analysis_no_period_data')}
              </div>
            )}
          </div>
          {/* 비교 모드 안내 */}
          {compareMode && (
            <div className="mt-4 p-3 bg-blue-50 rounded-lg">
              <p className="text-sm text-blue-700">
                {t('compare_mode_guide')}
                {selectedDates.length > 0 && (
                  <span className="ml-2 font-medium">
                    {t('selected_dates')}: {selectedDates.join(', ')}
                  </span>
                )}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 비교 결과 표시 */}
      {comparisonData && (
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold">{t('날짜 비교 결과')}</h3>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h4 className="font-medium mb-3">{comparisonData.date1.date}</h4>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span>OEE:</span>
                    <span className={`font-bold ${getOeeColor(comparisonData.date1.oee)}`}>{comparisonData.date1.oee}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t('availability')}:</span>
                    <span className={`font-bold ${getOeeColor(comparisonData.date1.availability)}`}>{comparisonData.date1.availability}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t('performance')}:</span>
                    <span className={`font-bold ${getOeeColor(comparisonData.date1.performance)}`}>{comparisonData.date1.performance}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t('quality')}:</span>
                    <span className={`font-bold ${getOeeColor(comparisonData.date1.quality)}`}>{comparisonData.date1.quality}%</span>
                  </div>
                </div>
              </div>
              <div>
                <h4 className="font-medium mb-3">{comparisonData.date2.date}</h4>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span>OEE:</span>
                    <span className={`font-bold ${getOeeColor(comparisonData.date2.oee)}`}>{comparisonData.date2.oee}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t('availability')}:</span>
                    <span className={`font-bold ${getOeeColor(comparisonData.date2.availability)}`}>{comparisonData.date2.availability}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t('performance')}:</span>
                    <span className={`font-bold ${getOeeColor(comparisonData.date2.performance)}`}>{comparisonData.date2.performance}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{t('quality')}:</span>
                    <span className={`font-bold ${getOeeColor(comparisonData.date2.quality)}`}>{comparisonData.date2.quality}%</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 사출기별 상세 비교 테이블 */}
      {machineComparisonData && (
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold">{t('사출기별 상세 비교')}</h3>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left border-b">{t('사출기')}</th>
                    <th className="px-4 py-2 text-center border-b" colSpan={4}>{machineComparisonData.date1}</th>
                    <th className="px-4 py-2 text-center border-b" colSpan={4}>{machineComparisonData.date2}</th>
                  </tr>
                  <tr>
                    <th className="px-4 py-2 text-left border-b"></th>
                    <th className="px-2 py-1 text-center border-b text-xs">{t('model')}</th>
                    <th className="px-2 py-1 text-center border-b text-xs">{t('actual_qty')}</th>
                    <th className="px-2 py-1 text-center border-b text-xs">{t('performance')}</th>
                    <th className="px-2 py-1 text-center border-b text-xs">{t('quality')}</th>
                    <th className="px-2 py-1 text-center border-b text-xs">{t('model')}</th>
                    <th className="px-2 py-1 text-center border-b text-xs">{t('actual_qty')}</th>
                    <th className="px-2 py-1 text-center border-b text-xs">{t('performance')}</th>
                    <th className="px-2 py-1 text-center border-b text-xs">{t('quality')}</th>
                  </tr>
                </thead>
                <tbody>
                  {machineComparisonData.allMachineNos.map((machineNo, index) => {
                    const date1Machine = machineComparisonData.date1Data.find(d => d.machine_no === machineNo);
                    const date2Machine = machineComparisonData.date2Data.find(d => d.machine_no === machineNo);

                    return (
                      <tr key={machineNo} className={`${index % 2 === 0 ? 'bg-gray-50' : 'bg-white'} hover:bg-blue-50`}>
                        <td className="px-4 py-2 font-medium border-b">{machineNo}{t('호기')}</td>
                        {/* 날짜1 데이터 */}
                        <td className="px-2 py-2 text-center border-b">{date1Machine ? date1Machine.model : '-'}</td>
                        <td className="px-2 py-2 text-center border-b">{date1Machine ? date1Machine.actual_qty.toLocaleString() : '-'}</td>
                        <td className="px-2 py-2 text-center border-b">{date1Machine ? (<span className={`font-medium ${getOeeColor(date1Machine.performance)}`}>{date1Machine.performance}%</span>) : '-'}</td>
                        <td className="px-2 py-2 text-center border-b">{date1Machine ? (<span className={`font-medium ${getOeeColor(date1Machine.quality)}`}>{date1Machine.quality}%</span>) : '-'}</td>
                        {/* 날짜2 데이터 */}
                        <td className="px-2 py-2 text-center border-b">{date2Machine ? date2Machine.model : '-'}</td>
                        <td className="px-2 py-2 text-center border-b">{date2Machine ? date2Machine.actual_qty.toLocaleString() : '-'}</td>
                        <td className="px-2 py-2 text-center border-b">{date2Machine ? (<span className={`font-medium ${getOeeColor(date2Machine.performance)}`}>{date2Machine.performance}%</span>) : '-'}</td>
                        <td className="px-2 py-2 text-center border-b">{date2Machine ? (<span className={`font-medium ${getOeeColor(date2Machine.quality)}`}>{date2Machine.quality}%</span>) : '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
} 
