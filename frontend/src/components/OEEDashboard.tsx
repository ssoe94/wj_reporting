import React, { useState, useEffect, useMemo } from 'react';
import { useReports } from '@/hooks/useReports';
import { useLang } from '@/i18n';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
} from 'recharts';
import dayjs from 'dayjs';
import { usePeriod } from '@/contexts/PeriodContext';

interface OEEData {
  date: string;
  availability: number;
  performance: number;
  quality: number;
  oee: number;
  isWeekend: boolean;
  dayOfWeek: number;
}

// X축 라벨 60도 기울임 함수
const renderAngleTick = (props: any) => {
  const { x, y, payload } = props;
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={16} textAnchor="end" fill="#666" transform="rotate(-60)">{payload.value}</text>
    </g>
  );
};


export default function OEEDashboard() {
  const { data: reports = [] } = useReports();
  const { t } = useLang();
  const { startDate, endDate, excludeWeekends, setStartDate, setEndDate } = usePeriod();
  const [compareMode, setCompareMode] = useState(false);
  const [selectedDates, setSelectedDates] = useState<string[]>([]);

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
    if (dataDateRange.minDate && dataDateRange.maxDate) {
      setStartDate(dataDateRange.minDate);
      setEndDate(dataDateRange.maxDate);
    }
  }, [dataDateRange, setStartDate, setEndDate]);

  const oeeData: OEEData[] = React.useMemo(() => {
    const dailyMap = new Map<string, {
      totalTime: number;
      operationTime: number;
      planQty: number;
      actualQty: number;
      totalQty: number;
    }>();

    reports.forEach((r) => {
      const entry = dailyMap.get(r.date) || {
        totalTime: 0,
        operationTime: 0,
        planQty: 0,
        actualQty: 0,
        totalQty: 0,
      };

      // 가동률 계산을 위한 시간 설정
      // totalTime: 17대 × 24시간 = 24,480분 (고정값, 분모)
      // operationTime: 각 설비의 실제 가동시간 합계 (다운타임 제외, 분자)
      if (!entry.totalTime) {
        entry.totalTime = 17 * 24 * 60; // 17대 × 24시간 × 60분 = 24,480분
      }
      entry.operationTime += r.operation_time || 0;
      entry.planQty += r.plan_qty;
      entry.actualQty += r.actual_qty;
      entry.totalQty += (r.actual_qty + r.actual_defect);

      dailyMap.set(r.date, entry);
    });

    let filteredData = Array.from(dailyMap.entries())
      .map(([date, data]) => {
        // Availability = 모든 설비의 실제 가동시간 합계 / (17대 × 24시간)
        // 실제 가동시간 = operation_time (다운타임 제외)
        const availability = data.totalTime > 0 ? (data.operationTime / data.totalTime) * 100 : 0;

        // Performance = 실제 생산수 / 목표 생산량 × 100
        // 실제 생산수 = 양품 + 불량
        // 목표 생산량 = plan_qty
        const performance = data.planQty > 0
          ? (data.totalQty / data.planQty) * 100
          : 0;

        // Quality = 양품수 / 실제생산수
        const quality = data.totalQty > 0 ? (data.actualQty / data.totalQty) * 100 : 0;

        // OEE = A × P × Q (전체 설비 기준)
        const oee = (availability * performance * quality) / 10000;

        // 주말 여부 확인 (토요일=6, 일요일=0)
        const dayOfWeek = dayjs(date).day();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        return {
          date,
          availability: Math.round(availability * 10) / 10,
          performance: Math.round(performance * 10) / 10,
          quality: Math.round(quality * 10) / 10,
          oee: Math.round(oee * 10) / 10,
          isWeekend,
          dayOfWeek,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    // 기간 필터링
    if (startDate && endDate) {
      filteredData = filteredData.filter(item => 
        item.date >= startDate && item.date <= endDate
      );
      
      // 주말 제외 필터링
      if (excludeWeekends) {
        filteredData = filteredData.filter(item => !item.isWeekend);
      }
    }

    return filteredData;
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


  const getOeeColor = (oee: number) => {
    if (oee >= 85) return 'text-green-600';
    if (oee >= 70) return 'text-yellow-600';
    return 'text-red-600';
  };

  if (!oeeData.length) {
    return <p className="text-gray-500 text-sm">OEE 데이터가 없습니다.</p>;
  }

  const latestOee = oeeData[oeeData.length - 1];

  return (
    <div className="space-y-6">
      {/* OEE 개요 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div title={t('OEE_툴팁')}>
          <Card>
            <CardHeader className="text-sm text-gray-500">OEE</CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${getOeeColor(latestOee.oee)}`}>{latestOee.oee}%</p>
            </CardContent>
          </Card>
        </div>
        <div title={t('가동률_툴팁')}>
          <Card>
            <CardHeader className="text-sm text-gray-500">{t('availability')} (A)</CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${getOeeColor(latestOee.availability)}`}>{latestOee.availability}%</p>
            </CardContent>
          </Card>
        </div>
        <div title={t('성능률_툴팁')}>
          <Card>
            <CardHeader className="text-sm text-gray-500">{t('performance')} (P)</CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${getOeeColor(latestOee.performance)}`}>{latestOee.performance}%</p>
            </CardContent>
          </Card>
        </div>
        <div title={t('품질률_툴팁')}>
          <Card>
            <CardHeader className="text-sm text-gray-500">{t('quality')} (Q)</CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${getOeeColor(latestOee.quality)}`}>{latestOee.quality}%</p>
            </CardContent>
          </Card>
        </div>
      </div>

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
                <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" vertical={true} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  interval={0}
                  height={32}
                  tickFormatter={d => d.slice(5)}
                  tickLine={{ stroke: '#666' }}
                  axisLine={{ stroke: '#666' }}
                />
                <YAxis 
                  tick={{ fontSize: 12 }}
                  tickLine={{ stroke: '#666' }}
                  axisLine={{ stroke: '#666' }}
                  domain={[0, 100]}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '4px' }}
                  formatter={(value: any, name: string) => [`${value}%`, name]}
                  labelFormatter={(label) => {
                    const data = oeeData.find(item => item.date === label);
                    const dayName = data?.isWeekend ? ` ${t('weekend')}` : ` ${t('weekday')}`;
                    return `${label}${dayName}`;
                  }}
                />
                <Line type="monotone" dataKey="oee" stroke="#8884d8" name="OEE" strokeWidth={2} />
                <Line type="monotone" dataKey="availability" stroke="#82ca9d" name={t('availability')} />
                <Line type="monotone" dataKey="performance" stroke="#ffc658" name={t('performance')} />
                <Line type="monotone" dataKey="quality" stroke="#ff7300" name={t('quality')} />
              </LineChart>
            </ResponsiveContainer>
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