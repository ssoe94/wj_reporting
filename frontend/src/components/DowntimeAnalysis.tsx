import { useState, useMemo, useCallback } from 'react';
import { useAllReports } from '@/hooks/useReports';
import { usePeriod } from '@/contexts/PeriodContext';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  LineChart,
  Line,
} from 'recharts';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { useLang } from '@/i18n';

const COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];
const RADIAN = Math.PI / 180;

interface DowntimeRow {
  reason: string;
  totalDuration: number;
  count: number;
  percentage: number;
}

function getTopNPlusOther(data: DowntimeRow[], n = 6): DowntimeRow[] {
  if (data.length <= n) return data;
  const main = data.slice(0, n);
  const others = data.slice(n);
  const otherTotal = others.reduce((s, i) => s + i.totalDuration, 0);
  const otherCount = others.reduce((s, i) => s + i.count, 0);
  const otherPerc = others.reduce((s, i) => s + i.percentage, 0);
  if (!otherTotal) return main;
  return [
    ...main,
    {
      reason: '기타',
      totalDuration: otherTotal,
      count: otherCount,
      percentage: parseFloat(otherPerc.toFixed(1)),
    },
  ];
}

// Y축 라벨 60도 기울임 함수
const renderAngleTick = (props: any) => {
  const { x, y, payload } = props;
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={16} textAnchor="end" fill="#666" transform="rotate(-60)">{payload.value}</text>
    </g>
  );
};

export default function DowntimeAnalysis() {
  const { data: reports = [] } = useAllReports();
  const { startDate, endDate, excludeWeekends } = usePeriod();
  const { t } = useLang();

  // renderPieLabel을 컴포넌트 내부에서 정의하여 t 함수 사용 가능
  const renderPieLabel = (props: any) => {
    const { cx, cy, midAngle, outerRadius, percent, reason } = props;
    const isOther = reason === '기타' || reason === t('other');
    const displayReason = isOther ? t('other') : reason;
    if (percent < 0.05) return null;
    const radius = outerRadius + 12;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);
    return (
      <text
        x={x}
        y={y}
        textAnchor={x > cx ? 'start' : 'end'}
        dominantBaseline="central"
        fontSize={12}
        fill="#4b5563"
      >
        {`${displayReason} ${(percent * 100).toFixed(0)}%`}
      </text>
    );
  };

  // 기간에 맞는 reports만 사용
  const filteredReports = useMemo(() => {
    if (startDate && endDate) {
      let filtered = reports.filter(r => r.date >= startDate && r.date <= endDate);
      
      // 주말 제외 필터링
      if (excludeWeekends) {
        filtered = filtered.filter(r => {
          const dayOfWeek = new Date(r.date).getDay();
          return dayOfWeek !== 0 && dayOfWeek !== 6; // 일요일(0)과 토요일(6) 제외
        });
      }
      
      return filtered;
    }
    return reports;
  }, [reports, startDate, endDate, excludeWeekends]);

  // downtimeRecords 생성
  const parseDowntimeFromNote = (note: string): Array<{ reason: string; duration: number }> => {
    if (!note) return [];
    const results: Array<{ reason: string; duration: number }> = [];
    const patterns = [
      /([가-힣A-Za-z0-9]+)[\s:]*([0-9]+) ?분/g, // 한글/영문
      /([a-zA-Z\s]+)\s*([0-9]+)min/g, // 영어
      /([^，\d]+)([0-9]+)分钟/g, // 중국어
    ];
    patterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(note)) !== null) {
        const reason = match[1].trim();
        const duration = parseInt(match[2], 10);
        if (reason && duration > 0) {
          results.push({ reason, duration });
        }
      }
    });
    return results;
  };

  const downtimeRecords = useMemo(() => {
    const list: any[] = [];
    filteredReports.forEach((r: any) => {
      const parsed = parseDowntimeFromNote(r.note || '');
      parsed.forEach(({ reason, duration }) => {
        list.push({
          date: r.date,
          machine_no: r.machine_no,
          model: r.model || r.product || '-',
          reason,
          duration,
          note: r.note || '',
        });
      });
    });
    return list;
  }, [filteredReports]);

  const downtimeSummary = useMemo(() => {
    const summaryMap = new Map<string, { totalDuration: number; count: number }>();
    let total = 0;
    downtimeRecords.forEach((rec) => {
      const prev = summaryMap.get(rec.reason) || { totalDuration: 0, count: 0 };
      prev.totalDuration += rec.duration;
      prev.count += 1;
      summaryMap.set(rec.reason, prev);
      total += rec.duration;
    });
    return Array.from(summaryMap.entries()).map(([reason, { totalDuration, count }]) => ({
      reason,
      totalDuration,
      count,
      percentage: total > 0 ? Math.round((totalDuration / total) * 100) : 0,
    })).sort((a, b) => b.totalDuration - a.totalDuration);
  }, [downtimeRecords]);

  const pieData = useMemo(() => getTopNPlusOther(downtimeSummary, 6), [downtimeSummary]);
  const totalDowntime = useMemo(() => downtimeSummary.reduce((s, i) => s + i.totalDuration, 0), [downtimeSummary]);

  // 일별 다운타임 trend 데이터
  const dailyTrend = useMemo(() => {
    const map = new Map<string, number>();
    downtimeRecords.forEach(r => {
      map.set(r.date, (map.get(r.date) || 0) + r.duration);
    });
    return Array.from(map.entries()).map(([date, duration]) => ({ date, duration })).sort((a, b) => a.date.localeCompare(b.date));
  }, [downtimeRecords]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selectedRecords = useMemo(() => {
    if (!selectedDate) return [];
    return downtimeRecords
      .filter(r => r.date === selectedDate)
      .sort((a, b) => (a.machine_no ?? 0) - (b.machine_no ?? 0));
  }, [selectedDate, downtimeRecords]);

  // 날짜를 MM-DD로 변환하는 함수
  const formatDate = (date: string) => {
    if (!date) return '';
    const d = new Date(date);
    if (!isNaN(d.getTime())) {
      return `${('0' + (d.getMonth() + 1)).slice(-2)}-${('0' + d.getDate()).slice(-2)}`;
    }
    // fallback: yyyy-mm-dd -> mm-dd
    return date.slice(5);
  };

  const [chartMode, setChartMode] = useState<'pie' | 'bar'>('pie');
  const toggleChart = useCallback(() => setChartMode((m) => (m === 'pie' ? 'bar' : 'pie')), []);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <button onClick={toggleChart} className="rounded-md border px-3 py-1 text-sm hover:bg-gray-100">
          {chartMode === 'pie' ? t('detail_view') : t('donut_view')}
        </button>
      </CardHeader>
      <CardContent>
        {/* 상단: 도넛/막대그래프 토글 */}
        <div className="flex flex-row gap-8 items-center justify-center">
          {chartMode === 'pie' ? (
            <div style={{ width: 320, height: 260 }}>
              <PieChart width={320} height={260}>
                <Pie
                  data={pieData}
                  dataKey="totalDuration"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  innerRadius={55}
                  minAngle={8}
                  label={renderPieLabel}
                  labelLine={false}
                  onClick={({ reason }) => {
                    if (reason === t('other')) {
                      // setShowOtherBar(true); // Removed
                    }
                    // else setShowOtherBar(false); // Removed
                    // if (reason !== t('other')) setDrillReason(reason); // Removed
                  }}
                >
                  {pieData.map((_entry: any, idx: number) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} style={{ cursor: 'pointer' }} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number, _n: any, p: any) => [`${v} ${t('min_unit')}`, p.payload.reason === '기타' ? t('other') : p.payload.reason]} />
                <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" fontSize={18} fontWeight="bold" fill="#111827">{totalDowntime.toLocaleString()}{t('min_unit')}</text>
                <text x="50%" y="50%" dy={20} textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#6b7280">{t('total_downtime')}</text>
              </PieChart>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={downtimeSummary} layout="horizontal" margin={{ top: 20, right: 20, bottom: 20, left: 40 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="reason" tick={renderAngleTick} interval={0} height={60} />
                <YAxis tick={{ fontSize: 12 }} label={{ value: t('time_min'), angle: -90, position: 'insideLeft', dy: 20 }} />
                <Tooltip formatter={(v: number, _n: any, p: any) => [`${v} ${t('min_unit')}`, p.payload.reason === '기타' ? t('other') : p.payload.reason]} />
                <Bar dataKey="totalDuration" isAnimationActive={false}>
                  {downtimeSummary.map((_entry: any, idx: number) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} cursor="pointer" />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* 하단: 트렌드(라인차트) 항상 표시 */}
        <div className="mt-8">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart
              data={dailyTrend}
              margin={{ top: 10, right: 20, bottom: 10, left: 40 }}
              onClick={(e: any) => {
                if (e && e.activeLabel) {
                  setSelectedDate(e.activeLabel);
                }
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} interval={0} height={32} tickFormatter={formatDate} />
              <YAxis
                tick={{ fontSize: 12 }}
                label={{ value: t('downtime_min'), angle: -90, position: 'insideLeft', dy: 20, positionAnchor: 'middle' }}
              />
              <Tooltip formatter={(v: number) => [`${v} ${t('min_unit')}`, t('downtime')]} labelFormatter={formatDate} />
              <Line
                type="monotone"
                dataKey="duration"
                stroke="#8884d8"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* trend chart 날짜 클릭 시 상세 테이블 */}
        {selectedDate && (
          <div className="mt-4 min-h-[300px]">
            <div className="flex items-center mb-2">
              <span className="font-semibold">{selectedDate} {t('downtime_detail')}</span>
              <button className="ml-4 text-xs text-blue-600 hover:underline" onClick={() => setSelectedDate(null)}>
                {t('close')}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left w-24">{t('date')}</th>
                    <th className="px-4 py-2 text-left w-16">{t('machine_no')}</th>
                    <th className="px-4 py-2 text-left w-32">{t('model')}</th>
                    <th className="px-4 py-2 text-left w-40">{t('reason')}</th>
                    <th className="px-4 py-2 text-right w-20">{t('duration')}</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRecords.map((r, idx) => (
                    <tr key={idx} className="border-t border-gray-200 hover:bg-gray-50">
                      <td className="px-4 py-2 w-24">{r.date}</td>
                      <td className="px-4 py-2 w-16">{r.machine_no}</td>
                      <td className="px-4 py-2 w-32">{r.model || '-'}</td>
                      <td className="px-4 py-2 w-40">{r.reason === '기타' || r.reason === t('other') ? t('other') : r.reason}</td>
                      <td className="px-4 py-2 text-right w-20">{r.duration}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
