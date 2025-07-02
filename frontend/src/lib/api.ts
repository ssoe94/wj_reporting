import axios from 'axios';

// API 기본 URL 설정
let API_URL = import.meta.env.VITE_APP_API_URL as string | undefined;

if (!API_URL) {
  // Render 환경 감지: 프론트 서비스 도메인 → xxx.onrender.com
  const { hostname } = window.location;
  if (hostname.endsWith('.onrender.com') && !hostname.includes('backend')) {
    // 백엔드 서비스는 "-backend" 접미사를 붙인 도메인이라고 가정
    API_URL = `https://${hostname.split('.')[0]}-backend.onrender.com/api`;
  } else {
    API_URL = '/api'; // 로컬 또는 프록시 환경
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