/**
 * API 에러 핸들링 유틸리티
 */
import { AxiosError } from 'axios';

export interface APIError {
  message: string;
  status?: number;
  url?: string;
  method?: string;
  contentType?: string;
  isHTMLResponse?: boolean;
}

/**
 * Axios 에러를 사용자 친화적인 메시지로 변환
 */
export function handleAPIError(error: unknown): APIError {
  if (error instanceof AxiosError) {
    const contentType = error.response?.headers['content-type'] || '';
    const isHTMLResponse = contentType.includes('text/html');
    
    // HTML 응답 감지 (프록시 실패)
    if (isHTMLResponse) {
      return {
        message: 'API 라우팅 오류: 서버가 HTML을 반환했습니다. 프록시 설정을 확인하세요.',
        status: error.response?.status,
        url: error.config?.url,
        method: error.config?.method?.toUpperCase(),
        contentType,
        isHTMLResponse: true,
      };
    }
    
    // 네트워크 에러
    if (!error.response) {
      return {
        message: '네트워크 오류: 서버에 연결할 수 없습니다.',
        url: error.config?.url,
        method: error.config?.method?.toUpperCase(),
      };
    }
    
    // HTTP 상태 코드별 메시지
    const status = error.response.status;
    let message = '알 수 없는 오류가 발생했습니다.';
    
    switch (status) {
      case 400:
        message = '잘못된 요청입니다. 입력값을 확인하세요.';
        break;
      case 401:
        message = '인증이 필요합니다. 다시 로그인하세요.';
        break;
      case 403:
        message = '접근 권한이 없습니다.';
        break;
      case 404:
        message = '요청한 리소스를 찾을 수 없습니다.';
        break;
      case 500:
        message = '서버 오류가 발생했습니다.';
        break;
      case 502:
      case 503:
      case 504:
        message = '서버가 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도하세요.';
        break;
    }
    
    // 서버에서 제공한 에러 메시지가 있으면 사용
    if (error.response.data && typeof error.response.data === 'object') {
      const data = error.response.data as any;
      if (data.detail) {
        message = data.detail;
      } else if (data.message) {
        message = data.message;
      }
    }
    
    return {
      message,
      status,
      url: error.config?.url,
      method: error.config?.method?.toUpperCase(),
      contentType,
    };
  }
  
  // 일반 에러
  if (error instanceof Error) {
    return {
      message: error.message,
    };
  }
  
  return {
    message: '알 수 없는 오류가 발생했습니다.',
  };
}

/**
 * 에러를 콘솔에 상세히 로깅
 */
export function logAPIError(error: APIError): void {
  console.error('[API Error]', {
    message: error.message,
    status: error.status,
    url: error.url,
    method: error.method,
    contentType: error.contentType,
    isHTMLResponse: error.isHTMLResponse,
  });
}

/**
 * 사용자에게 에러 토스트 표시 (구현 예시)
 */
export function showErrorToast(error: APIError): void {
  // 실제 프로젝트에서는 toast 라이브러리 사용
  // 예: toast.error(error.message)
  
  // 임시: alert 사용
  const details = [
    error.message,
    error.status ? `Status: ${error.status}` : '',
    error.url ? `URL: ${error.url}` : '',
  ].filter(Boolean).join('\n');
  
  console.error(details);
  
  // 개발 환경에서만 상세 정보 표시
  if (import.meta.env.DEV) {
    alert(details);
  } else {
    // 프로덕션에서는 간단한 메시지만
    alert(error.message);
  }
}
