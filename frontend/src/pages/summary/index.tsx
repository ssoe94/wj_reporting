import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { format } from 'date-fns';

interface SummaryData {
  total_count: number;
  total_plan_qty: number;
  total_actual_qty: number;
  total_defect_qty: number;
  average_achievement_rate: number;
  average_defect_rate: number;
}

const SummaryPage: React.FC = () => {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));

  const fetchSummary = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${process.env.REACT_APP_API_URL}/api/reports/summary/?date=${selectedDate}`);
      setSummary(response.data);
    } catch (error) {
      console.error('Error fetching summary:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSummary();
  }, [selectedDate]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="alert alert-error">
          데이터를 불러오는데 실패했습니다.
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">일일 생산 현황</h1>

      <div className="mb-6">
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          className="input input-bordered"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* 총 생산 건수 */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">총 생산 건수</h2>
            <p className="text-4xl font-bold">{summary.total_count}건</p>
          </div>
        </div>

        {/* 계획 수량 */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">계획 수량</h2>
            <p className="text-4xl font-bold">{summary.total_plan_qty.toLocaleString()}개</p>
          </div>
        </div>

        {/* 실제 생산량 */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">실제 생산량</h2>
            <p className="text-4xl font-bold">{summary.total_actual_qty.toLocaleString()}개</p>
          </div>
        </div>

        {/* 불량 수량 */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">불량 수량</h2>
            <p className="text-4xl font-bold">{summary.total_defect_qty.toLocaleString()}개</p>
          </div>
        </div>

        {/* 평균 달성률 */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">평균 달성률</h2>
            <p className="text-4xl font-bold">{summary.average_achievement_rate.toFixed(1)}%</p>
          </div>
        </div>

        {/* 평균 불량률 */}
        <div className="card bg-base-100 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">평균 불량률</h2>
            <p className="text-4xl font-bold">{summary.average_defect_rate.toFixed(1)}%</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SummaryPage; 