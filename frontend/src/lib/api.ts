import axios, { AxiosError } from 'axios';

// API 기본 URL 설정 - 환경 변수 우선, 없으면 프록시 사용
const API_URL = import.meta.env.VITE_API_BASE_URL || '/api';

console.log('[API Config] Base URL:', API_URL);
console.log('[API Config] Environment:', import.meta.env.MODE);

// axios 인스턴스 생성
const api = axios.create({
  baseURL: API_URL,
  timeout: 30000, // 30초 타임아웃
  withCredentials: false, // CORS 자격증명 미포함
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

// 응답 인터셉터: 토큰 만료 시 자동 갱신 및 에러 로깅
api.interceptors.response.use(
  (response) => {
    // 응답 헤더 검증 (디버깅용)
    const contentType = response.headers['content-type'];
    if (contentType && !contentType.includes('application/json')) {
      console.warn('[API Warning] Non-JSON response:', {
        url: response.config.url,
        contentType,
        status: response.status,
      });
    }
    return response;
  },
  async (error: AxiosError) => {
    const originalRequest = error.config as any;
    
    // HTML 응답 감지 (프록시 실패 시)
    if (error.response) {
      const contentType = error.response.headers['content-type'];
      if (contentType?.includes('text/html')) {
        console.error('[API Error] Received HTML instead of JSON:', {
          url: originalRequest?.url,
          method: originalRequest?.method,
          status: error.response.status,
          contentType,
          baseURL: API_URL,
        });
        return Promise.reject(new Error(
          `API routing error: Received HTML instead of JSON. Check proxy configuration. URL: ${originalRequest?.url}`
        ));
      }
    }
    
    // 401 에러 처리
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
        localStorage.removeItem('access_token');
        localStorage.removeItem('refresh_token');
        window.location.href = '/login';
      }
    }
    
    // 일반 에러 로깅
    console.error('[API Error]', {
      url: originalRequest?.url,
      method: originalRequest?.method,
      status: error.response?.status,
      message: error.message,
      data: error.response?.data,
    });
    
    return Promise.reject(error);
  }
);

// 파라미터 유효성 검증 헬퍼
function validateAndEncodeParam(value: string | undefined, paramName: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`Invalid ${paramName}: value is empty or undefined`);
  }
  
  // 잘못된 문자 감지 (HTML 태그 등)
  if (value.includes('<') || value.includes('>')) {
    throw new Error(`Invalid ${paramName}: contains invalid characters`);
  }
  
  return encodeURIComponent(value.trim());
}

// API 엔드포인트 (파라미터 가드 포함)
export const endpoints = {
  // 사출 기록 관련
  records: {
    list: (date?: string) => {
      if (date) {
        const encodedDate = validateAndEncodeParam(date, 'date');
        return `/reports/?date=${encodedDate}`;
      }
      return '/reports/';
    },
    create: () => '/reports/',
    summary: (date?: string) => {
      if (date) {
        const encodedDate = validateAndEncodeParam(date, 'date');
        return `/reports/summary/?date=${encodedDate}`;
      }
      return '/reports/summary/';
    },
  },
};

export { api };
export default api; 