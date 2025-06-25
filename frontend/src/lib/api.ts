import axios from 'axios';

// 기본값 '/api' 는 로컬 개발(proxy) 전용
// 프로덕션(별도 도메인)에서는 백엔드 서비스 URL을 하드코딩하거나 환경변수로 주입
let API_URL = import.meta.env.VITE_APP_API_URL || '/api';

if (API_URL === '/api' && typeof window !== 'undefined') {
  // onrender 정적 호스팅 도메인에서 실행 중이라면 백엔드 서브도메인으로 자동 전환
  const host = window.location.hostname;
  if (host.endsWith('.onrender.com')) {
    API_URL = 'https://wj-reporting-backend.onrender.com/api';
  }
}

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