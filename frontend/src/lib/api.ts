import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { AuthRefreshError, refreshAccessToken } from '@/domains/auth/auth-refresh';
import { getAuthSessionSnapshot } from '@/domains/auth/auth-storage';
import { isDevSessionToken } from '@/domains/auth/dev-session';

// API 기본 URL 설정 - 환경 변수 우선, 없으면 프록시 사용
const API_URL = import.meta.env.PROD
  ? '/api'
  : (import.meta.env.VITE_API_BASE_URL || '/api');

console.log('[API Config] Base URL:', API_URL);
console.log('[API Config] Environment:', import.meta.env.MODE);

// axios 인스턴스 생성
const api = axios.create({
  baseURL: API_URL,
  timeout: 30000, // 30초 타임아웃
  withCredentials: false, // CORS: credentials 제거 (ALLOW_ALL_ORIGINS 사용 시 필수)
  headers: {
    'Content-Type': 'application/json',
  },
});

type RetriableRequest = InternalAxiosRequestConfig & {
  _retry?: boolean;
  _authSessionId?: string | null;
};

// 요청 인터셉터: 인증 토큰 자동 추가
api.interceptors.request.use(
  (config) => {
    const request = config as RetriableRequest;
    if (config.skipAuth) {
      config.headers.delete('Authorization');
      request._authSessionId = null;
      return config;
    }

    const session = getAuthSessionSnapshot();
    if (request._authSessionId === undefined) {
      request._authSessionId = session.id;
    }
    if (request._authSessionId !== session.id) {
      return Promise.reject(new AuthRefreshError('The authenticated session changed', false));
    }
    const token = session.access;
    if (token && !isDevSessionToken(token)) {
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
    const request = response.config as RetriableRequest;
    if (
      !request.skipAuth
      && request._authSessionId
      && request._authSessionId !== getAuthSessionSnapshot().id
    ) {
      return Promise.reject(new AuthRefreshError('The authenticated session changed', false));
    }
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
    const originalRequest = error.config as RetriableRequest | undefined;
    
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
    if (
      originalRequest &&
      !originalRequest.skipAuth &&
      error.response?.status === 401 &&
      !originalRequest._retry
    ) {
      originalRequest._retry = true;

      const requestSessionId = originalRequest._authSessionId;
      const session = getAuthSessionSnapshot();
      if (!requestSessionId || requestSessionId !== session.id) {
        return Promise.reject(new AuthRefreshError('The authenticated session changed', false));
      }

      const authorization = originalRequest.headers.Authorization;
      const failedAccess = typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : session.access;

      if (isDevSessionToken(failedAccess)) {
        return Promise.reject(error);
      }

      try {
        const refreshedAccess = await refreshAccessToken(failedAccess, requestSessionId);
        if (requestSessionId !== getAuthSessionSnapshot().id) {
          throw new AuthRefreshError('The authenticated session changed', false);
        }
        originalRequest.headers.Authorization = `Bearer ${refreshedAccess}`;
        return api(originalRequest);
      } catch (refreshError) {
        return Promise.reject(refreshError);
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
        return `/injection/reports/?date=${encodedDate}`;
      }
      return '/injection/reports/';
    },
    create: () => '/injection/reports/',
    summary: (date?: string) => {
      if (date) {
        const encodedDate = validateAndEncodeParam(date, 'date');
        return `/injection/reports/summary/?date=${encodedDate}`;
      }
      return '/injection/reports/summary/';
    },
  },
  production: {
    upload: () => '/production/plan/upload/',
    console: (date: string, planType: 'injection' | 'machining') =>
      `/production/console/?date=${validateAndEncodeParam(date, 'date')}&plan_type=${validateAndEncodeParam(planType, 'planType')}`,
    executionUpsert: () => '/production/executions/upsert/',
    mesReportStats: (date: string, planType: 'injection' | 'machining', rangeMode: 'day' | 'recent24h' = 'day') =>
      `/production/mes-report-stats/?date=${validateAndEncodeParam(date, 'date')}&plan_type=${validateAndEncodeParam(planType, 'planType')}&range_mode=${validateAndEncodeParam(rangeMode, 'rangeMode')}`,
    dashboard: (date: string, planType: 'injection' | 'machining') =>
      `/production/dashboard/?date=${validateAndEncodeParam(date, 'date')}&plan_type=${validateAndEncodeParam(planType, 'planType')}`,
    planDates: () => '/production/plan-dates/',
    planSummary: (date: string) => `/production/plan-summary/?date=${validateAndEncodeParam(date, 'date')}`,
    status: (date: string) => `/production/status/?date=${validateAndEncodeParam(date, 'date')}`,
    partCavity: () => '/production/part-cavity/',
    planItems: (date: string, planType: 'injection' | 'machining') =>
      `/production/plans/?date=${validateAndEncodeParam(date, 'date')}&plan_type=${validateAndEncodeParam(planType, 'planType')}`,
  },
};

export { api };
export default api; 

export async function uploadProductionPlanFile(file: File, planType: 'injection' | 'machining', targetDate: string) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('plan_type', planType);
  // target_date is the key expected by the backend
  formData.append('date', targetDate);

  const response = await api.post(endpoints.production.upload(), formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

export async function getProductionDashboardData(date: string, planType: 'injection' | 'machining') {
  const response = await api.get(endpoints.production.dashboard(date, planType));
  return response.data;
}

export async function getProductionConsoleData(date: string, planType: 'injection' | 'machining') {
  const response = await api.get(endpoints.production.console(date, planType));
  return response.data;
}

export async function getProductionMesReportStats(
  date: string,
  planType: 'injection' | 'machining',
  rangeMode: 'day' | 'recent24h' = 'day',
) {
  const response = await api.get(endpoints.production.mesReportStats(date, planType, rangeMode));
  return response.data;
}

export async function upsertProductionExecution(payload: {
  plan_date: string;
  plan_type: 'injection' | 'machining';
  machine_name: string;
  part_no: string;
  lot_no?: string | null;
  sequence: number;
  planned_quantity: number;
  model_name?: string | null;
  actual_qty?: number;
  defect_qty?: number;
  idle_time?: number;
  personnel_count?: number;
  operating_ct?: number | null;
  start_datetime?: string | null;
  end_datetime?: string | null;
  note?: string;
  status?: 'pending' | 'running' | 'completed' | 'paused';
}) {
  const response = await api.post(endpoints.production.executionUpsert(), payload);
  return response.data;
}

export async function getProductionStatusData(date: string) {
  const response = await api.get(endpoints.production.status(date));
  return response.data;
}

export async function getProductionPlanDates() {
  const response = await api.get(endpoints.production.planDates());
  return response.data;
}

export async function getProductionPlanSummary(date: string) {
  const response = await api.get(endpoints.production.planSummary(date));
  return response.data;
}

export async function getInjectionProductionMatrix(interval: '10min' | '30min' | '1hour' | '1day' = '1day', columns = 1, lang = 'zh') {
  const params = new URLSearchParams({
    interval,
    columns: String(columns),
    lang,
  });
  const response = await api.get(`/injection/production-matrix/?${params.toString()}`);
  return response.data;
}

export async function updateProductionPartCavity(partNo: string, cavity: number) {
  const response = await api.post(endpoints.production.partCavity(), {
    part_no: partNo,
    cavity,
  });
  return response.data;
}

export async function getProductionPlanItems(date: string, planType: 'injection' | 'machining') {
  const response = await api.get(endpoints.production.planItems(date, planType));
  return response.data;
}

export async function updateProductionPlanItem(
  planId: number,
  payload: Partial<{
    machine_name: string;
    part_no: string;
    model_name: string | null;
    part_spec: string | null;
    lot_no: string | null;
    planned_quantity: number;
    sequence: number | null;
  }>,
) {
  const response = await api.patch(`/production/plans/${planId}/`, payload);
  return response.data;
}

export async function createProductionPlanItem(payload: {
  plan_date: string;
  plan_type: 'injection' | 'machining';
  machine_name: string;
  part_no?: string | null;
  model_name?: string | null;
  part_spec?: string | null;
  lot_no?: string | null;
  planned_quantity: number;
}) {
  const response = await api.post('/production/plans/', payload);
  return response.data;
}

export async function deleteProductionPlanItem(planId: number) {
  const response = await api.delete(`/production/plans/${planId}/`);
  return response.data;
}

export async function searchProductionPlanParts(search: string, planType?: 'injection' | 'machining') {
  const response = await api.get('/production/plan-parts/', {
    params: {
      search,
      plan_type: planType,
    },
  });
  return response.data;
}
