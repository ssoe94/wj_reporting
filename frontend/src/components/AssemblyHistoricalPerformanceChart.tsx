import React from 'react';
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
interface AssemblyPerformanceData {
  date: string;
  part_no: string;
  actual_qty: number;
  uph: number;
  upph: number;
}

interface Props {
  data: AssemblyPerformanceData[];
  onBarClick?: (date: string, partNo: string) => void;
}

export default function AssemblyHistoricalPerformanceChart({ data, onBarClick }: Props) {

  // 평균 UPH 계산
  const avgUph = React.useMemo(() => {
    if (!data.length) return 0;
    const validUph = data.filter(item => item.uph != null && item.uph > 0);
    if (!validUph.length) return 0;
    const sum = validUph.reduce((acc, item) => acc + item.uph, 0);
    return parseFloat((sum / validUph.length).toFixed(1));
  }, [data]);

  // 평균 UPPH 계산
  const avgUpph = React.useMemo(() => {
    if (!data.length) return 0;
    const validUpph = data.filter(item => item.upph != null && item.upph > 0);
    if (!validUpph.length) return 0;
    const sum = validUpph.reduce((acc, item) => acc + item.upph, 0);
    return parseFloat((sum / validUpph.length).toFixed(1));
  }, [data]);

  // 데이터를 날짜 순으로 정렬 (오래된 것부터)
  const sortedData = [...data].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const formattedData = sortedData.map(item => ({
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
          <p style={{ color: '#16a34a' }}>
            {`평균 UPH: ${avgUph}`}
          </p>
          <p style={{ color: '#9333ea' }}>
            {`평균 UPPH: ${avgUpph}`}
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
          <YAxis yAxisId="left" label={{ value: '생산량', angle: -90, position: 'insideLeft', textAnchor: 'middle', style: {fontSize: '14px'} }} />
          <YAxis yAxisId="right" orientation="right" label={{ value: 'UPH/UPPH', angle: 90, position: 'insideRight', textAnchor: 'middle', style: {fontSize: '14px'} }} />
          <Tooltip content={<CustomTooltip />} />
          <Legend />
          <Bar yAxisId="left" dataKey="actual_qty" barSize={20} fill="#3b82f6" name="생산량" style={{ cursor: 'pointer' }} />
          <Line yAxisId="right" type="monotone" dataKey="uph" stroke="#f59e0b" strokeWidth={1.5} name="UPH" />
          <Line yAxisId="right" type="monotone" dataKey="upph" stroke="#dc2626" strokeWidth={1.5} name="UPPH" />
          <ReferenceLine yAxisId="right" y={avgUph} stroke="#16a34a" strokeWidth={1} />
          <ReferenceLine yAxisId="right" y={avgUpph} stroke="#9333ea" strokeWidth={1} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}