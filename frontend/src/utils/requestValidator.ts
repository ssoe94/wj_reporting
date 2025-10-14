/**
 * API 요청 파라미터 유효성 검증 유틸리티
 */

/**
 * 날짜 형식 검증 (YYYY-MM-DD)
 */
export function validateDate(date: string | undefined): string {
  if (!date || date.trim() === '') {
    throw new Error('날짜가 비어있습니다.');
  }
  
  const trimmed = date.trim();
  
  // 날짜 형식 검증 (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(trimmed)) {
    throw new Error(`잘못된 날짜 형식입니다: ${trimmed}. YYYY-MM-DD 형식을 사용하세요.`);
  }
  
  // 실제 날짜 유효성 검증
  const dateObj = new Date(trimmed);
  if (isNaN(dateObj.getTime())) {
    throw new Error(`유효하지 않은 날짜입니다: ${trimmed}`);
  }
  
  return trimmed;
}

/**
 * 문자열 파라미터 검증 및 인코딩
 */
export function validateAndEncodeParam(
  value: string | undefined,
  paramName: string
): string {
  if (!value || value.trim() === '') {
    throw new Error(`${paramName}이(가) 비어있습니다.`);
  }
  
  const trimmed = value.trim();
  
  // 위험한 문자 감지
  if (trimmed.includes('<') || trimmed.includes('>')) {
    throw new Error(`${paramName}에 허용되지 않는 문자가 포함되어 있습니다.`);
  }
  
  // URL 인코딩
  return encodeURIComponent(trimmed);
}

/**
 * 숫자 파라미터 검증
 */
export function validateNumber(
  value: string | number | undefined,
  paramName: string,
  options?: { min?: number; max?: number }
): number {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${paramName}이(가) 비어있습니다.`);
  }
  
  const num = typeof value === 'string' ? parseFloat(value) : value;
  
  if (isNaN(num)) {
    throw new Error(`${paramName}은(는) 숫자여야 합니다: ${value}`);
  }
  
  if (options?.min !== undefined && num < options.min) {
    throw new Error(`${paramName}은(는) ${options.min} 이상이어야 합니다.`);
  }
  
  if (options?.max !== undefined && num > options.max) {
    throw new Error(`${paramName}은(는) ${options.max} 이하여야 합니다.`);
  }
  
  return num;
}

/**
 * 배열 파라미터 검증
 */
export function validateArray<T>(
  value: T[] | undefined,
  paramName: string,
  options?: { minLength?: number; maxLength?: number }
): T[] {
  if (!value || !Array.isArray(value)) {
    throw new Error(`${paramName}은(는) 배열이어야 합니다.`);
  }
  
  if (options?.minLength !== undefined && value.length < options.minLength) {
    throw new Error(`${paramName}은(는) 최소 ${options.minLength}개 이상이어야 합니다.`);
  }
  
  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    throw new Error(`${paramName}은(는) 최대 ${options.maxLength}개 이하여야 합니다.`);
  }
  
  return value;
}

/**
 * 쿼리 파라미터 객체 생성 (빈 값 제외)
 */
export function buildQueryParams(params: Record<string, any>): string {
  const filtered = Object.entries(params)
    .filter(([_, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      const encodedKey = encodeURIComponent(key);
      const encodedValue = encodeURIComponent(String(value));
      return `${encodedKey}=${encodedValue}`;
    });
  
  return filtered.length > 0 ? `?${filtered.join('&')}` : '';
}
