import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import api from '@/lib/api';
import { useLang } from '@/i18n';
import { Pencil, XCircle } from 'lucide-react';

interface Setup {
  id: number;
  setup_date: string;
  machine_no: number;
  part_no: string;
  model_code: string;
  target_cycle_time: number;
  standard_cycle_time: number | null;
  mean_cycle_time: number | null;
  status: string;
  setup_by_name: string;
  note: string;
  test_records: any[];
  avg_test_cycle_time: number | null;
  test_count: number;
  quality_pass_rate: number | null;
}

interface CycleTimeHistoryGraphProps {
  partNo: string;
  onEdit: (setup: Setup) => void;
  onDelete: (setup: Setup) => void;
}

interface HistoryRecord {
  model: string;
  description: string;
  partNo: string;
  target: number;
  mean: number | null;
  standard: number | null;
  setup: Setup;
}

interface ProcessedData {
  date: string;
  records: HistoryRecord[];
  avgCycleTime: number;
  totalCycleTime: number;
  count: number;
}

export default function CycleTimeHistoryGraph({ partNo, onEdit, onDelete }: CycleTimeHistoryGraphProps) {
  const { t, lang } = useLang();
  const [historyData, setHistoryData] = useState<ProcessedData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const rowsPerPage = 5;

  const allRecords = historyData.flatMap(dayData => dayData.records);
  allRecords.sort((a, b) => new Date(b.setup.setup_date).getTime() - new Date(a.setup.setup_date).getTime());

  const indexOfLastItem = currentPage * rowsPerPage;
  const indexOfFirstItem = indexOfLastItem - rowsPerPage;
  const currentItems = allRecords.slice(indexOfFirstItem, indexOfLastItem);

  const totalPages = Math.ceil(allRecords.length / rowsPerPage);

  // Part No. 앞 9자리 추출
  const partPrefix = partNo.substring(0, 9);

  useEffect(() => {
    loadHistoryData();
  }, [partNo]);

  const loadHistoryData = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.get(`/setup/cycle-time-history/?part_prefix=${partPrefix}`);

      // 데이터 가공
      const processedData = processHistoryData(response.data);
      setHistoryData(processedData);
    } catch (error) {
      console.error('Failed to load cycle time history:', error);
      setError(t('error_loading_data'));
    } finally {
      setLoading(false);
    }
  };

  const processHistoryData = (data: any): ProcessedData[] => {
    // 날짜별로 그룹화하고 평균 계산
    const grouped: { [key: string]: ProcessedData } = {};

    if (data.models) {
      data.models.forEach((model: any) => {
        model.data.forEach((record: any) => {
          const date = record.setup_date.split('T')[0];
          if (!grouped[date]) {
            grouped[date] = {
              date,
              records: [],
              totalCycleTime: 0,
              count: 0,
              avgCycleTime: 0
            };
          }

          let actualModelCode = record.model_code || '';
          let description = '';
          const separatorRegex = / – | - /;
          const separatorMatch = actualModelCode.match(separatorRegex);

          if (separatorMatch && typeof separatorMatch.index === 'number') {
            const separatorStartsAt = separatorMatch.index;
            const separatorEndsAt = separatorStartsAt + separatorMatch[0].length;
            actualModelCode = record.model_code.substring(0, separatorStartsAt);
            description = record.model_code.substring(separatorEndsAt);
          }

          grouped[date].records.push({
            model: actualModelCode,
            description: description,
            partNo: model.part_no,
            target: record.target_cycle_time,
            mean: record.mean_cycle_time,
            standard: record.standard_cycle_time,
            setup: record
          });

          grouped[date].totalCycleTime += record.target_cycle_time;
          grouped[date].count += 1;
        });
      });
    }

    // 배열로 변환하고 정렬
    return Object.values(grouped)
      .map(group => ({
        ...group,
        avgCycleTime: group.totalCycleTime / group.count
      }));
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(lang === 'ko' ? 'ko-KR' : 'zh-CN');
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white p-3 border border-gray-300 rounded shadow-lg">
          <p className="font-semibold">{formatDate(label)}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} style={{ color: entry.color }}>
              {entry.name}: {entry.value.toFixed(1)}{t('unit.seconds')}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  const overallAvgCycleTime = historyData.length > 0 ? (historyData.reduce((sum, day) => sum + day.avgCycleTime, 0) / historyData.length) : 0;

  const renderLegend = () => {
    return (
      <div className="absolute bg-white p-2 border border-gray-300 rounded shadow-lg" style={{ fontSize: '0.65rem', right: 40, bottom: 45 }}>
        <div className="flex items-center mb-1">
          <div style={{ width: 10, height: 2, backgroundColor: '#10B981', marginRight: 5 }} />
          <span>{t('history.avg_ct_legend')}</span>
        </div>
        <div className="flex items-center">
          <div style={{ width: 10, height: 2, backgroundColor: '#F59E0B', marginRight: 5 }} />
          <span>{t('history.setup_ct_record_legend')}</span>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex justify-center items-center h-40"
      >
        <div className="text-gray-500">{t('loading')}</div>
      </motion.div>
    );
  }

  if (error) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex justify-center items-center h-40"
      >
        <div className="text-red-500">{error}</div>
      </motion.div>
    );
  }

  if (historyData.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex justify-center items-center h-40"
      >
        <div className="text-gray-500">{t('history.no_data')}</div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="bg-gray-50 rounded-lg px-4 pb-4"
    >
      {/* 통계 요약 */}
      <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-4 p-3 bg-white rounded border border-gray-300">
        <div className="text-center">
          <div className="text-sm text-gray-500">{t('history.total_records')}</div>
          <div className="text-lg font-semibold text-gray-900">
            {historyData.reduce((sum, day) => sum + day.count, 0)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm text-gray-500">{t('avg_cycle_time')}</div>
          <div className="text-lg font-semibold text-green-600">
            {historyData.length > 0 ? (historyData.reduce((sum, day) => sum + day.avgCycleTime, 0) / historyData.length).toFixed(1) : '0'}
            {t('unit.seconds')}
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm text-gray-500">{t('history.period')}</div>
          <div className="text-sm font-medium text-gray-900">
            {historyData.length > 0 && formatDate(historyData[0].date)}
            {historyData.length > 1 && ` - ${formatDate(historyData[historyData.length - 1].date)}`}
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm text-gray-500">{t('history.model_count')}</div>
          <div className="text-lg font-semibold text-blue-600">
            {new Set(historyData.flatMap(day => day.records.map(r => r.model))).size}
          </div>
        </div>
      </div>

      <h4 className="text-lg font-semibold text-gray-900 mb-2">
        {partPrefix}** {t('history.ct_record_graph')}
      </h4>

      <div className="h-60 mb-4 relative">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={historyData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              stroke="#666"
              tick={{ fontSize: '0.65rem' }}
            />
            <YAxis
              label={{
                value: `C/T (${t('unit.seconds')})`,
                angle: -90,
                position: 'insideLeft',
                style: { textAnchor: 'middle', fontSize: '0.75rem' }
              }}
              stroke="#666"
              tick={{ fontSize: '0.65rem' }}
              domain={['dataMin - 10', 'dataMax + 10']}
            />
            <Tooltip content={<CustomTooltip />} />

            {overallAvgCycleTime > 0 && (
              <ReferenceLine
                y={overallAvgCycleTime}
                stroke="#10B981"
                strokeWidth={1}
              />
            )}

            {/* 개별 데이터 포인트들 - 주황색 점들 */}
            {historyData.map((dayData, dayIndex) =>
              dayData.records.map((record, recordIndex) => (
                <Line
                  key={`${dayIndex}-${recordIndex}`}
                  type="monotone"
                  dataKey={`records.${recordIndex}.target`}
                  stroke="#F59E0B"
                  strokeWidth={1}
                  strokeDasharray="5,5"
                  name={record.model}
                  dot={{ fill: '#F59E0B', strokeWidth: 1, r: 1 }}
                  connectNulls={false}
                />
              ))
            )}
          </LineChart>
        </ResponsiveContainer>
        {renderLegend()}
      </div>

      {/* 상세 정보 테이블 */}
      <div className="mt-4 max-h-40 overflow-y-auto border border-gray-200 rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 sticky top-0">
            <tr>
              <th className="px-3 py-2 text-center font-semibold">{t('date')}</th>
              <th className="px-3 py-2 text-center font-semibold">Model & Description</th>
              <th className="px-3 py-2 text-center font-semibold">{t('part_no')}</th>
              <th className="px-3 py-2 text-center font-semibold">{t('history.target_ct_label')}</th>
              <th className="px-3 py-2 text-center font-semibold">{t('history.mean_ct_label')}</th>
              <th className="px-3 py-2 text-center font-semibold">{t('history.standard_ct_label')}</th>
              <th className="px-3 py-2 text-center font-semibold">{t('ct_table.action_header')}</th>
            </tr>
          </thead>
          <tbody>
            {currentItems.map((record, index) => (
              <tr key={index} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-3 py-2 text-center">{formatDate(record.setup.setup_date)}</td>
                <td className="px-3 py-2 text-center font-medium">
                  {record.model}{record.description ? ` - ${record.description}` : ''}
                </td>
                <td className="px-3 py-2 text-center text-blue-600">{record.partNo}</td>
                <td className="px-3 py-2 text-center text-orange-600 font-medium">{record.target.toFixed(1)}</td>
                <td className="px-3 py-2 text-center">{record.mean?.toFixed(1) || '-'}</td>
                <td className="px-3 py-2 text-center">{record.standard?.toFixed(1) || '-'}</td>
                <td className="px-3 py-2 text-center">
                  <button onClick={() => onEdit(record.setup)} className="p-1"><Pencil size={16} /></button>
                  <button onClick={() => onDelete(record.setup)} className="p-1"><XCircle size={16} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-2 flex justify-center items-center space-x-2">
          <button
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="px-3 py-1 border rounded disabled:opacity-50"
          >
            {t('previous')}
          </button>
          <span className="text-sm">
            {t('page_info', { currentPage, totalPages })}
          </span>
          <button
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="px-3 py-1 border rounded disabled:opacity-50"
          >
            {t('next')}
          </button>
        </div>
      )}
    </motion.div>
  );
}