import React from 'react';
import { useLang } from '@/i18n';
import {
  Bar,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ComposedChart,
  ReferenceLine,
} from 'recharts';

// 데이터 포인트의 타입 정의
interface PerformanceData {
  date: string;
  part_no: string;
  actual_qty: number;
  actual_cycle_time: number;
}

interface Props {
  data: PerformanceData[];
  onBarClick?: (date: string, partNo: string) => void;
}

export default function HistoricalPerformanceChart({ data, onBarClick }: Props) {
  const { t } = useLang();

  // 평균 사이클타임 계산 (소수점 2자리까지)
  const avgCycleTime = React.useMemo(() => {
    if (!data.length) return 0;
    const validCycleTimes = data.filter(item => item.actual_cycle_time != null);
    if (!validCycleTimes.length) return 0;
    const sum = validCycleTimes.reduce((acc, item) => acc + item.actual_cycle_time, 0);
    return parseFloat((sum / validCycleTimes.length).toFixed(2));
  }, [data]);

  const formattedData = data.map(item => ({
    ...item,
    // X축에 표시될 라벨 형식 지정
    label: `${item.date.slice(5)} (${item.part_no.slice(-4)})`,
  }));

  // 바차트 클릭 핸들러
  const handleBarClick = (data: any) => {
    if (onBarClick && data && data.activePayload && data.activePayload[0]) {
      const payload = data.activePayload[0].payload;
      onBarClick(payload.date, payload.part_no);
    }
  };

  // 커스텀 툴팁
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white p-3 border border-gray-300 rounded shadow-lg">
          <p className="font-medium">{`${label}`}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} style={{ color: entry.color }}>
              {`${entry.name}: ${entry.value}`}
            </p>
          ))}
          <p style={{ color: '#059669' }}>
            {`${t('avg_cycle_time')}: ${avgCycleTime}초`}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="w-full h-80">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={formattedData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }} onClick={handleBarClick}>
          <CartesianGrid stroke="#f5f5f5" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis yAxisId="left" label={{ value: t('actual_qty'), angle: -90, position: 'insideLeft', textAnchor: 'middle', style: {fontSize: '14px'} }} />
          <YAxis yAxisId="right" orientation="right" label={{ value: t('table_ct'), angle: 90, position: 'insideRight', textAnchor: 'middle', style: {fontSize: '14px'} }} />
          <Tooltip content={<CustomTooltip />} />
          <Legend />
          <Bar yAxisId="left" dataKey="actual_qty" barSize={20} fill="#3b82f6" name={t('actual_qty')} style={{ cursor: 'pointer' }} />
          <Line yAxisId="right" type="monotone" dataKey="actual_cycle_time" stroke="#f59e0b" strokeWidth={2} name={t('table_ct')} />
          <ReferenceLine yAxisId="right" y={avgCycleTime} stroke="#059669" strokeWidth={1.5} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
