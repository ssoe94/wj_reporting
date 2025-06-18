import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { format } from 'date-fns';

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
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">사출 생산 기록</h1>
        <Link to="/records/new" className="btn btn-primary">
          새 기록 추가
        </Link>
      </div>

      <div className="mb-6">
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="input input-bordered"
        />
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <span className="loading loading-spinner loading-lg"></span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-zebra w-full">
            <thead>
              <tr>
                <th>생산일자</th>
                <th>톤수</th>
                <th>모델명</th>
                <th>구분</th>
                <th className="text-right">계획</th>
                <th className="text-right">실적</th>
                <th className="text-right">달성률</th>
                <th className="text-right">불량수</th>
                <th className="text-right">불량률</th>
                <th className="text-right">가동률</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>{format(new Date(record.date), 'yyyy-MM-dd')}</td>
                  <td>{record.tonnage}</td>
                  <td>{record.model}</td>
                  <td>{record.section}</td>
                  <td className="text-right">{record.plan_qty.toLocaleString()}</td>
                  <td className="text-right">{record.actual_qty.toLocaleString()}</td>
                  <td className="text-right">{record.achievement_rate.toFixed(1)}%</td>
                  <td className="text-right">{record.actual_defect.toLocaleString()}</td>
                  <td className="text-right">{record.defect_rate.toFixed(1)}%</td>
                  <td className="text-right">{record.uptime_rate.toFixed(1)}%</td>
                  <td className="max-w-xs truncate">{record.note}</td>
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