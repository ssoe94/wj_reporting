import axios from 'axios';

// API 기본 URL 설정
const API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:8000';

// axios 인스턴스 생성
const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// API 엔드포인트
export const endpoints = {
  // 사출 기록 관련
  records: {
    list: (date?: string) => `/api/reports/${date ? `?date=${date}` : ''}`,
    create: () => '/api/reports/',
    summary: (date?: string) => `/api/reports/summary/${date ? `?date=${date}` : ''}`,
  },
};

export default api; 