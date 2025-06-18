import { Link } from 'react-router-dom';
import axios from 'axios';
import { format } from 'date-fns';
import { useEffect, useState } from 'react';

interface InjectionRecord {
  id: number;
  date: string;
  tonnage: string;
  model: string;
  section: string;
  plan_qty: number;
  actual_qty: number;
  reported_defect: number;
  actual_defect: number;
  operation_time: number;
  total_time: number;
  note: string;
  achievement_rate: number;
  defect_rate: number;
  total_qty: number;
  uptime_rate: number;
}

const RecordsPage: React.FC = () => {
  const [records, setRecords] = useState<InjectionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const fetchRecords = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${import.meta.env.VITE_APP_API_URL}/api/reports/?date=${selectedDate}`);
      setRecords(response.data.results);
    } catch (error) {
      console.error('Error fetching records:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
  }, [selectedDate]);

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8 mt-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-2xl font-bold text-blue-700">사출 생산 기록</h1>
        <Link to="/records/new" className="btn btn-primary px-5 py-2 rounded-lg shadow font-semibold">새 기록 추가</Link>
      </div>
      <div className="mb-6 flex items-center gap-2">
        <span className="text-gray-600 font-medium">날짜</span>
        <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="input input-bordered" />
      </div>
      {loading ? (
        <div className="flex justify-center items-center h-64">
          <span className="loading loading-spinner loading-lg"></span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full table-auto border-collapse text-sm md:text-base">
            <thead>
              <tr className="bg-blue-50 text-blue-900">
                <th className="px-3 py-2 font-semibold">생산일자</th>
                <th className="px-3 py-2 font-semibold">톤수</th>
                <th className="px-3 py-2 font-semibold">모델명</th>
                <th className="px-3 py-2 font-semibold">구분</th>
                <th className="px-3 py-2 font-semibold text-right">계획</th>
                <th className="px-3 py-2 font-semibold text-right">실적</th>
                <th className="px-3 py-2 font-semibold text-right">달성률</th>
                <th className="px-3 py-2 font-semibold text-right">불량수</th>
                <th className="px-3 py-2 font-semibold text-right">불량률</th>
                <th className="px-3 py-2 font-semibold text-right">가동률</th>
                <th className="px-3 py-2 font-semibold">비고</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id} className="hover:bg-blue-50 transition">
                  <td className="px-3 py-2">{format(new Date(record.date), 'yyyy-MM-dd')}</td>
                  <td className="px-3 py-2">{record.tonnage}</td>
                  <td className="px-3 py-2">{record.model}</td>
                  <td className="px-3 py-2">{record.section}</td>
                  <td className="px-3 py-2 text-right">{record.plan_qty.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{record.actual_qty.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{record.achievement_rate.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right">{record.actual_defect.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right">{record.defect_rate.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right">{record.uptime_rate.toFixed(1)}%</td>
                  <td className="px-3 py-2 max-w-xs truncate">{record.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default RecordsPage; 