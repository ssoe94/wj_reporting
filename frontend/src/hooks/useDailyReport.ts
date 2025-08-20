import { useState, useEffect } from 'react';
import api from '../lib/api';

// getToken 함수 추가
const getToken = () => {
  return localStorage.getItem('access_token');
};

interface DailyReportItem {
  snapshot_date: string;
  material_code: string;
  material_name: string;
  specification: string;
  warehouse_code: string;
  warehouse_name: string;
  qc_status: string;
  total_quantity: number;
  unit: string;
  cart_count: number;
  cart_details: Array<{
    qr_code: string;
    label_code: string;
    quantity: number;
    location_name: string;
    work_order_code: string;
    updated_at: string;
  }>;
  prev_quantity: number | null;
  quantity_change: number | null;
  quantity_change_percent: number | null;
  prev_cart_count: number | null;
  cart_count_change: number | null;
}

interface DailyReportSummary {
  report_date: string;
  prev_date: string;
  today: {
    total_items: number;
    total_quantity: number;
    total_carts: number;
  };
  prev_day: {
    total_items: number;
    total_quantity: number;
    total_carts: number;
  };
  warehouse_summary: Array<{
    warehouse_name: string;
    item_count: number;
    total_quantity: number;
    cart_count: number;
  }>;
}

interface DailyReportParams {
  date?: string;
  warehouse_code?: string;
  material_code?: string;
  warehouse_type?: string;
}

export function useDailyReport(params: DailyReportParams = {}) {
  const [data, setData] = useState<{
    results: DailyReportItem[];
    report_date: string;
    prev_date: string;
    total: number;
    snapshot_created_at?: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        const response = await api.get('/mes/inventory/daily-report/', { params });
        setData(response.data);
      } catch (err: any) {
        setError(err.response?.data?.error || '일일 보고서 데이터를 가져오는데 실패했습니다.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [params.date, params.warehouse_code, params.material_code]);

  return { data, isLoading, error };
}

export function useDailyReportSummary(date?: string) {
  const [data, setData] = useState<DailyReportSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        const response = await api.get('/mes/inventory/daily-report/summary/', { 
          params: { date } 
        });
        setData(response.data);
      } catch (err: any) {
        setError(err.response?.data?.error || '일일 보고서 요약 데이터를 가져오는데 실패했습니다.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [date]);

  return { data, isLoading, error };
}

export function useCreateSnapshot() {
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createSnapshot = async (date?: string, force: boolean = false) => {
    setIsCreating(true);
    setError(null);
    
    try {
      const response = await api.post('/mes/inventory/snapshot/create/', {
        date,
        force
      });
      return response.data;
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || '스냅샷 생성에 실패했습니다.';
      setError(errorMessage);
      throw new Error(errorMessage);
    } finally {
      setIsCreating(false);
    }
  };

  return { createSnapshot, isCreating, error };
} 

// 날짜 비교 훅
export function useDailyReportCompare(date1: string, date2: string, warehouse_code?: string) {
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!date1 || !date2) return;

    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          date1,
          date2,
          ...(warehouse_code && { warehouse_code })
        });
        
        const response = await fetch(`/api/mes/inventory/daily-report/compare/?${params}`, {
          headers: {
            'Authorization': `Bearer ${getToken()}`,
          },
        });
        
        if (!response.ok) {
          throw new Error('데이터를 가져오는데 실패했습니다.');
        }
        
        const result = await response.json();
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [date1, date2, warehouse_code]);

  return { data, isLoading, error };
}

// CSV 다운로드 훅
export function useDailyReportExport() {
  const [isExporting, setIsExporting] = useState(false);

  const exportCSV = async (params: {
    date: string;
    warehouse_code?: string;
    material_code?: string;
    compare_date?: string;
  }) => {
    setIsExporting(true);
    try {
      const queryParams = new URLSearchParams({
        date: params.date,
        ...(params.warehouse_code && { warehouse_code: params.warehouse_code }),
        ...(params.material_code && { material_code: params.material_code }),
        ...(params.compare_date && { compare_date: params.compare_date })
      });
      
      const response = await fetch(`/api/mes/inventory/daily-report/export-csv/?${queryParams}`, {
        headers: {
          'Authorization': `Bearer ${getToken()}`,
        },
      });
      
      if (!response.ok) {
        throw new Error('CSV 다운로드에 실패했습니다.');
      }
      
      // 파일 다운로드
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = response.headers.get('content-disposition')?.split('filename=')[1]?.replace(/"/g, '') || 'daily_report.csv';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
    } catch (error) {
      console.error('CSV 다운로드 오류:', error);
      throw error;
    } finally {
      setIsExporting(false);
    }
  };

  return { exportCSV, isExporting };
}

// 이메일 발송 훅
export function useEmailSchedule() {
  const [isScheduling, setIsScheduling] = useState(false);

  const scheduleEmail = async (params: {
    date: string;
    recipients: string[];
    scheduled_at?: string;
  }) => {
    setIsScheduling(true);
    try {
      const response = await fetch('/api/mes/inventory/email/schedule/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`,
        },
        body: JSON.stringify(params),
      });
      
      if (!response.ok) {
        throw new Error('이메일 발송 예약에 실패했습니다.');
      }
      
      return await response.json();
    } catch (error) {
      console.error('이메일 발송 예약 오류:', error);
      throw error;
    } finally {
      setIsScheduling(false);
    }
  };

  return { scheduleEmail, isScheduling };
}

// 이메일 상태 조회 훅
export function useEmailStatus(date: string) {
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!date) return;

    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/mes/inventory/email/status/?date=${date}`, {
          headers: {
            'Authorization': `Bearer ${getToken()}`,
          },
        });
        
        if (!response.ok) {
          throw new Error('이메일 상태를 가져오는데 실패했습니다.');
        }
        
        const result = await response.json();
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [date]);

  return { data, isLoading, error };
} 