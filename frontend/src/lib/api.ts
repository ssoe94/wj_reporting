import axios from 'axios';

// API 기본 URL 설정
let API_URL = import.meta.env.VITE_APP_API_URL as string | undefined;

if (!API_URL) {
  // Render 환경 감지: 프론트 서비스 도메인 → xxx.onrender.com
  const { hostname } = window.location;
  console.log('Current hostname:', hostname);
  
  if (hostname.endsWith('.onrender.com') && !hostname.includes('backend')) {
    // 백엔드 서비스는 "-backend" 접미사를 붙인 도메인이라고 가정
    API_URL = `https://${hostname.split('.')[0]}-backend.onrender.com/api`;
    console.log('Render backend URL configured:', API_URL);
  } else {
    API_URL = '/api'; // 로컬 또는 프록시 환경
    console.log('Local/proxy API URL configured:', API_URL);
  }
} else {
  console.log('Environment API URL configured:', API_URL);
}

// axios 인스턴스 생성
const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 요청 인터셉터: 인증 토큰 자동 추가
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('access_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 응답 인터셉터: 토큰 만료 시 자동 갱신
api.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error) => {
    const originalRequest = error.config;
    
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      
      try {
        const refreshToken = localStorage.getItem('refresh_token');
        if (refreshToken) {
          const response = await api.post('/token/refresh/', { refresh: refreshToken });
          const { access } = response.data;
          localStorage.setItem('access_token', access);
          originalRequest.headers.Authorization = `Bearer ${access}`;
          return api(originalRequest);
        }
      } catch (refreshError) {
        // 리프레시 토큰도 만료된 경우 로그아웃
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        window.location.href = '/login';
      }
    }
    
    return Promise.reject(error);
  }
);

// API 엔드포인트
export const endpoints = {
  // 사출 기록 관련
  records: {
    list: (date?: string) => `/api/reports/${date ? `?date=${date}` : ''}`,
    create: () => '/api/reports/',
    summary: (date?: string) => `/api/reports/summary/${date ? `?date=${date}` : ''}`,
  },
};

export { api };
export default api; 