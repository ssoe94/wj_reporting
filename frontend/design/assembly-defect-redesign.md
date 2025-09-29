# Assembly 가공 생산 기록 불량 시스템 UI 재설계

## 현재 시스템 분석

### 기존 구조 (AssemblyReportForm.tsx)
```
불량기록 카드
├── 입고불량 (assembly_incoming_defect)
│   ├── 아코디언 형태 토글
│   └── 11개 세부 항목: 划伤, 黑点, 吃肉, 气印, 变형, 浇不足, 断柱子, 料花, 缩瘪, 발백, 기타
├── 가공불량 (processing_defect)
│   ├── 아코디언 형태 토글
│   └── 4개 세부 항목: 划伤, 印刷, 加工修理, 기타
└── 외주불량 (outsourcing_defect)
    └── 단순 숫자 입력 필드
```

## 요구사항 분석

### 1. 명칭 변경
- **입고불량** → **사출불량** (injection_defect)
- 외주불량은 그대로 유지 (outsourcing_defect)

### 2. 레이아웃 재구성
- 기존: 수직 배열 (입고불량 → 가공불량)
- 신규: **가공불량을 2열로 분할**
  - 왼쪽: **가공불량** (processing_defect)
  - 오른쪽: **외주불량** (outsourcing_defect)

### 3. 동적 불량 유형 관리
각 카드(가공불량, 외주불량)에 다음 기능 추가:
- **불량 유형 필드** + **수량 필드** + **추가 버튼**
- 추가 시 카드 하단에 리스트 표시
- **히스토리 기반 드롭다운**: 이전 입력값들이 드롭다운 옵션으로 제공
- **직접 입력 지원**: 드롭다운에서 선택하지 않고 새로운 값 직접 타이핑 가능

## 설계 목표

### UI/UX 개선점
1. **직관성 향상**: 가공불량과 외주불량을 나란히 배치하여 구분 명확화
2. **유연성 확보**: 고정된 불량 유형이 아닌 동적 추가 시스템
3. **데이터 재사용**: 히스토리 기반 자동완성으로 입력 효율성 증대
4. **확장성**: 새로운 불량 유형을 제약 없이 추가 가능

### 기술적 요구사항
1. **ComboBox 컴포넌트**: 드롭다운 + 직접입력 하이브리드
2. **히스토리 API**: 불량 유형 히스토리 조회 엔드포인트
3. **상태 관리**: 동적 불량 목록 및 합계 자동 계산
4. **데이터 모델**: 기존 단일 필드에서 구조화된 배열로 확장

## 상세 설계

### 1. 새로운 UI 구조

```
불량기록 카드
├── 사출불량 (injection_defect)
│   ├── 아코디언 형태 토글
│   └── 기존 11개 세부 항목 유지
├── 가공불량 & 외주불량 (2열 그리드)
│   ├── 왼쪽: 가공불량 카드
│   │   ├── 불량유형 ComboBox + 수량 Input + 추가 버튼
│   │   └── 추가된 불량 목록 (유형별 수량 표시)
│   └── 오른쪽: 외주불량 카드
│       ├── 불량유형 ComboBox + 수량 Input + 추가 버튼
│       └── 추가된 불량 목록 (유형별 수량 표시)
```

### 2. DefectTypeInput 컴포넌트 설계

**Props Interface**
```typescript
interface DefectTypeInputProps {
  defectType: 'processing' | 'outsourcing';
  value: DefectEntry[];
  onChange: (entries: DefectEntry[]) => void;
  historyOptions: string[];
}

interface DefectEntry {
  id: string;
  type: string;    // 불량 유형명
  quantity: number; // 수량
}
```

**기능 명세**
- **ComboBox**: 히스토리 기반 옵션 + 자유 입력
- **수량 입력**: 숫자 전용, 최소값 1
- **추가 버튼**: 유형과 수량 모두 입력 시 활성화
- **목록 관리**: 추가/수정/삭제 기능
- **합계 표시**: 실시간 총 불량수 계산

### 3. ComboBox 컴포넌트 설계

**요구 기능**
```typescript
interface ComboBoxProps {
  options: string[];           // 드롭다운 옵션
  value: string;              // 현재 값
  onChange: (value: string) => void;
  placeholder?: string;
  allowCustomInput?: boolean; // 직접 입력 허용 여부
}
```

**동작 방식**
1. **드롭다운 모드**: 화살표 클릭 시 옵션 목록 표시
2. **검색 모드**: 타이핑 시 필터링된 옵션 표시
3. **직접 입력**: 옵션에 없는 값도 입력 가능
4. **키보드 네비게이션**: 방향키로 옵션 선택, Enter로 확정

### 4. 데이터 구조 변경

**기존 데이터 모델**
```typescript
interface AssemblyReport {
  injection_defect: number;      // 사출불량 (구 입고불량)
  processing_defect: number;     // 가공불량
  outsourcing_defect: number;    // 외주불량

  // 세부 불량 (고정 구조)
  incoming_defects_detail: Record<string, number>;
  processing_defects_detail: Record<string, number>;
}
```

**신규 데이터 모델**
```typescript
interface AssemblyReport {
  injection_defect: number;      // 사출불량 (구 입고불량)
  processing_defect: number;     // 가공불량 (자동 계산)
  outsourcing_defect: number;    // 외주불량 (자동 계산)

  // 기존 사출불량 세부사항 유지
  injection_defects_detail: Record<string, number>;

  // 새로운 동적 불량 구조
  processing_defects_entries: DefectEntry[];
  outsourcing_defects_entries: DefectEntry[];
}
```

### 5. API 엔드포인트 설계

**불량 유형 히스토리 조회**
```
GET /api/assembly/defect-types/history/
?type=processing|outsourcing
&limit=50

Response: {
  "processing_types": ["치수불량", "표면결함", "조립불량", ...],
  "outsourcing_types": ["도장불량", "가공정밀도", "재료결함", ...]
}
```

**기존 데이터 마이그레이션**
- 기존 processing_defect 값 → processing_defects_entries로 변환
- 기존 outsourcing_defect 값 → outsourcing_defects_entries로 변환
- 역방향 호환성을 위한 계산된 필드 유지

### 6. 사용자 시나리오

**시나리오 1: 기존 유형 선택**
1. 가공불량 카드에서 "불량유형" 드롭다운 클릭
2. 이전에 입력한 "치수불량" 선택
3. 수량 "5" 입력
4. "추가" 버튼 클릭
5. 하단에 "치수불량: 5개" 표시

**시나리오 2: 새로운 유형 입력**
1. 외주불량 카드에서 "불량유형" 필드에 "새로운불량" 직접 타이핑
2. 수량 "3" 입력
3. "추가" 버튼 클릭
4. 하단에 "새로운불량: 3개" 표시
5. 다음 사용시 드롭다운에 "새로운불량" 옵션 추가됨

**시나리오 3: 불량 목록 관리**
1. 추가된 불량 목록에서 수량 수정: 클릭하여 인라인 편집
2. 불량 항목 삭제: X 버튼으로 제거
3. 실시간 합계 업데이트 확인

## 구현 우선순위

### Phase 1: 기본 구조 개편
1. 레이아웃 변경 (사출불량 / 가공불량+외주불량 2열)
2. DefectTypeInput 컴포넌트 기본 틀
3. 동적 불량 목록 상태 관리

### Phase 2: ComboBox 고도화
1. 히스토리 기반 드롭다운 구현
2. 직접 입력 + 검색 필터링
3. 키보드 네비게이션

### Phase 3: API 통합
1. 불량 유형 히스토리 API 연동
2. 저장/로딩 로직 업데이트
3. 기존 데이터 마이그레이션

### Phase 4: 사용성 개선
1. 인라인 편집 기능
2. 드래그 앤 드롭 정렬
3. 불량율 차트 시각화

## 기술적 고려사항

### 성능 최적화
- **히스토리 캐싱**: 불량 유형 옵션을 로컬 스토리지에 캐시
- **디바운싱**: 타이핑 중 API 호출 최소화
- **메모이제이션**: 불량 목록 렌더링 최적화

### 접근성 (A11y)
- **키보드 네비게이션**: ComboBox 전체 키보드 조작 지원
- **스크린 리더**: 적절한 ARIA 레이블 및 역할 명시
- **시각적 표시**: 포커스 및 선택 상태 명확한 시각적 피드백

### 데이터 무결성
- **입력 유효성**: 불량 유형 중복 방지, 수량 양수 검증
- **자동 저장**: 임시 저장 기능으로 데이터 손실 방지
- **충돌 해결**: 동시 편집 시 충돌 감지 및 해결

## 결론

본 설계는 사용자의 요구사항을 충족하면서도 확장 가능한 아키텍처를 제공합니다. 기존 시스템과의 호환성을 유지하면서 점진적 개선이 가능하도록 단계별 구현 계획을 수립했습니다.

핵심 가치는 **사용자 중심의 유연한 인터페이스**와 **데이터 기반의 효율적 입력 시스템**을 통해 생산성을 향상시키는 것입니다.